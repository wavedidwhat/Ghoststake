package keeper

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"

	"forge.wavedidwhat.com/wave/ghoststake/internal/abis"
)

// The keeper claims to drive two shapes of market (see SupportsStrikeAtOpen).
// These assert it can actually build the call for both.
//
// On 2026-09-25 it could not. GHO-79 changed `openRound` in place and
// `make gen-abis` replaced the only copy of its ABI, so the pre-GHO-79 branch
// went on choosing a three-argument call that no longer had three arguments
// to pack into. Nothing failed at build time — the shape is chosen at runtime
// from a deployed contract's bytecode, and the arguments are packed by name
// against a document read from disk — so the first sign of it was the live
// keeper logging `argument count mismatch: got 3 for 4` every twenty seconds
// for four hours while rounds stopped opening and staked rounds voided.
//
// The lesson is not about `openRound`: any branch that picks a call shape at
// runtime can lose the ABI its other branch needs, and neither the compiler
// nor a test of the branch itself will say so. Each shape the keeper can
// choose needs one test that packs it.

// openRoundShapes is every form of the call the keeper may send, keyed by what
// Market.StrikeAtOpen has to be for it to be chosen.
var openRoundShapes = []struct {
	name         string
	strikeAtOpen bool
	abi          string
	signature    string
	args         []any
}{
	{
		name:         "pre-GHO-79, three timestamps",
		strikeAtOpen: false,
		abi:          abis.ParimutuelRoundPreStrike,
		signature:    "openRound(uint64,uint64,uint64)",
		args:         []any{uint64(100), uint64(200), uint64(300)},
	},
	{
		name:         "GHO-79 onwards, with a strike",
		strikeAtOpen: true,
		abi:          abis.ParimutuelRound,
		signature:    "openRound(uint64,uint64,uint64,uint256)",
		args:         []any{uint64(100), uint64(200), uint64(300), big.NewInt(4000e8)},
	},
}

func TestBothOpenRoundShapesPack(t *testing.T) {
	for _, s := range openRoundShapes {
		t.Run(s.name, func(t *testing.T) {
			parsed, err := abis.Load(s.abi)
			if err != nil {
				t.Fatalf("load %s: %v", s.abi, err)
			}
			packed, err := parsed.Pack("openRound", s.args...)
			if err != nil {
				t.Fatalf("pack openRound against %s: %v", s.abi, err)
			}
			if len(packed) < 4 {
				t.Fatalf("packed call is %d bytes, too short to hold a selector", len(packed))
			}
		})
	}
}

// The hand-written ABI is checked against a selector computed from the
// signature, because it is the one file here that no artifact backs. A typo in
// it would otherwise produce a call that a market answers to by accident or
// not at all, and only on chain.
func TestOpenRoundSelectorsMatchTheirSignatures(t *testing.T) {
	for _, s := range openRoundShapes {
		t.Run(s.name, func(t *testing.T) {
			parsed, err := abis.Load(s.abi)
			if err != nil {
				t.Fatalf("load %s: %v", s.abi, err)
			}
			method, ok := parsed.Methods["openRound"]
			if !ok {
				t.Fatalf("%s has no openRound", s.abi)
			}
			want := crypto.Keccak256([]byte(s.signature))[:4]
			if got := method.ID; string(got) != string(want) {
				t.Fatalf("%s openRound selector is %x, but %s hashes to %x",
					s.abi, got, s.signature, want)
			}
		})
	}
}

// The probe and the ABI have to agree about which signature means "takes a
// strike". They are two hand-written copies of the same string in different
// packages, and a market is routed by one and packed by the other.
func TestTheStrikeProbeMatchesTheAbiItRoutesTo(t *testing.T) {
	strike := abis.MustLoad(abis.ParimutuelRound).Methods["openRound"]
	if string(strikeAtOpenSelector) != string(strike.ID) {
		t.Fatalf("SupportsStrikeAtOpen looks for %x but ParimutuelRound.openRound is %x",
			strikeAtOpenSelector, strike.ID)
	}
	preStrike := abis.MustLoad(abis.ParimutuelRoundPreStrike).Methods["openRound"]
	if string(strikeAtOpenSelector) == string(preStrike.ID) {
		t.Fatal("the two openRound shapes have the same selector, so the probe cannot tell them apart")
	}
}
