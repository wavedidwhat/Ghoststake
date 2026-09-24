package keeper

import (
	"bytes"

	"github.com/ethereum/go-ethereum/crypto"
)

// What a deployment can do, asked of its bytecode.
//
// Contracts here are not upgradeable (GHO-52), so every change ships as a new
// address and several versions run side by side: the Sepolia markets predate
// GHO-79 and take three arguments to `openRound`, while anything deployed
// since takes a strike as well. One keeper drives both, and it has to know
// which it is talking to — calling the four-argument form on an old market
// reverts on every tick and the market silently stops opening rounds.

// strikeAtOpenSelector is `openRound(uint64,uint64,uint64,uint256)`.
var strikeAtOpenSelector = crypto.Keccak256([]byte("openRound(uint64,uint64,uint64,uint256)"))[:4]

// SupportsStrikeAtOpen reports whether this deployment's `openRound` takes a
// strike (GHO-79).
//
// Read from the dispatch table in the deployed bytecode rather than by
// simulating a call. A simulation would have to tell an unknown selector —
// which reverts with no data — from a real refusal like InvalidSchedule, and
// would need a plausible schedule and an owner to simulate as. The selector
// is simply present or absent.
//
// A false positive would mean sending a four-argument open to a contract that
// has no such function; it reverts, the keeper logs a failed open and retries
// on the next tick, which is the same handling as any other failed send. A
// false negative means opening rounds the old way on a market that could have
// stated its question — visible, and not a loss of funds.
func SupportsStrikeAtOpen(code []byte) bool {
	return bytes.Contains(code, strikeAtOpenSelector)
}
