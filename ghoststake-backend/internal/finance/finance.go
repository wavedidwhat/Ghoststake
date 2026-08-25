// Package finance holds the protocol's money rules: yield accrual, debt
// scaling, health factors, borrowing room, and parimutuel payouts.
//
// It imports nothing but the standard library. No HTTP, no SQL, no ethclient,
// nothing from the rest of this module. That is the point of it: these are the
// rules a user's money depends on, and they should be readable and testable
// without a database, a chain, or a request.
//
// # Everything here mirrors a contract
//
// The contracts are the authority. Nothing in this package invents a rule —
// each function reproduces one the contract already enforces, in the same
// fixed-point arithmetic and with the same rounding direction, and says which
// one in its doc comment.
//
// That is a duplication, and duplication drifts. The answer is not to trust
// it: `finance_live_test.go` calls the deployed contracts' own views and
// asserts this package returns the identical figure for the identical inputs.
// If a contract changes and this does not, that test fails. Without it, this
// package would be a second opinion that quietly becomes wrong — which for a
// health factor means telling someone they are safe while they are being
// liquidated.
//
// # Why compute it here at all, rather than just calling the contract
//
// Two reasons. A page showing a health factor, the collateral behind it, the
// debt, the accrued yield and the room left to borrow is five `eth_call`s per
// viewer per refresh against a rate-limited RPC; the raw state behind all five
// is three. And a projection — "what would this become if you borrowed
// another 500" — has no contract view to call, because it has not happened.
package finance

import (
	"math/big"
)

// Fixed-point scales, matching the contracts.
//
//   - WAD (1e18) is the ratio and rate scale: 1e18 is 100%, or 1.0x.
//   - RAY (1e27) is the interest-index scale. Higher because indices compound
//     and a truncation there is permanent — it is baked into every balance
//     derived from the index afterwards.
var (
	WAD = mustBig("1000000000000000000")
	RAY = mustBig("1000000000000000000000000000")
)

// SecondsPerYear is the contracts' year: 365 days, no leap handling. Used only
// to annualise a per-second rate for display.
const SecondsPerYear = 365 * 24 * 60 * 60

func mustBig(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("finance: bad constant " + s)
	}
	return v
}

// MulDiv is `a * b / denominator`, rounding down, with the intermediate
// product carried at full width.
//
// This is OpenZeppelin's `Math.mulDiv`, which the contracts use everywhere.
// Reproducing it exactly matters more than it looks: `a * b` overflows 256
// bits routinely for realistic balances and Solidity's mulDiv carries the
// intermediate in 512 bits rather than reverting. Go's big.Int is arbitrary
// precision, so the multiply is free — what has to be copied is the rounding.
// Floor division, always down, is what the contracts do, and half a wei of
// disagreement in the wrong direction is a health factor that says safe when
// the contract says liquidate.
//
// A zero denominator returns zero rather than panicking. Every call site here
// has already decided what a zero denominator means (no debt, an empty pool)
// and answered it; this is the backstop, not the decision.
func MulDiv(a, b, denominator *big.Int) *big.Int {
	if a == nil || b == nil || denominator == nil || denominator.Sign() == 0 {
		return new(big.Int)
	}
	product := new(big.Int).Mul(a, b)
	return product.Div(product, denominator)
}

// Min returns the smaller of two values. Nil is treated as absent rather than
// as zero: `Min(nil, x)` is x.
func Min(a, b *big.Int) *big.Int {
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case a.Cmp(b) <= 0:
		return new(big.Int).Set(a)
	default:
		return new(big.Int).Set(b)
	}
}

func or0(v *big.Int) *big.Int {
	if v == nil {
		return new(big.Int)
	}
	return v
}
