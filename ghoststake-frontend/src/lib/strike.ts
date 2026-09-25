/**
 * Choosing the level a round asks about (GHO-79).
 *
 * The keeper picks this for the rounds it opens; the operator console picks it
 * for the ones a human opens. Both round the same way, so a round opened by
 * hand states its question in the same voice as one opened automatically.
 *
 * Deliberately duplicated from `internal/keeper/strike.go` rather than shared:
 * the alternative is an endpoint the console would have to call before it can
 * show a number, and the rule is six lines. Both copies are tested against the
 * same worked examples, and the drift risk is written down in ADR 0068.
 */

const WAD = 10n ** 18n;

/**
 * Rounds a spot price to a level a person would say out loud.
 *
 * "Will ETH be above $2,690 at 14:30" is a question; "above $2,688.9034172"
 * is a reading, and reads as a trick. The step is a thousandth of the price's
 * own magnitude rounded to a power of ten, so the strike sits within half a
 * step of spot — close enough that neither side is a foregone conclusion.
 *
 * Returns null for a price that cannot carry a strike, which the caller must
 * treat as "cannot open a round yet" rather than substituting a guess: the
 * contract refuses a zero strike, and a wrong one decides who gets paid.
 */
export function strikeFor(spot: bigint | undefined): bigint | null {
  if (spot === undefined || spot <= 0n) return null;

  const step = strikeStep(spot);
  const strike = ((spot + step / 2n) / step) * step;
  return strike === 0n ? step : strike;
}

/** 10^(digits-3) whole units, floored at a hundredth of a unit. */
function strikeStep(spot: bigint): bigint {
  const whole = spot / WAD;
  const digits = whole === 0n ? 0 : whole.toString().length;
  const exponent = Math.max(16, 18 + digits - 3);
  return 10n ** BigInt(exponent);
}
