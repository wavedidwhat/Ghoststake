package keeper_test

import (
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/keeper"
)

// The market the tests drive: entry stops 30s before lock, a lock may land up
// to 60s late, and a locked round may go 1h unsettled before it can be
// refunded. Round numbers, so an assertion reads as the rule it is checking.
var timing = keeper.Timing{
	EntryCutoff:     30,
	LockWindow:      60,
	ResolveDeadline: 3600,
	MinSidePool:     usdc(100),
}

const (
	openTime  = 1_000_000
	lockTime  = openTime + 300
	closeTime = lockTime + 300
)

func openRound() keeper.Round {
	return keeper.Round{
		OpenTime:  openTime,
		LockTime:  lockTime,
		CloseTime: closeTime,
		Status:    uint8(keeper.StatusOpen),
		UpPool:    usdc(1_000),
		DownPool:  usdc(1_000),
	}
}

func lockedRound() keeper.Round {
	r := openRound()
	r.Status = uint8(keeper.StatusLocked)
	return r
}

// Nothing to do until the clock reaches lockTime — including through the
// entry cutoff, which closes entry without needing anybody to send anything.
func TestNothingToDoBeforeLockTime(t *testing.T) {
	for _, now := range []uint64{openTime, lockTime - 31, lockTime - 1} {
		if got := keeper.ActionFor(openRound(), timing, now); got != keeper.ActionNone {
			t.Fatalf("at %d: got %q, want none", now, got)
		}
	}
}

// The boundary that decides whether a round settles or refunds. One second
// past `lockTime + lockWindow` the lock is no longer possible, and the keeper
// has to stop offering it.
func TestLockBecomesVoidExactlyPastTheWindow(t *testing.T) {
	cases := []struct {
		now  uint64
		want keeper.Action
	}{
		{lockTime, keeper.ActionLock},
		{lockTime + timing.LockWindow, keeper.ActionLock},
		{lockTime + timing.LockWindow + 1, keeper.ActionVoidUnlocked},
	}
	for _, c := range cases {
		if got := keeper.ActionFor(openRound(), timing, c.now); got != c.want {
			t.Fatalf("at lockTime+%d: got %q, want %q", c.now-lockTime, got, c.want)
		}
	}
}

// The same boundary on the settlement side. Note that the keeper still tries
// a resolve past the deadline — the deadline is a permission to refund, not
// an instruction to — but the action it names changes, because past it there
// is a fallback that did not exist before.
func TestResolveBecomesVoidExactlyPastTheDeadline(t *testing.T) {
	cases := []struct {
		now  uint64
		want keeper.Action
	}{
		{closeTime - 1, keeper.ActionNone},
		{closeTime, keeper.ActionResolve},
		{closeTime + timing.ResolveDeadline, keeper.ActionResolve},
		{closeTime + timing.ResolveDeadline + 1, keeper.ActionVoidUnsettled},
	}
	for _, c := range cases {
		if got := keeper.ActionFor(lockedRound(), timing, c.now); got != c.want {
			t.Fatalf("at %d: got %q, want %q", c.now, got, c.want)
		}
	}
}

// Settled is terminal. A resolved or voided round must never produce an
// action, whatever the clock says, or the keeper spends gas reverting on it
// forever.
func TestSettledRoundsNeedNothing(t *testing.T) {
	for _, status := range []keeper.Status{keeper.StatusNone, keeper.StatusResolved, keeper.StatusVoid} {
		r := openRound()
		r.Status = uint8(status)
		if got := keeper.ActionFor(r, timing, closeTime+999_999); got != keeper.ActionNone {
			t.Fatalf("status %d: got %q, want none", status, got)
		}
	}
}

// `voidUnsettledRound` is the only privileged action in the lifecycle. If
// this test ever fails the keeper has started declining something anyone can
// do, which is the centralisation the design exists to avoid.
func TestOnlyTheUnsettledVoidIsOwnerGated(t *testing.T) {
	for _, a := range []keeper.Action{keeper.ActionLock, keeper.ActionResolve, keeper.ActionVoidUnlocked} {
		if keeper.OwnerOnly(a) {
			t.Fatalf("%q must stay permissionless", a)
		}
	}
	if !keeper.OwnerOnly(keeper.ActionVoidUnsettled) {
		t.Fatal("void-unsettled is owner-gated in the contract")
	}
}

// A thin round is still locked, not skipped: `lockRound` voids it itself, and
// via the permissionless path rather than the owner-only one. What the keeper
// owes is a log line saying the lock will refund rather than settle.
func TestThinRoundsAreStillLocked(t *testing.T) {
	thin := openRound()
	thin.DownPool = usdc(99)

	if got := keeper.ActionFor(thin, timing, lockTime); got != keeper.ActionLock {
		t.Fatalf("got %q, want lock", got)
	}
	if !keeper.Thin(thin, timing.MinSidePool) {
		t.Fatal("a side under the floor is thin")
	}
	if keeper.Thin(openRound(), timing.MinSidePool) {
		t.Fatal("both sides at 1,000 are over a floor of 100")
	}
}

