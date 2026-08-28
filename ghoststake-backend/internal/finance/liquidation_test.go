package finance_test

import (
	"math/big"
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/finance"
)

// The deployment's own risk parameters, so the worked examples below are
// arithmetic anyone can check against the contracts rather than against a
// fixture invented to make them come out neatly.
func riskParams() finance.VaultParams {
	return finance.VaultParams{
		MaxLTV:               pct(50),
		LiquidationThreshold: pct(65),
		LiquidationBonus:     pct(5),
		CloseFactor:          pct(50),
	}
}

// hf builds a health factor from a collateral and a debt, the way the contract
// does: collateral x threshold / debt.
func hf(collateral, debt *big.Int, p finance.VaultParams) *big.Int {
	factor, _ := finance.HealthFactor(collateral, p.LiquidationThreshold, debt)
	return factor
}

// A healthy position quotes nothing. Not zero-because-the-maths-worked-out —
// the function returns early, because a quote for a position nobody may
// liquidate is a number with no meaning that a UI would happily render.
func TestQuoteIsEmptyForAHealthyPosition(t *testing.T) {
	p := riskParams()
	collateral, debt := usdc(10_000), usdc(1_000)

	q := finance.LiquidationQuote(collateral, debt, hf(collateral, debt, p), p)

	eq(t, q.MaxRepay, big.NewInt(0), "max repay")
	eq(t, q.Seized, big.NewInt(0), "seized")
	if q.Profitable {
		t.Fatal("quoted a profit on a position nobody may liquidate")
	}
}

// A worked example just past the line.
//
//	collateral 10,000, debt 6,600
//	  health   = 10,000 x 0.65 / 6,600 = 0.9848…  -> liquidatable
//	  full-liq line = 0.65 x 1.05 = 0.6825        -> above it, so capped
//	  repay    = 6,600 x 0.50 = 3,300
//	  seized   = 3,300 x 1.05 = 3,465
//	  bonus    = 3,465 - 3,300 = 165
func TestQuoteJustBelowTheLineIsCappedAndProfitable(t *testing.T) {
	p := riskParams()
	collateral, debt := usdc(10_000), usdc(6_600)

	q := finance.LiquidationQuote(collateral, debt, hf(collateral, debt, p), p)

	eq(t, q.MaxRepay, usdc(3_300), "max repay")
	eq(t, q.Seized, usdc(3_465), "seized")
	eq(t, q.Bonus, usdc(165), "bonus")
	if !q.Profitable {
		t.Fatal("a liquidator is 165 up here and the quote says otherwise")
	}
	if q.FullLiquidation {
		t.Fatal("the close factor should still cap this one")
	}
}

// Below `liquidationThreshold x (1 + bonus)` the cap lifts, because a capped
// liquidation there leaves the position *less* healthy than it started — every
// one makes the next worse while never being allowed to finish.
//
//	collateral 10,000, debt 10,000
//	  health   = 0.65  -> below the 0.6825 line
//	  repay    = the whole 10,000
//	  seized   = 10,500 wanted, capped at the 10,000 that exists
//	  bonus    = 0, and the liquidator is exactly square
func TestQuoteBelowTheBonusLineClearsTheWholeLien(t *testing.T) {
	p := riskParams()
	collateral, debt := usdc(10_000), usdc(10_000)

	q := finance.LiquidationQuote(collateral, debt, hf(collateral, debt, p), p)

	if !q.FullLiquidation {
		t.Fatal("the cap should have lifted below the bonus line")
	}
	eq(t, q.MaxRepay, usdc(10_000), "max repay")
	eq(t, q.Seized, usdc(10_000), "seized is capped at what exists")
	eq(t, q.Bonus, big.NewInt(0), "no bonus is left to pay")
	if q.Profitable {
		t.Fatal("square is not profitable, and a liquidator pays gas")
	}
}

// The case GHO-45 exists for, and the one this whole quote is here to make
// visible. A discovery endpoint that listed this row beside the profitable
// ones without distinguishing them would be sending liquidators to lose money.
//
//	collateral 5,000, debt 10,000
//	  repay  = 10,000 (the cap is lifted)
//	  seized = 10,500 wanted, capped at 5,000
//	  the liquidator pays 10,000 and receives 5,000
func TestQuoteIsUnprofitableOnceCollateralCannotCoverTheDebt(t *testing.T) {
	p := riskParams()
	collateral, debt := usdc(5_000), usdc(10_000)

	q := finance.LiquidationQuote(collateral, debt, hf(collateral, debt, p), p)

	eq(t, q.MaxRepay, usdc(10_000), "max repay")
	eq(t, q.Seized, usdc(5_000), "seized is everything there is")
	eq(t, q.Bonus, big.NewInt(0), "bonus is floored at zero, not negative")
	if q.Profitable {
		t.Fatal("this liquidator is 5,000 out of pocket")
	}
}

// The order of the cap is load-bearing. Applying the bonus after capping the
// seizure at the collateral would report a profit the chain would not pay: the
// contract caps last, and repays the full amount regardless.
func TestTheBonusIsNeverPaidOutOfCollateralThatDoesNotExist(t *testing.T) {
	p := riskParams()
	collateral, debt := usdc(5_000), usdc(10_000)

	q := finance.LiquidationQuote(collateral, debt, hf(collateral, debt, p), p)

	if q.Seized.Cmp(collateral) > 0 {
		t.Fatalf("quoted a seizure of %s against %s of collateral", q.Seized, collateral)
	}
}

// Params built for a health read alone carry no bonus or close factor. Better
// an empty quote than a confident one derived from nil.
func TestQuoteIsEmptyWithoutLiquidationParameters(t *testing.T) {
	partial := finance.VaultParams{MaxLTV: pct(50), LiquidationThreshold: pct(65)}
	collateral, debt := usdc(5_000), usdc(10_000)

	q := finance.LiquidationQuote(collateral, debt, hf(collateral, debt, partial), partial)

	eq(t, q.MaxRepay, big.NewInt(0), "max repay")
	if q.Profitable {
		t.Fatal("quoted a profit from parameters it does not have")
	}
}

// Whatever else moves, a liquidator can never be quoted more collateral than
// the position holds, and can never be quoted a repayment above the debt.
func TestFuzzQuoteStaysInsideThePosition(t *testing.T) {
	p := riskParams()
	for _, c := range []int64{1, 100, 5_000, 10_000, 250_000} {
		for _, d := range []int64{1, 100, 5_000, 10_000, 250_000} {
			collateral, debt := usdc(c), usdc(d)
			factor := hf(collateral, debt, p)
			q := finance.LiquidationQuote(collateral, debt, factor, p)

			if q.Seized.Cmp(collateral) > 0 {
				t.Fatalf("c=%d d=%d: seized %s exceeds collateral", c, d, q.Seized)
			}
			if q.MaxRepay.Cmp(debt) > 0 {
				t.Fatalf("c=%d d=%d: repay %s exceeds debt", c, d, q.MaxRepay)
			}
			if q.Profitable && q.Seized.Cmp(q.MaxRepay) <= 0 {
				t.Fatalf("c=%d d=%d: called profitable while seizing %s for %s", c, d, q.Seized, q.MaxRepay)
			}
		}
	}
}
