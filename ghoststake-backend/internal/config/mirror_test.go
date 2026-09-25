package config

import "testing"

// MIRROR_PAIRS is two addresses per entry, and `common.HexToAddress` does not
// fail — it pads or truncates whatever it is handed. So a typo here becomes a
// valid-looking address with no code, every read off it returns zero, and a
// mirror would publish that zero as a price onto a feed a market settles
// against. Each of these is that failure, caught at the door.

func TestMirrorPairsAreParsed(t *testing.T) {
	pairs, err := parseMirrorPairs(
		"0x4A1166a659A55625345e9515b32adECea5547C38:0x694AA1769357215DE4FAC081bf1f309aDC325306, " +
			"0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15:0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9")
	if err != nil {
		t.Fatalf("well-formed pairs were refused: %v", err)
	}
	if len(pairs) != 2 {
		t.Fatalf("parsed %d pairs, want 2", len(pairs))
	}
	if pairs[0].Source.Hex() != "0x4A1166a659A55625345e9515b32adECea5547C38" {
		t.Fatalf("source is %s", pairs[0].Source.Hex())
	}
	// Kept verbatim so an error names what was typed, not a normalised form.
	if pairs[0].Raw == "" {
		t.Fatal("the entry as written was not kept")
	}
}

func TestMirrorPairsRefuseWhatWouldSilentlyBecomeZero(t *testing.T) {
	cases := map[string]string{
		"no separator":          "0x4A1166a659A55625345e9515b32adECea5547C38",
		"source too short":      "0x4A1166a659A55625345e9515b32adECea55:0x694AA1769357215DE4FAC081bf1f309aDC325306",
		"destination too short": "0x4A1166a659A55625345e9515b32adECea5547C38:0x694AA17693572",
		"source not hex":        "not-an-address:0x694AA1769357215DE4FAC081bf1f309aDC325306",
		"empty destination":     "0x4A1166a659A55625345e9515b32adECea5547C38:",
		// Would read a price and publish it back onto itself.
		"mirrored onto itself": "0x4A1166a659A55625345e9515b32adECea5547C38:0x4a1166a659a55625345e9515b32adecea5547c38",
	}

	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseMirrorPairs(raw); err == nil {
				t.Fatalf("%q was accepted", raw)
			}
		})
	}
}

func TestMirrorPairsIgnoreEmptyEntries(t *testing.T) {
	// Trailing commas and blank lines in a compose file are ordinary, and
	// failing on one would be a deploy that stops for punctuation.
	pairs, err := parseMirrorPairs("0x4A1166a659A55625345e9515b32adECea5547C38:0x694AA1769357215DE4FAC081bf1f309aDC325306, ,")
	if err != nil {
		t.Fatalf("a trailing comma was refused: %v", err)
	}
	if len(pairs) != 1 {
		t.Fatalf("parsed %d pairs, want 1", len(pairs))
	}
}
