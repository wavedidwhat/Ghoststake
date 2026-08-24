package finance_test

import (
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/finance"
)

// The stake asset is a six-decimal token (mUSDC), so 1_000000 is one unit.
// Written out here because "10_000000000" is unreadable as a balance and
// every figure below is easier to check against a calculator this way.
func usdc(units int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(units), big.NewInt(1_000_000))
}

// wad turns a percentage into the contracts' WAD scale: pct(80) is 0.8e18.
func pct(p int64) *big.Int {
	return finance.MulDiv(finance.WAD, big.NewInt(p), big.NewInt(100))
}

func eq(t *testing.T, got, want *big.Int, what string) {
	t.Helper()
	if got == nil || want == nil {
		if got != want {
			t.Fatalf("%s: got %v, want %v", what, got, want)
		}
		return
	}
	if got.Cmp(want) != 0 {
		t.Fatalf("%s: got %s, want %s", what, got, want)
	}
}

// A worked example, end to end.
//
//	10,000 deposited, earning 5%/year, for 73 days (a fifth of a year)
//	  accrued  = 10,000 x 0.05 x (73/365) = 100
//	  ledger   = 10,000 + 100 = 10,100
//	  shares   = 10,050  (the vault cannot pay the full 100 of unfunded yield)
//	  collateral = min(10,100, 10,050) = 10,050
//
// That cap is the whole safety property: the last 50 of ledger value is a
// claim on assets the vault does not hold, and lending against it would be
// lending against nothing.
func TestCollateralIsCappedAtWhatTheSharesAreWorth(t *testing.T) {
	const day = int64(24 * 60 * 60)
	const year = 365 * day

	// 5% a year as a per-second WAD rate.
	rate := new(big.Int).Div(pct(5), big.NewInt(year))

	state := finance.VaultState{
		Principal:     usdc(10_000),
		RatePerSecond: rate,
		StartTime:     0,
		SharesValue:   usdc(10_050),
	}
	now := 73 * day

	accrued := finance.AccruedYield(state, now)
	// Not exactly 100: the per-second rate truncates when it is derived, and
	// the contract does the same truncation. Within a cent is the assertion
	// that matters — an exact figure here would be asserting the rounding of
	// the test's own arithmetic.
	if diff := new(big.Int).Sub(accrued, usdc(100)); diff.CmpAbs(big.NewInt(10_000)) > 0 {
		t.Fatalf("accrued yield %s, want about %s", accrued, usdc(100))
	}

	ledger := finance.TotalLedgerValue(state, now)
	eq(t, ledger, new(big.Int).Add(usdc(10_000), accrued), "ledger value")

	collateral := finance.CollateralValue(state, now)
	eq(t, collateral, usdc(10_050), "collateral is capped at the share value")
}

// Yield is simple, not compound: settling more often must not earn more.
//
// This is the property the contract is built around — `settle()` is free and
// permissionless, so if yield compounded on settlement anyone could grind
// value out of the vault by calling it in a loop.
func TestYieldDoesNotCompoundOnSettlement(t *testing.T) {
	rate := big.NewInt(1_000_000_000) // per-second WAD
	state := finance.VaultState{Principal: usdc(1_000), RatePerSecond: rate}

	whole := finance.AccruedYield(state, 1000)

	// The same thousand seconds, settled at the halfway point: the first half
	// banks into settledYield (which does not itself earn) and the checkpoint
	// moves.
	first := finance.AccruedYield(state, 500)
	settled := finance.VaultState{
		Principal:     state.Principal,
		RatePerSecond: rate,
		StartTime:     500,
		SettledYield:  first,
	}
	second := finance.AccruedYield(settled, 1000)

	eq(t, new(big.Int).Add(first, second), whole, "split accrual")
}

// A tiny principal must still accrue. This is the ordering trap the contract
// calls out: dividing by WAD before scaling by elapsed truncates the
// per-second yield to zero and destroys small positions' accrual entirely.
func TestSmallPrincipalsStillAccrue(t *testing.T) {
	state := finance.VaultState{
		Principal:     big.NewInt(1_000_000), // one whole token
		RatePerSecond: big.NewInt(1_000_000_000),
	}
	// One second of yield would round to zero if the division came first.
	if got := finance.AccruedYield(state, 100_000); got.Sign() == 0 {
		t.Fatal("a small principal accrued nothing over 100,000 seconds")
	}
}

