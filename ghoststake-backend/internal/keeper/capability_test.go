package keeper

import (
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

// The live Sepolia markets predate GHO-79 and must keep being driven. This is
// the check that decides which call they get, so it is worth pinning against
// both shapes rather than trusting one string.
func TestSupportsStrikeAtOpenReadsTheDispatchTable(t *testing.T) {
	old := crypto.Keccak256([]byte("openRound(uint64,uint64,uint64)"))[:4]
	newer := crypto.Keccak256([]byte("openRound(uint64,uint64,uint64,uint256)"))[:4]

	// A dispatch table is selectors embedded in bytecode, so this is the
	// shape being matched: the selector sitting among other code.
	preGHO79 := append([]byte{0x60, 0x80, 0x60, 0x40}, old...)
	postGHO79 := append(append([]byte{0x60, 0x80}, old...), newer...)

	if SupportsStrikeAtOpen(preGHO79) {
		t.Error("a pre-GHO-79 market was read as taking a strike; it would be sent a call it cannot answer")
	}
	if !SupportsStrikeAtOpen(postGHO79) {
		t.Error("a market that takes a strike was read as not taking one; its rounds would never state a question")
	}
	if SupportsStrikeAtOpen(nil) {
		t.Error("an address with no code answered yes")
	}
}
