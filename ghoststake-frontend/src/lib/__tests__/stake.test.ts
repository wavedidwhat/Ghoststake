import { describe, expect, it } from "vitest";
import { dustFloor, stakeStanding } from "../stake";

/**
 * The numbers here are the live Sepolia position from GHO-55, because the
 * whole point of the issue is that they were rendered as earnings:
 *
 *   principal         21,000.0000
 *   totalLedgerValue  21,012.0167
 *   collateralValue   21,000.0000   <- maxWithdraw, exactly the principal
 */
const LEDGER = 21_012_016_700n; // 6 decimals
const REDEEMABLE = 21_000_000_000n;

describe("stakeStanding", () => {
  it("reports the unbacked part of a ledger nothing funds", () => {
    const standing = stakeStanding(LEDGER, REDEEMABLE, 6)!;

    expect(standing.unbacked).toBe(12_016_700n);
    expect(standing.backed).toBe(false);
  });

  it("reports a funded position as backed", () => {
    const standing = stakeStanding(LEDGER, LEDGER, 6)!;

    expect(standing.unbacked).toBe(0n);
    expect(standing.backed).toBe(true);
  });

  /**
   * The case that would put a scary sentence on a healthy position.
   * `collateralValue` is a `min` of two independently-rounded quantities, so a
   * few wei of drift is normal and means nothing.
   */
  it("treats sub-display dust as backed", () => {
    const standing = stakeStanding(REDEEMABLE + 5n, REDEEMABLE, 6)!;

    expect(standing.unbacked).toBe(5n);
    expect(standing.backed).toBe(true);
  });

  it("does not treat a visible shortfall as dust", () => {
    const standing = stakeStanding(REDEEMABLE + dustFloor(6), REDEEMABLE, 6)!;

    expect(standing.backed).toBe(false);
  });

  /**
   * The cap can only bind one way. If a rounding quirk ever put redeemable
   * above the ledger, that is not negative unbacked yield.
   */
  it("never reports a negative shortfall", () => {
    const standing = stakeStanding(REDEEMABLE, LEDGER, 6)!;

    expect(standing.unbacked).toBe(0n);
    expect(standing.backed).toBe(true);
  });

  it("is undefined until every input has loaded", () => {
    expect(stakeStanding(undefined, REDEEMABLE, 6)).toBeUndefined();
    expect(stakeStanding(LEDGER, undefined, 6)).toBeUndefined();
    expect(stakeStanding(LEDGER, REDEEMABLE, undefined)).toBeUndefined();
  });
});

describe("dustFloor", () => {
  it("is one unit at the precision amounts are displayed to", () => {
    expect(dustFloor(6)).toBe(100n); // 0.0001 of a 6-decimal token
    expect(dustFloor(18)).toBe(10n ** 14n);
  });

  /** A token with fewer decimals than the display asks for has no dust. */
  it("floors at one wei for a low-decimal token", () => {
    expect(dustFloor(2)).toBe(1n);
    expect(dustFloor(4)).toBe(1n);
  });
});
