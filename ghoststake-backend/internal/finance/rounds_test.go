package finance_test

import (
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/finance"
)

// A worked parimutuel payout.
//
//	up 6,000, down 4,000, total 10,000, rake 2% = 200
//	Up wins, so 9,800 is shared among the 6,000 staked on Up.
//	A 600 stake — a tenth of the winning side — takes 980.
//
// Note what a parimutuel is: you are not paid odds fixed when you bet, you
// take a share of the whole pot proportional to your share of the winning
// side. Everyone on the losing side funds it.
func TestPayoutIsAShareOfTheWholePot(t *testing.T) {
	up, down := usdc(6_000), usdc(4_000)
	rakeTaken := usdc(200)

	got := finance.Claimable(
		finance.Position{UpStake: usdc(600), DownStake: new(big.Int)},
		finance.StatusResolved, "up", up, down, rakeTaken,
	)
	eq(t, got, usdc(980), "payout for a tenth of the winning side")

	// The losing side takes nothing, however large.
	loser := finance.Claimable(
		finance.Position{UpStake: new(big.Int), DownStake: usdc(4_000)},
		finance.StatusResolved, "up", up, down, rakeTaken,
	)
	eq(t, loser, new(big.Int), "the losing side")
}

// Every winning payout together must not exceed what is distributable. Floor
// division means the sum can fall a few wei short, and that dust stays in the
// contract — a payout that depended on claim order is one people would race.
func TestPayoutsNeverExceedThePot(t *testing.T) {
	// Three stakes that do not divide evenly into the winning side.
	up, down := big.NewInt(1_000_003), usdc(1)
	rakeTaken := big.NewInt(7)
	total := new(big.Int).Add(up, down)
	distributable := new(big.Int).Sub(total, rakeTaken)

	stakes := []*big.Int{big.NewInt(333_334), big.NewInt(333_334), big.NewInt(333_335)}
	sum := new(big.Int)
	for _, stake := range stakes {
		sum.Add(sum, finance.Claimable(
			finance.Position{UpStake: stake, DownStake: new(big.Int)},
			finance.StatusResolved, "up", up, down, rakeTaken,
		))
	}

	if sum.Cmp(distributable) > 0 {
		t.Fatalf("payouts %s exceed the distributable pool %s", sum, distributable)
	}
	// And the shortfall is dust — bounded by one wei per claimant.
	if short := new(big.Int).Sub(distributable, sum); short.Cmp(big.NewInt(int64(len(stakes)))) > 0 {
		t.Fatalf("payouts fell %s short, want at most %d", short, len(stakes))
	}
}

// A void refunds both sides in full and charges no rake: the protocol does
// not take a fee for a market that did not happen.
func TestAVoidRefundsBothSidesInFull(t *testing.T) {
	got := finance.Claimable(
		finance.Position{UpStake: usdc(300), DownStake: usdc(200)},
		finance.StatusVoid, "", usdc(6_000), usdc(4_000), new(big.Int),
	)
	eq(t, got, usdc(500), "refund")
}

func TestNothingIsClaimableBeforeResolutionOrAfterClaiming(t *testing.T) {
	position := finance.Position{UpStake: usdc(600), DownStake: new(big.Int)}
	up, down, rake := usdc(6_000), usdc(4_000), usdc(200)

	for _, status := range []string{finance.StatusOpen, finance.StatusLocked} {
		got := finance.Claimable(position, status, "up", up, down, rake)
		eq(t, got, new(big.Int), "claimable while "+status)
	}

	claimed := position
	claimed.Claimed = true
	eq(t, finance.Claimable(claimed, finance.StatusResolved, "up", up, down, rake),
		new(big.Int), "claimable after claiming")
}

// Odds: what one unit on a side returns if that side wins.
//
//	up 6,000, down 4,000, rake 2%
//	  net pot 9,800; Up's 6,000 shares it, so 9,800/6,000 = 1.633x
//	  Down's 4,000 would share it, so 9,800/4,000 = 2.45x
//
// The unpopular side pays more. That is the entire mechanism.
func TestOddsFavourTheUnpopularSide(t *testing.T) {
	up, down := usdc(6_000), usdc(4_000)
	rake := finance.MulDiv(finance.WAD, big.NewInt(2), big.NewInt(100))

	upOdds := finance.Odds(up, up, down, rake)
	downOdds := finance.Odds(down, up, down, rake)

	if upOdds.Cmp(downOdds) >= 0 {
		t.Fatalf("the crowded side pays at least as well: up %s, down %s", upOdds, downOdds)
	}
	// 1.6333… x
	eq(t, upOdds, finance.MulDiv(usdc(9_800), finance.WAD, up), "up odds")
	// 2.45x
	eq(t, downOdds, finance.MulDiv(finance.WAD, big.NewInt(245), big.NewInt(100)), "down odds")
}

// An empty side has undefined odds, not infinite ones: it cannot win, because
// the minimum-side floor voids the round at lock.
func TestAnEmptySideHasNoOdds(t *testing.T) {
	eq(t, finance.Odds(new(big.Int), new(big.Int), usdc(4_000), new(big.Int)), new(big.Int), "empty side")
}

// Phases the clock decides, not storage. Entry closes at the cutoff, which is
// before the lock — so a stake button that watched lockTime would keep
// offering a transaction the contract reverts.
func TestEntryClosesAtTheCutoffNotAtTheLock(t *testing.T) {
	const open, lock, cutoff = 1_000, 2_000, 15

	for _, tc := range []struct {
		now       int64
		phase     finance.Phase
		entryOpen bool
	}{
		{now: 999, phase: finance.PhaseCutoff},                  // not open yet
		{now: 1_000, phase: finance.PhaseOpen, entryOpen: true}, // opens exactly on time
		{now: 1_984, phase: finance.PhaseOpen, entryOpen: true}, // last second of entry
		{now: 1_985, phase: finance.PhaseCutoff},                // cutoff, 15s before lock
		{now: 1_999, phase: finance.PhaseCutoff},                // still cutoff, not yet locked
	} {
		if got := finance.PhaseOf(finance.StatusOpen, open, lock, cutoff, tc.now); got != tc.phase {
			t.Errorf("t=%d: phase %q, want %q", tc.now, got, tc.phase)
		}
		if got := finance.EntryIsOpen(finance.StatusOpen, open, lock, cutoff, tc.now); got != tc.entryOpen {
			t.Errorf("t=%d: entryOpen %v, want %v", tc.now, got, tc.entryOpen)
		}
	}
}

// A locked round is in observation until someone resolves it — the phase is
// not "resolved" merely because the close time has passed.
func TestALockedRoundObservesUntilResolved(t *testing.T) {
	const open, lock, cutoff = 1_000, 2_000, 15
	far := int64(9_999_999)

	if got := finance.PhaseOf(finance.StatusLocked, open, lock, cutoff, far); got != finance.PhaseObservation {
		t.Fatalf("phase %q, want observation", got)
	}
	if finance.EntryIsOpen(finance.StatusLocked, open, lock, cutoff, 1_500) {
		t.Fatal("entry was open on a locked round")
	}
	if got := finance.PhaseOf(finance.StatusVoid, open, lock, cutoff, far); got != finance.PhaseVoid {
		t.Fatalf("phase %q, want void", got)
	}
}
