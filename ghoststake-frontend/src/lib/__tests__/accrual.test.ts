import { describe, expect, it } from "vitest";
import { accrualMargin, borrowHeadroom, payOffAmount } from "../accrual";
import { maxBorrow, originationFeeOn } from "../stockLoan";

const USDC = 10n ** 6n;
const WAD = 10n ** 18n;

// Interest pending since the pool last accrued, as the contract will find it:
// debt read x rate x elapsed. 20% APR for a day on 1,000 is about 0.548.
function pending(debt: bigint, aprPercent: bigint, seconds: bigint): bigint {
  return (debt * aprPercent * seconds) / (100n * 365n * 86_400n);
}

describe("accrual margin (audit 2026-09-30)", () => {
  it("is zero without a debt, so a first borrow keeps its full headroom", () => {
    expect(accrualMargin(0n)).toBe(0n);
    expect(borrowHeadroom(600n * USDC, 0n)).toBe(600n * USDC);
  });

  // CollateralVault._borrow: accrue(), then lienOf(user) + amount <= ceiling.
  // Max used to be exactly `maxBorrowable`, read at the stored index.
  it("borrow Max still fits under the ceiling once the vault accrues", () => {
    const debt = 1_000n * USDC;
    const ceiling = 1_500n * USDC; // collateral x maxLTV
    const storedHeadroom = ceiling - debt;
    const accrued = debt + pending(debt, 20n, 86_400n);

    // The old Max reverts: ExceedsMaxLTV.
    expect(accrued + storedHeadroom > ceiling).toBe(true);
    // The new one does not.
    expect(accrued + borrowHeadroom(storedHeadroom, debt) <= ceiling).toBe(true);
  });

  // StockLoanVault.borrow: accrue(), then debt + amount + ceil(fee) <= limit.
  it("stock borrow Max still fits under the limit once the pool accrues", () => {
    const debt = 2_000n * USDC;
    const limit = 3_000n * USDC;
    const fee = (5n * WAD) / 1000n; // 0.5%
    const accrued = debt + pending(debt, 20n, 86_400n);

    const old = maxBorrow(limit, debt, fee);
    expect(accrued + old + originationFeeOn(old, fee) > limit).toBe(true);

    const now = maxBorrow(limit, debt + accrualMargin(debt), fee);
    expect(accrued + now + originationFeeOn(now, fee) <= limit).toBe(true);
  });

  // Both vaults cap a repayment at what is owed, so sending the margin too is
  // free, and sending exactly the debt read leaves the pending interest owing.
  it("repay all clears the debt the contract finds, not the one read", () => {
    const debt = 200n * USDC;
    const accrued = debt + pending(debt, 20n, 86_400n);

    expect(debt < accrued).toBe(true); // the dust the old button left
    expect(payOffAmount(debt, 10_000n * USDC) >= accrued).toBe(true);
  });

  it("never sends more than the wallet holds", () => {
    expect(payOffAmount(200n * USDC, 200n * USDC)).toBe(200n * USDC);
  });

  it("covers a debt too small for 0.1% to register", () => {
    expect(accrualMargin(999n)).toBe(1n);
    expect(payOffAmount(999n, 10n ** 12n)).toBe(1_000n);
  });
});