// The overlap rule. Entry closes at the cutoff, not at the lock, so the next
// round has to be opened a cutoff early — otherwise there is a window exactly
// `entryCutoff` long where the market is live and nothing accepts a position.
func TestTheNextRoundOpensAtTheEntryCutoffNotTheLock(t *testing.T) {
	current := openRound()

	if keeper.NeedsNewRound(current, timing.EntryCutoff, lockTime-timing.EntryCutoff-1) {
		t.Fatal("entry is still open a second before the cutoff")
	}
	if !keeper.NeedsNewRound(current, timing.EntryCutoff, lockTime-timing.EntryCutoff) {
		t.Fatal("entry closes at the cutoff, so the next round is due")
	}

	// A market that has never run one.
	if !keeper.NeedsNewRound(keeper.Round{}, timing.EntryCutoff, openTime) {
		t.Fatal("a market with no rounds needs one")
	}
	// And one whose latest is settled.
	settled := openRound()
	settled.Status = uint8(keeper.StatusResolved)
	if !keeper.NeedsNewRound(settled, timing.EntryCutoff, openTime) {
		t.Fatal("a settled latest round accepts nothing")
	}
}

// The three ways `openRound` reverts with InvalidSchedule, checked before the
// gas is spent rather than after.
func TestScheduleProblemsMatchTheContractsGuards(t *testing.T) {
	now := uint64(1_000_000)
	good := keeper.NextSchedule(now, 45, 300, 300)
	if problem := keeper.ScheduleProblem(good, timing.EntryCutoff, now); problem != "" {
		t.Fatalf("a 45s lead with a 5m entry window is fine, got %q", problem)
	}
	if good.OpenTime != now+45 || good.LockTime != now+345 || good.CloseTime != now+645 {
		t.Fatalf("schedule laid out wrong: %+v", good)
	}

	past := keeper.Schedule{OpenTime: now - 1, LockTime: now + 300, CloseTime: now + 600}
	if keeper.ScheduleProblem(past, timing.EntryCutoff, now) == "" {
		t.Fatal("an openTime in the past is rejected by the contract")
	}

	// Entry window equal to the cutoff: the round would open with entry
	// already closed, which is the trap the contract's `<=` is guarding.
	tight := keeper.NextSchedule(now, 45, timing.EntryCutoff, 300)
	if keeper.ScheduleProblem(tight, timing.EntryCutoff, now) == "" {
		t.Fatal("an entry window equal to the cutoff is rejected")
	}

	noObservation := keeper.NextSchedule(now, 45, 300, 0)
	if keeper.ScheduleProblem(noObservation, timing.EntryCutoff, now) == "" {
		t.Fatal("a zero observation window is rejected")
	}
}

func usdc(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), big.NewInt(1_000_000))
}

// A 5-minute market runs a round every five minutes: half of it taking
// positions, half of it watching the price. The horizon is the whole round,
// which is what makes the cadence match the number an operator listed.
func TestAHorizonSplitsInHalfByDefault(t *testing.T) {
	entry, observation, err := keeper.SplitHorizon(300, 0, timing.EntryCutoff)
	if err != nil {
		t.Fatal(err)
	}
	if entry != 150 || observation != 150 {
		t.Fatalf("got entry=%d observation=%d, want 150/150", entry, observation)
	}

	// An explicit entry window takes the rest as observation, so the round is
	// still exactly one horizon long.
	entry, observation, err = keeper.SplitHorizon(3600, 600, timing.EntryCutoff)
	if err != nil {
		t.Fatal(err)
	}
	if entry != 600 || observation != 3000 {
		t.Fatalf("got entry=%d observation=%d, want 600/3000", entry, observation)
	}
}

// Refused rather than clamped. Both of these produce a round the contract
// would reject or a market running at a cadence nobody asked for, and the
// keeper says so at startup rather than at the first open.
func TestAnUnworkableHorizonIsRefused(t *testing.T) {
	// A horizon so short that half of it does not outlast the entry cutoff.
	if _, _, err := keeper.SplitHorizon(60, 0, timing.EntryCutoff); err == nil {
		t.Fatal("a 30s entry window inside a 30s cutoff must be refused")
	}
	// An entry window that swallows the whole round.
	if _, _, err := keeper.SplitHorizon(300, 300, timing.EntryCutoff); err == nil {
		t.Fatal("an entry window equal to the horizon leaves no observation")
	}
}
