import { describe, expect, it } from "vitest";
import { strikeFor } from "../strike";

const wad = (s: string): bigint => {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0").slice(0, 18));
};

/**
 * The same worked examples as `TestStrikeForReadsLikeAQuestion` in
 * internal/keeper/strike_test.go. If these two ever disagree, a round opened
 * by hand asks a different question from one opened by the keeper.
 */
describe("strikeFor", () => {
  it("rounds to a level a person would say", () => {
    expect(strikeFor(wad("2688.90342"))).toBe(wad("2690"));
    expect(strikeFor(wad("2684.10"))).toBe(wad("2680"));
    expect(strikeFor(wad("68412.77"))).toBe(wad("68400"));
    expect(strikeFor(wad("1.2345"))).toBe(wad("1.23"));
    expect(strikeFor(wad("0.00891"))).toBe(wad("0.01"));
    expect(strikeFor(wad("9.99"))).toBe(wad("9.99"));
  });

  it("stays within 1% of spot, or one side is a foregone conclusion", () => {
    for (const s of ["2688.90342", "68412.77", "1.2345", "17.5", "999.99"]) {
      const spot = wad(s);
      const strike = strikeFor(spot)!;
      const gap = strike > spot ? strike - spot : spot - strike;
      expect(gap * 100n).toBeLessThan(spot);
    }
  });

  it("refuses rather than guessing when there is no usable price", () => {
    // The contract rejects a zero strike, and a guessed one decides payouts.
    expect(strikeFor(undefined)).toBeNull();
    expect(strikeFor(0n)).toBeNull();
    expect(strikeFor(-1n)).toBeNull();
    expect(strikeFor(wad("0.0000001"))).toBeGreaterThan(0n);
  });
});
