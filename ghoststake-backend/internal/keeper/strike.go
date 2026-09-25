package keeper

import "math/big"

// Choosing the level a round asks about (GHO-79).
//
// Before this, a round had no strike until `lockRound` read the feed, so the
// only question it could pose was "will it be higher in a few minutes". The
// strike is now chosen when the round is opened, which means a keeper has to
// pick a number — and the number is read by people, not machines.

// wad is the 18-decimal scale every price crosses the contract boundary in.
var wad = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

// StrikeFor rounds a spot price to a level a person would say out loud.
//
// "Will ETH be above $2,690 at 14:30" is a question. "Will ETH be above
// $2,688.9034172 at 14:30" is a reading, and reads as a trick — nobody
// believes a number that precise was chosen neutrally.
//
// The step is a thousandth of the price's own magnitude, rounded to a power
// of ten: 2,688.90 → 2,690 (step 10), 68,412 → 68,400 (step 100), 1.2345 →
// 1.23 (step 0.01). That keeps the strike within half a step of spot, which
// on any horizon this protocol runs is small against the move it is asking
// about — a strike far from spot would make one side a foregone conclusion
// and there would be no market.
//
// Deliberately not "spot exactly": a strike equal to the close price voids
// the round as a tie, and spot is the single value most likely to still be
// there at close on a quiet feed.
func StrikeFor(spot *big.Int) *big.Int {
	if spot == nil || spot.Sign() <= 0 {
		return nil
	}

	step := strikeStep(spot)
	half := new(big.Int).Rsh(step, 1)

	// Round half up, then never return zero: a sub-step price (a token worth
	// a fraction of a cent) would otherwise round down to a strike the
	// contract refuses, and "above zero" is not a question anyway.
	strike := new(big.Int).Add(spot, half)
	strike.Div(strike, step)
	strike.Mul(strike, step)
	if strike.Sign() == 0 {
		return step
	}
	return strike
}

// strikeStep is 10^(digits-3) whole units, floored at a hundredth.
func strikeStep(spot *big.Int) *big.Int {
	whole := new(big.Int).Div(spot, wad)

	digits := len(whole.String())
	if whole.Sign() == 0 {
		digits = 0
	}

	// exponent is in 18-decimal units: a step of one whole unit is 1e18.
	exponent := 18 + digits - 3
	if exponent < 16 {
		exponent = 16 // a hundredth of a unit, the finest step worth stating
	}
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exponent)), nil)
}
