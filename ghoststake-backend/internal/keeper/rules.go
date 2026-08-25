// Package keeper drives round phase transitions.
//
// Contracts do not run on a schedule. `ParimutuelRound` only moves when
// somebody sends it a transaction, so a four-phase round with nothing calling
// `openRound`, `lockRound` and `resolveRound` is a market where nothing ever
// happens. This is that somebody.
//
// # A convenience, not a privilege
//
// `lockRound`, `resolveRound` and `voidUnlockedRound` are permissionless by
// design, and this package does not change that. If the keeper dies, any user
// can advance their own round from the operator console (GHO-28) — the keeper
// is what makes that unnecessary, not what makes it possible. Only
// `openRound` and `voidUnsettledRound` are owner-gated, and the keeper simply
// declines to attempt them when it does not hold the owner key.
//
// # Chainlink Automation is the production answer
//
// A self-hosted keeper is a single point of failure with a hot key in it.
// Chainlink Automation is what this should be in production, and the reason
// it is not here is that the protocol is deliberately built so a keeper
// outage degrades liveness rather than safety — which is the property worth
// demonstrating.
//
// # This file
//
// The rules, as pure functions over a round and a clock. Every one of them is
// a restatement of a guard in `ParimutuelRound`, and a restatement that
// drifts is a keeper that spends gas on transactions that revert. Pure
// functions make the drift testable: `ActionFor` switching from Lock to
// VoidUnlocked exactly one second past `lockTime + lockWindow` is an
// assertion, not a hope.
//
// This is the same rule set the operator console holds in
// `src/lib/operator.ts`. Two implementations of one set of contract guards is
// a real cost, and the alternative — the console calling a keeper API — would
// make the browser's ability to unstick a round depend on the keeper being
// up, which is the exact coupling the permissionless design exists to avoid.
package keeper

import "math/big"

// Status is `ParimutuelRound.Status`, the stored state.
type Status uint8

const (
	StatusNone Status = iota
	StatusOpen
	StatusLocked
	StatusResolved
	StatusVoid
)

// Round mirrors `ParimutuelRound.Round`. Field names match the Solidity
// struct's, which is what `chain.Contract.CallInto` unpacks by.
type Round struct {
	OpenTime          uint64
	LockTime          uint64
	CloseTime         uint64
	Status            uint8
	Winner            uint8
	LockPrice         *big.Int
	ClosePrice        *big.Int
	LockOracleRoundId *big.Int
	UpPool            *big.Int
	DownPool          *big.Int
	RakeTaken         *big.Int
}

func (r Round) State() Status { return Status(r.Status) }

// Timing holds the market's three immutable windows.
type Timing struct {
	// EntryCutoff is how long before LockTime entry stops.
	EntryCutoff uint64
	// LockWindow is how late a lock may land before the round voids instead.
	LockWindow uint64
	// ResolveDeadline is how long a locked round may go unsettled before the
	// owner may unwind it.
	ResolveDeadline uint64
	// MinSidePool is the least a side may hold at lock for the round to be
	// valid. Not a window, but it decides what a lock will *do*.
	MinSidePool *big.Int
}

// Action is the one thing a round needs next.
type Action string

const (
	// ActionNone: waiting on the clock, or already settled.
	ActionNone Action = "none"
	ActionLock Action = "lock"
	// ActionResolve needs a feed round named alongside it; see FindCloseRound.
	ActionResolve Action = "resolve"
	// ActionVoidUnsettled is locked, past the resolve deadline: owner-only.
	ActionVoidUnsettled Action = "void-unsettled"
	// ActionVoidUnlocked is never locked, past the lock window: anyone may.
	ActionVoidUnlocked Action = "void-unlocked"
)

// OwnerOnly reports whether the contract gates this action on ownership.
//
// `voidUnsettledRound` is the only privileged action in the lifecycle, and
// the only one a keeper without the owner key has to skip rather than retry.
func OwnerOnly(a Action) bool { return a == ActionVoidUnsettled }

