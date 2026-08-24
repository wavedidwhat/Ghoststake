package finance

import "math/big"

// Phase is a round as an observer sees it, which is not the same as the
// status the contract stores.
//
//	ParimutuelRound.phaseOf
//
// Two of these are functions of the clock rather than of storage: an OPEN
// round becomes CUTOFF the moment entry closes, without anything being
// written, and a LOCKED round sits in OBSERVATION until someone resolves it.
// Deriving them from stored status alone would show a stake button that is
// already dead, which is the bug GHO-18 fixed in the frontend.
type Phase string

const (
	PhaseOpen        Phase = "open"
	PhaseCutoff      Phase = "cutoff"
	PhaseObservation Phase = "observation"
	PhaseResolved    Phase = "resolved"
	PhaseVoid        Phase = "void"
)

// Stored statuses, as the projection records them.
const (
	StatusOpen     = "open"
	StatusLocked   = "locked"
	StatusResolved = "resolved"
	StatusVoid     = "void"
)

// PhaseOf derives the observable phase.
//
//	if resolved      -> Resolved
//	if void          -> Void
//	if locked        -> Observation
//	else             -> entry open ? Open : Cutoff
//
// `entryCutoff` is the contract's immutable: entry stops that many seconds
// before lockTime, so a pending lock transaction cannot be front-run by
// someone who can see it in the mempool.
func PhaseOf(status string, openTime, lockTime, entryCutoff, nowUnix int64) Phase {
	switch status {
	case StatusResolved:
		return PhaseResolved
	case StatusVoid:
		return PhaseVoid
	case StatusLocked:
		return PhaseObservation
	}
	if EntryIsOpen(status, openTime, lockTime, entryCutoff, nowUnix) {
		return PhaseOpen
	}
	return PhaseCutoff
}

// EntryIsOpen is whether a position can be taken right now.
//
//	ParimutuelRound.entryIsOpen:
//	  status == Open && now >= openTime && now < lockTime - entryCutoff
//
// Strictly less than the cutoff, matching the contract. An off-by-one in the
// permissive direction is a button that submits a transaction the contract
// will revert.
func EntryIsOpen(status string, openTime, lockTime, entryCutoff, nowUnix int64) bool {
	if status != StatusOpen {
		return false
	}
	return nowUnix >= openTime && nowUnix < lockTime-entryCutoff
}

// Odds is what one unit staked on a side returns if that side wins, WAD.
// 2e18 means "doubles your money".
//
//	ParimutuelRound.oddsOf:
//	  pool = up + down
//	  mulDiv(pool - mulDiv(pool, rake, WAD), WAD, sidePool)
//
// Provisional until lock: every subsequent entry on either side moves it. An
// empty side returns zero, which is not an infinite multiple but an undefined
// one — a side with nothing in it cannot win, because the minimum-side floor
// voids the round at lock.
func Odds(sidePool, upPool, downPool, rake *big.Int) *big.Int {
	if sidePool == nil || sidePool.Sign() == 0 {
		return new(big.Int)
	}
	pool := new(big.Int).Add(or0(upPool), or0(downPool))
	net := new(big.Int).Sub(pool, MulDiv(pool, or0(rake), WAD))
	return MulDiv(net, WAD, sidePool)
}

// Position is one user's stake in one round.
type Position struct {
	UpStake   *big.Int
	DownStake *big.Int
	// Claimed is whether the payout or refund has already been collected.
	Claimed bool
	// Leveraged is whether the stake was funded by borrowing: the router
	// opened the position, so the payout routes back through it to repay the
	// debt before anything reaches the user.
	Leveraged bool
}

// Claimable is what a user can collect from a round right now.
//
//	ParimutuelRound.claimableOf:
//	  if claimed            -> 0
//	  if void               -> up + down            (full refund, no rake)
//	  if not resolved       -> 0
//	  stake on winner == 0  -> 0
//	  else mulDiv(totalPool - rakeTaken, stake, winningPool)
//
// The floor division is the contract's, and so is its consequence: the sum of
// all payouts can fall a few wei short of the distributable pool. That dust
// stays in the contract rather than going to the last claimant, because a
// payout that depends on claim order is a payout people would race for.
//
// A void refunds the whole stake on both sides with no rake taken. That is why
// `rakeTaken` is always zero on a voided round — the protocol does not charge
// for a market that did not happen.
func Claimable(pos Position, status, winner string, upPool, downPool, rakeTaken *big.Int) *big.Int {
	if pos.Claimed {
		return new(big.Int)
	}
	if status == StatusVoid {
		return new(big.Int).Add(or0(pos.UpStake), or0(pos.DownStake))
	}
	if status != StatusResolved {
		return new(big.Int)
	}

	stake, winningPool := or0(pos.DownStake), or0(downPool)
	if winner == "up" {
		stake, winningPool = or0(pos.UpStake), or0(upPool)
	}
	if stake.Sign() == 0 || winningPool.Sign() == 0 {
		return new(big.Int)
	}

	total := new(big.Int).Add(or0(upPool), or0(downPool))
	distributable := new(big.Int).Sub(total, or0(rakeTaken))
	return MulDiv(distributable, stake, winningPool)
}