// A worked example of the health factor.
//
//	collateral 10,000, liquidation threshold 85%, debt 5,000
//	  hf = 10,000 x 0.85 / 5,000 = 1.7
//
// Above 1.0, so safe; and above 1.5, so the band is "safe" too.
func TestHealthFactorWorkedExample(t *testing.T) {
	hf, hasDebt := finance.HealthFactor(usdc(10_000), pct(85), usdc(5_000))
	if !hasDebt {
		t.Fatal("a position with debt reported none")
	}
	eq(t, hf, new(big.Int).Div(new(big.Int).Mul(finance.WAD, big.NewInt(17)), big.NewInt(10)), "health factor")

	if finance.Liquidatable(hf, hasDebt) {
		t.Fatal("1.7 reported liquidatable")
	}
	if got := finance.BandOf(hf, hasDebt); got != finance.BandSafe {
		t.Fatalf("band %q, want safe", got)
	}
}

// Debt rising until the position crosses the line, with the band warning
// before the contract acts.
func TestBandsWarnBeforeLiquidation(t *testing.T) {
	collateral, threshold := usdc(10_000), pct(85)

	for _, tc := range []struct {
		debt         int64
		band         finance.Band
		liquidatable bool
	}{
		// hf = 8,500 / debt
		{debt: 5_000, band: finance.BandSafe},                       // 1.70
		{debt: 6_000, band: finance.BandCaution},                    // 1.42
		{debt: 7_500, band: finance.BandDanger},                     // 1.13
		{debt: 8_500, band: finance.BandDanger},                     // 1.00 — on the line, not over it
		{debt: 9_000, band: finance.BandDanger, liquidatable: true}, // 0.94
	} {
		hf, hasDebt := finance.HealthFactor(collateral, threshold, usdc(tc.debt))
		if got := finance.BandOf(hf, hasDebt); got != tc.band {
			t.Errorf("debt %d: band %q, want %q (hf %s)", tc.debt, got, tc.band, hf)
		}
		if got := finance.Liquidatable(hf, hasDebt); got != tc.liquidatable {
			t.Errorf("debt %d: liquidatable %v, want %v (hf %s)", tc.debt, got, tc.liquidatable, hf)
		}
	}
}

// Exactly 1.0 is not liquidatable. The contract's test is `hf < WAD`, and an
// off-by-one in the other direction would let someone liquidate a position
// that is precisely on the line.
func TestExactlyOneIsNotLiquidatable(t *testing.T) {
	// collateral x threshold == debt, so hf is exactly WAD.
	hf, hasDebt := finance.HealthFactor(usdc(10_000), pct(50), usdc(5_000))
	eq(t, hf, finance.WAD, "health factor")
	if finance.Liquidatable(hf, hasDebt) {
		t.Fatal("a position at exactly 1.0 was reported liquidatable")
	}
}

// No debt is not "infinitely healthy" — it is no ratio at all.
func TestNoDebtHasNoHealthFactor(t *testing.T) {
	hf, hasDebt := finance.HealthFactor(usdc(10_000), pct(85), new(big.Int))
	if hasDebt || hf != nil {
		t.Fatalf("want no ratio, got %v (hasDebt=%v)", hf, hasDebt)
	}
	if got := finance.BandOf(hf, hasDebt); got != finance.BandNone {
		t.Fatalf("band %q, want none", got)
	}
}

// Debt is the scaled amount times the live index, which is why an interest
// accrual that emits no event still shows up.
//
//	scaled 1,000 at index 1.05 (RAY) = 1,050 owed
func TestDebtScalesWithTheBorrowIndex(t *testing.T) {
	index := finance.MulDiv(finance.RAY, big.NewInt(105), big.NewInt(100))
	state := finance.VaultState{ScaledDebt: usdc(1_000), BorrowIndex: index}
	eq(t, finance.StoredDebt(state), usdc(1_050), "debt")

	// A fresh pool's index is exactly RAY, so scaled and nominal agree.
	fresh := finance.VaultState{ScaledDebt: usdc(1_000), BorrowIndex: finance.RAY}
	eq(t, finance.StoredDebt(fresh), usdc(1_000), "debt at index 1.0")
}

// The debt the API reports counts interest since the pool last accrued.
//
//	index 1.0, 10%/year borrow rate, 36.5 days since the last accrual
//	  growth = rate x elapsed = 1%
//	  index' = 1.01, so a scaled 1,000 owes 1,010
//
// The contract's own view still says 1,000 until someone pokes the pool —
// and `liquidate` pokes it before reading the health factor, so 1,010 is the
// figure that decides whether collateral is taken.
func TestDebtCountsInterestSinceTheLastAccrual(t *testing.T) {
	const day = int64(24 * 60 * 60)
	const year = 365 * day

	state := finance.VaultState{
		ScaledDebt:          usdc(1_000),
		BorrowIndex:         finance.RAY,
		BorrowRatePerSecond: new(big.Int).Div(pct(10), big.NewInt(year)),
		LastAccrualTime:     0,
	}
	now := int64(36.5 * float64(day))

	stored := finance.StoredDebt(state)
	eq(t, stored, usdc(1_000), "the contract's view is unmoved")

	accrued := finance.Debt(state, now)
	if accrued.Cmp(stored) <= 0 {
		t.Fatalf("accrued debt %s is not above the stored %s", accrued, stored)
	}
	// About 1% more. Not exact, because the per-second rate truncates when it
	// is derived — the contract truncates it identically.
	if diff := new(big.Int).Sub(accrued, usdc(1_010)); diff.CmpAbs(big.NewInt(10_000)) > 0 {
		t.Fatalf("accrued debt %s, want about %s", accrued, usdc(1_010))
	}

	// And the whole picture reports both, with the gap between them named.
	health := finance.Describe(state, finance.VaultParams{
		MaxLTV: pct(75), LiquidationThreshold: pct(85),
	}, now)
	eq(t, health.DebtAtStoredIndex, stored, "stored debt")
	eq(t, health.Debt, accrued, "reported debt")
	eq(t, health.PendingInterest, new(big.Int).Sub(accrued, stored), "pending interest")
}