// ActionFor is the one action a round needs next, or none.
//
// Mirrors the contract's ordering:
//
//   - Open, before lockTime — nothing to do but wait.
//   - Open, past lockTime, inside the window — Lock. `lockRound` voids a thin
//     round itself, so this is still right when a side is short.
//   - Open, past lockTime+lockWindow — VoidUnlocked. `lockRound` would void
//     it too, but voiding says what it is doing.
//   - Locked, past closeTime — Resolve, whether or not a usable feed round
//     exists yet. Whether one does needs the chain, and is FindCloseRound's
//     question.
//   - Locked, past closeTime+resolveDeadline — VoidUnsettled. The deadline is
//     a permission to refund, not an instruction to: the keeper tries a
//     resolve first and only falls back to this when there is nothing to
//     settle against.
func ActionFor(r Round, t Timing, now uint64) Action {
	switch r.State() {
	case StatusOpen:
		if now < r.LockTime {
			return ActionNone
		}
		if now > r.LockTime+t.LockWindow {
			return ActionVoidUnlocked
		}
		return ActionLock
	case StatusLocked:
		if now < r.CloseTime {
			return ActionNone
		}
		if now > r.CloseTime+t.ResolveDeadline {
			return ActionVoidUnsettled
		}
		return ActionResolve
	default:
		return ActionNone
	}
}

// Thin reports whether locking this round will void it instead.
//
// Checked before the oracle in `lockRound`, so this is what actually happens
// to a one-sided round: it voids and everyone is refunded. Not a reason to
// skip the lock — the contract does the right thing — but it is the
// difference between a settled market and a refunded one, so the keeper says
// so in the log rather than reporting a successful lock that locked nothing.
func Thin(r Round, minSidePool *big.Int) bool {
	if minSidePool == nil || r.UpPool == nil || r.DownPool == nil {
		return false
	}
	return r.UpPool.Cmp(minSidePool) < 0 || r.DownPool.Cmp(minSidePool) < 0
}

// Schedule is the three absolute timestamps `openRound` takes.
type Schedule struct {
	OpenTime  uint64
	LockTime  uint64
	CloseTime uint64
}

// NextSchedule lays out a round from the windows an operator thinks in, plus
// the lead that makes it survive being signed.
//
// `openRound` rejects an `openTime` in the past, and the gap between
// simulating a transaction and mining it eats a short lead — a round opened
// with a ten-second lead has already failed by the time it lands on a public
// chain. So the lead is explicit and never zero.
func NextSchedule(now, lead, entryWindow, observation uint64) Schedule {
	open := now + lead
	lock := open + entryWindow
	return Schedule{OpenTime: open, LockTime: lock, CloseTime: lock + observation}
}

// ScheduleProblem returns why `openRound` would reject this schedule, or "".
//
// The contract reverts with `InvalidSchedule` for all three, which costs gas
// and says nothing about which rule was broken.
func ScheduleProblem(s Schedule, entryCutoff, now uint64) string {
	if s.OpenTime < now {
		return "open time is in the past"
	}
	if s.LockTime <= s.OpenTime+entryCutoff {
		return "entry window is not longer than the entry cutoff, so the round would open with entry already closed"
	}
	if s.CloseTime <= s.LockTime {
		return "observation window is not longer than zero"
	}
	return ""
}

// NeedsNewRound reports whether the market has nothing accepting entries.
//
// The issue's rule is that rounds overlap, so there is always one taking
// positions. The earliest moment that becomes false is not the lock — it is
// the entry cutoff, which closes entry on the clock alone while the round is
// still stored as Open. Waiting for the lock would leave a gap exactly
// `entryCutoff` long in which the market is live and unstakeable.
//
// `latest` is the highest-numbered round, or a zero Round when the market has
// never had one.
func NeedsNewRound(latest Round, entryCutoff, now uint64) bool {
	if latest.State() != StatusOpen {
		return true
	}
	// Written as an addition rather than `now >= LockTime-entryCutoff` so it
	// cannot underflow on a synthetic round with a small LockTime.
	return now+entryCutoff >= latest.LockTime
}
