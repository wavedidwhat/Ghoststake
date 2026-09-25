import { describe, expect, it } from "vitest";
import {
  healthAfter,
  maxBorrow,
  maxWithdraw,
  originationFeeOn,
  stalePrices,
  summarise,
  type StockCollateral,
} from "../stockLoan";

/**
 * The screen's previews against the contract's own worked numbers
 * (test/StockLoanVault.t.sol): 100 TSLA at $400, 40% max LTV, 55% threshold,
 * 0.5% origination fee, a 6-decimal stablecoin.
 */
const E18 = 10n ** 18n;
const FEE = 5n * 10n ** 15n; // 0.5%

function tsla(overrides: Partial<StockCollateral> = {}): StockCollateral {
  return {
    token: "0x0000000000000000000000000000000000000001",
    symbol: "TSLA",
    name: "Tesla",
    decimals: 18,
    maxLTV: 4n * 10n ** 17n,
    liquidationThreshold: 55n * 10n ** 16n,
    liquidationBonus: 8n * 10n ** 16n,
    maxAge: 86_400n,
    liquidationMaxAge: 432_000n,
    wallet: 0n,
    allowance: 0n,
    deposited: 100n * E18,
    valuePerToken: 400_000_000n,
    updatedAt: 1_000_000n,
    ...overrides,
  };
}

describe("stock loan previews", () => {
  it("values the position as the vault does", () => {
    const s = summarise([tsla()]);
    expect(s.value).toBe(40_000_000_000n);
    expect(s.borrowLimit).toBe(16_000_000_000n);
    expect(s.liquidationLine).toBe(22_000_000_000n);
  });

  it("skips tokens not held, and flags an unpriced one it holds", () => {
    expect(summarise([tsla({ deposited: 0n, valuePerToken: undefined })])).toEqual({
      value: 0n,
      borrowLimit: 0n,
      liquidationLine: 0n,
      incomplete: false,
    });
    expect(summarise([tsla({ valuePerToken: undefined })]).incomplete).toBe(true);
  });

  it("charges the fee the contract charges", () => {
    // test_borrowPaysExactAmountAndFeeGoesToTreasury: 10,000 borrowed, 50 fee.
    expect(originationFeeOn(10_000_000_000n, FEE)).toBe(50_000_000n);
    // Rounded up, never down.
    expect(originationFeeOn(1n, FEE)).toBe(1n);
  });

  it("offers the largest borrow the fee still fits under", () => {
    const limit = 16_000_000_000n;
    const x = maxBorrow(limit, 0n, FEE);
    expect(x + originationFeeOn(x, FEE)).toBeLessThanOrEqual(limit);
    expect(x + 1n + originationFeeOn(x + 1n, FEE)).toBeGreaterThan(limit);
    // test_borrowCountsTheFeeAgainstTheLimit: 15,950 fails, 15,900 fits.
    expect(x).toBeLessThan(15_950_000_000n);
    expect(x).toBeGreaterThan(15_900_000_000n);
    expect(maxBorrow(limit, limit, FEE)).toBe(0n);
  });

  it("offers the withdrawal the contract allows, and no more", () => {
    // test_withdrawWithDebtRespectsTheLimit: debt 8,040; 40 TSLA out is
    // fine, 60 is not. The exact edge is 49.75.
    const c = tsla();
    const max = maxWithdraw(c, summarise([c]), 8_040_000_000n);
    expect(max).toBe(4975n * 10n ** 16n);
    expect(maxWithdraw(c, summarise([c]), 0n)).toBe(100n * E18);
    expect(maxWithdraw(c, summarise([c]), 20_000_000_000n)).toBe(0n);
  });

  it("previews health as healthFactor computes it", () => {
    // test_liquidationSeizes...: $250 TSLA, debt 15,979.5, health ~0.86.
    const s = summarise([tsla({ valuePerToken: 250_000_000n })]);
    const hf = healthAfter(s, 15_979_500_000n)!;
    expect(Number(hf) / 1e18).toBeCloseTo(0.8605, 3);
    expect(healthAfter(s, 0n)).toBeNull();
  });

  it("calls a held price stale only past maxAge", () => {
    const c = tsla({ updatedAt: 0n });
    expect(stalePrices([c], 86_400n)).toEqual([]);
    expect(stalePrices([c], 86_401n)).toEqual([c]);
    // Not held, so its dead feed blocks nothing (test_unrelatedDeadFeedBlocksNobody).
    expect(stalePrices([tsla({ updatedAt: 0n, deposited: 0n })], 10n ** 9n)).toEqual([]);
  });
});