// A pool poked this second has nothing pending, and the two figures agree.
// The projection must not invent interest out of a zero elapsed.
func TestAFreshlyAccruedPoolHasNothingPending(t *testing.T) {
	state := finance.VaultState{
		ScaledDebt:          usdc(1_000),
		BorrowIndex:         finance.RAY,
		BorrowRatePerSecond: big.NewInt(1_000_000_000),
		LastAccrualTime:     5_000,
	}
	eq(t, finance.Debt(state, 5_000), finance.StoredDebt(state), "debt at the accrual instant")

	// And a clock behind the last accrual — which a stale header could
	// produce — must not run the index backwards.
	eq(t, finance.Debt(state, 4_000), finance.StoredDebt(state), "debt before the accrual")
}

// The borrow ceiling uses maxLTV, deliberately below the liquidation
// threshold, so a borrower at their limit is not one block from liquidation.
//
//	collateral 10,000, maxLTV 75%, existing debt 5,000
//	  ceiling = 7,500, room = 2,500
func TestMaxBorrowableLeavesHeadroomBelowTheLine(t *testing.T) {
	eq(t, finance.MaxBorrowable(usdc(10_000), pct(75), usdc(5_000)), usdc(2_500), "room")

	// At the ceiling, and past it, there is no room rather than a negative.
	eq(t, finance.MaxBorrowable(usdc(10_000), pct(75), usdc(7_500)), new(big.Int), "at the ceiling")
	eq(t, finance.MaxBorrowable(usdc(10_000), pct(75), usdc(9_000)), new(big.Int), "past the ceiling")

	// And the headroom is real: at the ceiling the position is still healthy.
	hf, hasDebt := finance.HealthFactor(usdc(10_000), pct(85), usdc(7_500))
	if finance.Liquidatable(hf, hasDebt) {
		t.Fatalf("a position borrowed to the maxLTV ceiling is liquidatable (hf %s)", hf)
	}
}

// Describe must derive every figure from one snapshot, so they agree with
// each other.
func TestDescribeIsInternallyConsistent(t *testing.T) {
	state := finance.VaultState{
		Principal:     usdc(10_000),
		SharesValue:   usdc(10_000),
		RatePerSecond: big.NewInt(0),
		ScaledDebt:    usdc(4_000),
		BorrowIndex:   finance.RAY,
	}
	params := finance.VaultParams{MaxLTV: pct(75), LiquidationThreshold: pct(85)}

	health := finance.Describe(state, params, 1_000_000)

	eq(t, health.Collateral, usdc(10_000), "collateral")
	eq(t, health.Debt, usdc(4_000), "debt")
	eq(t, health.MaxBorrowable, usdc(3_500), "room to the 7,500 ceiling")

	// The reported ratio must be the one the reported figures produce.
	want, _ := finance.HealthFactor(health.Collateral, params.LiquidationThreshold, health.Debt)
	eq(t, health.HealthFactor, want, "health factor")

	wantLTV, _ := finance.LTV(health.Debt, health.Collateral)
	eq(t, health.LTV, wantLTV, "ltv")
	eq(t, health.LTV, pct(40), "ltv is 4,000/10,000")
}

// MulDiv must round down, like the contracts, and must not lose the
// intermediate product to overflow.
func TestMulDivRoundsDownAndCarriesFullWidth(t *testing.T) {
	eq(t, finance.MulDiv(big.NewInt(7), big.NewInt(1), big.NewInt(2)), big.NewInt(3), "7/2 rounds down")

	// 2^200, well past what 256 bits would survive being squared.
	huge := new(big.Int).Lsh(big.NewInt(1), 200)
	eq(t, finance.MulDiv(huge, huge, huge), huge, "huge x huge / huge")

	// A zero denominator is answered, not panicked on.
	eq(t, finance.MulDiv(big.NewInt(1), big.NewInt(1), new(big.Int)), new(big.Int), "zero denominator")
}
