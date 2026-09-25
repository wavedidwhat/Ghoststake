package mirror

import (
	"math/big"
	"strings"
	"testing"
)

// The mirror signs a price that a market settles against, so every test here
// is about a way it could publish something wrong rather than fail.

func TestAdvancesOnlyOnAStrictlyNewerReading(t *testing.T) {
	cases := []struct {
		name       string
		updatedAt  uint64
		lastPushed uint64
		want       bool
	}{
		{"a newer print is published", 200, 100, true},
		{"the first print of all is published", 200, 0, true},
		// The ordinary case, not an edge one: the source publishes every few
		// minutes and this polls faster than that, so most ticks see the same
		// answer they saw last time. `DemoPriceFeed._push` reverts on a
		// timestamp that has not advanced, so without this every idle tick
		// would be a failed transaction and a log line.
		{"an unchanged feed is left alone", 100, 100, false},
		// A source that went backwards is a source in trouble. Republishing
		// would revert anyway; refusing here keeps the reason in our log.
		{"a print older than the last is refused", 50, 100, false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Advances(Reading{Answer: big.NewInt(1), UpdatedAt: c.updatedAt}, c.lastPushed)
			if got != c.want {
				t.Fatalf("Advances(updatedAt=%d, lastPushed=%d) = %v, want %v",
					c.updatedAt, c.lastPushed, got, c.want)
			}
		})
	}
}

// A scale mismatch is the one failure here that is silent on chain and
// catastrophic on screen: an answer is a bare integer, and nothing downstream
// can tell 374.92 at 1e8 from 37492.00 at 1e6. The error has to say how wrong
// it would have been, because "decimals differ" understates it.
func TestTheScaleMismatchErrorSaysHowWrongItWouldBe(t *testing.T) {
	if got := pow10(absDiff(8, 6)); got != 100 {
		t.Fatalf("a two-decimal gap is a factor of %d, want 100", got)
	}
	if got := pow10(absDiff(6, 8)); got != 100 {
		t.Fatalf("the gap must not depend on which side is larger, got %d", got)
	}
	if got := pow10(absDiff(18, 8)); got != 10_000_000_000 {
		t.Fatalf("a ten-decimal gap is a factor of %d, want 1e10", got)
	}
	if got := pow10(absDiff(8, 8)); got != 1 {
		t.Fatalf("no gap is a factor of %d, want 1", got)
	}
}

// The badge the app shows is driven by this exact substring. If the constant
// here and the app's ever drift apart, the mirror would happily publish onto a
// feed the app presents as a first-class one — a price we signed, looking like
// a price Chainlink secured.
func TestTheDemoMarkerMatchesWhatTheContractWrites(t *testing.T) {
	// `DemoPriceFeed`'s constructor builds:
	//   "GHOSTSTAKE DEMO FEED (operator-set price) - " + assetLabel
	const asConstructed = "GHOSTSTAKE DEMO FEED (operator-set price) - RHTSLA / USD (mirrored from Robinhood Chain mainnet)"

	if !strings.Contains(asConstructed, demoMarker) {
		t.Fatalf("a feed described %q would be refused by the mirror, but it is exactly what DemoPriceFeed writes", asConstructed)
	}

	// And the mirror must refuse anything without it.
	for _, bad := range []string{
		"RHTSLA / USD",
		"Robinhood TSLA / USD",
		"GHOSTSTAKE MIRROR - RHTSLA / USD",
	} {
		if strings.Contains(bad, demoMarker) {
			t.Fatalf("%q should not pass as an operator-set feed", bad)
		}
	}
}

func TestConfigIsRefusedRatherThanDefaulted(t *testing.T) {
	// Both of these would "work" if defaulted — a mirror with no pairs would
	// idle and a zero interval would spin — and both would look like a running
	// mirror to anyone reading the process list.
	if _, err := New(t.Context(), nil, nil, nil, Config{PollInterval: 0}); err == nil {
		t.Fatal("a mirror with no pairs started")
	}
	if _, err := New(t.Context(), nil, nil, nil, Config{
		Pairs:        []Pair{{}},
		PollInterval: 0,
	}); err == nil {
		t.Fatal("a mirror with a zero poll interval started")
	}
}
