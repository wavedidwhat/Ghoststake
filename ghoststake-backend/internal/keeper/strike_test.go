package keeper

import (
	"math/big"
	"testing"
)

// price builds an 18-decimal fixed-point value from a decimal string.
func price(t *testing.T, s string) *big.Int {
	t.Helper()
	f, ok := new(big.Float).SetString(s)
	if !ok {
		t.Fatalf("bad price %q", s)
	}
	f.Mul(f, new(big.Float).SetInt(wad))
	v, _ := f.Int(nil)
	return v
}

func TestStrikeForReadsLikeAQuestion(t *testing.T) {
	cases := []struct{ spot, want string }{
		// The live ETH/USD reading on 2026-09-24, and what a round would ask.
		{"2688.90342", "2690"},
		{"2684.10", "2680"},
		{"68412.77", "68400"},
		{"1.2345", "1.23"},
		{"0.00891", "0.01"},
		// A ten-dollar asset gets cent steps, so spot is already sayable.
		{"9.99", "9.99"},
	}
	for _, c := range cases {
		got := StrikeFor(price(t, c.spot))
		want := price(t, c.want)
		if got.Cmp(want) != 0 {
			t.Errorf("StrikeFor(%s) = %s, want %s", c.spot, got, want)
		}
	}
}

// The strike has to be close to spot or there is no market: a level nobody
// thinks is reachable makes one side a foregone conclusion.
func TestStrikeStaysNearSpot(t *testing.T) {
	for _, s := range []string{"2688.90342", "68412.77", "1.2345", "17.5", "999.99"} {
		spot := price(t, s)
		strike := StrikeFor(spot)

		diff := new(big.Int).Sub(strike, spot)
		diff.Abs(diff)
		// Half a step, and a step is a thousandth of the magnitude, so the
		// gap can never reach 1% of spot.
		limit := new(big.Int).Div(spot, big.NewInt(100))
		if diff.Cmp(limit) >= 0 {
			t.Errorf("StrikeFor(%s) = %s, which is %s away — more than 1%% of spot", s, strike, diff)
		}
	}
}

func TestStrikeIsNeverZeroOrNegative(t *testing.T) {
	// Zero is refused by the contract (InvalidStrike), and a strike of zero
	// would make every close price "above" it.
	if got := StrikeFor(price(t, "0.0000001")); got == nil || got.Sign() <= 0 {
		t.Fatalf("a sub-cent price produced %v", got)
	}
	for _, bad := range []*big.Int{nil, big.NewInt(0), big.NewInt(-1)} {
		if got := StrikeFor(bad); got != nil {
			t.Errorf("StrikeFor(%v) = %v, want nil so the caller refuses to open", bad, got)
		}
	}
}
