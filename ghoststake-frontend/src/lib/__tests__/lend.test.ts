import { describe, expect, it } from "vitest";
import { WAD, formatPercent } from "../format";
import {
  lendWarnings,
  maxWithdraw,
  shareOfPool,
  utilizationAfter,
  withdrawProblem,
} from "../lend";

const USDC = (n: number) => BigInt(n) * 10n ** 6n;
const pct = (n: number) => (WAD * BigInt(Math.round(n * 100))) / 10_000n;

describe("maxWithdraw", () => {
  it("stops at the cash on hand, not the balance", () => {
    // The case the contract raises `InsufficientLiquidity` for. A lender with
    // 50k supplied into a pool holding 8k can take out 8k, and a Max button
    // offering 50k proposes a transaction that reverts.
    expect(maxWithdraw(USDC(50_000), USDC(8_000))).toBe(USDC(8_000));
  });

  it("stops at the balance when the pool is flush", () => {
    expect(maxWithdraw(USDC(1_000), USDC(80_000))).toBe(USDC(1_000));
  });

  it("is zero when the pool is fully lent out", () => {
    expect(maxWithdraw(USDC(50_000), 0n)).toBe(0n);
  });
});

describe("shareOfPool", () => {
  it("measures against the claims, not the cash", () => {
    // 25k of a 100k pool is a quarter of it whether or not 90k of that is
    // currently out on loan. Measured against cash it would read as 250%.
    expect(shareOfPool(USDC(25_000), USDC(100_000))).toBe(pct(25));
  });

  it("is zero in an empty pool rather than dividing by zero", () => {
    expect(shareOfPool(0n, 0n)).toBe(0n);
  });
});

describe("utilizationAfter", () => {
  it("matches the contract's formula on no change", () => {
    // borrowed / (available + borrowed) = 40k / 50k = 80%
    expect(utilizationAfter(USDC(40_000), USDC(10_000), 0n)).toBe(pct(80));
  });

  it("falls when supplying, which is the part that surprises a lender", () => {
    // The same 40k borrowed, against 40k of cash after a 30k deposit.
    const after = utilizationAfter(USDC(40_000), USDC(10_000), USDC(30_000));
    expect(formatPercent(after)).toBe("50.00%");
    expect(after).toBeLessThan(utilizationAfter(USDC(40_000), USDC(10_000), 0n));
  });

  it("rises when withdrawing", () => {
    const after = utilizationAfter(USDC(40_000), USDC(10_000), -USDC(5_000));
    expect(formatPercent(after)).toBe("88.89%");
  });

  it("is zero with nothing borrowed, however much cash there is", () => {
    expect(utilizationAfter(0n, USDC(100_000), 0n)).toBe(0n);
    expect(utilizationAfter(0n, 0n, 0n)).toBe(0n);
  });

  it("clamps rather than going negative on an over-large withdrawal", () => {
    // Cannot happen on chain, but the preview is fed a half-typed field and a
    // negative denominator renders as a nonsense percentage.
    expect(utilizationAfter(USDC(40_000), USDC(10_000), -USDC(999_999))).toBe(WAD);
  });
});

describe("lendWarnings", () => {
  const kink = pct(80);

  it("says nothing to a lender in a comfortable pool", () => {
    expect(
      lendWarnings({
        balance: USDC(1_000),
        available: USDC(60_000),
        utilization: pct(40),
        kink,
      }),
    ).toEqual([]);
  });

  it("warns that the exit is partial before it is discovered as a revert", () => {
    const codes = lendWarnings({
      balance: USDC(50_000),
      available: USDC(8_000),
      utilization: pct(84),
      kink,
    }).map((w) => w.code);
    expect(codes).toContain("exit-limited");
  });

  it("distinguishes a blocked exit from a limited one", () => {
    const codes = lendWarnings({
      balance: USDC(50_000),
      available: 0n,
      utilization: WAD,
      kink,
    }).map((w) => w.code);
    // Both are true at once and only the stronger should be said. "You can
    // withdraw some of it" is wrong when the answer is none of it.
    expect(codes).toContain("exit-blocked");
    expect(codes).not.toContain("exit-limited");
  });

  it("does not warn a lender with nothing at stake about their exit", () => {
    // A visitor reading the page before supplying. There is no exit to lose.
    const codes = lendWarnings({
      balance: 0n,
      available: 0n,
      utilization: WAD,
      kink,
    }).map((w) => w.code);
    expect(codes).not.toContain("exit-blocked");
    expect(codes).not.toContain("exit-limited");
  });

  it("explains a high rate as strain rather than leaving it as an offer", () => {
    const codes = lendWarnings({
      balance: 0n,
      available: USDC(2_000),
      utilization: pct(95),
      kink,
    }).map((w) => w.code);
    expect(codes).toContain("past-kink");
  });

  it("stays quiet exactly at the kink, which is the target and not a problem", () => {
    const codes = lendWarnings({
      balance: 0n,
      available: USDC(20_000),
      utilization: kink,
      kink,
    }).map((w) => w.code);
    expect(codes).not.toContain("past-kink");
  });

  it("gives every warning a distinct code", () => {
    // Same rule the keeper's refusal codes are held to: warnings are rendered
    // and deduplicated by identity, and two conditions sharing a code means
    // one of them silently never appears.
    const all = lendWarnings({
      balance: USDC(50_000),
      available: 0n,
      utilization: WAD,
      kink,
    });
    const codes = all.map((w) => w.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const w of all) {
      expect(w.code).not.toBe("");
      expect(w.text.length).toBeGreaterThan(0);
    }
  });
});

describe("withdrawProblem", () => {
  it("names the balance ceiling and the liquidity ceiling separately", () => {
    // Two different reverts with two different remedies: one is "you never
    // had that much", the other is "wait for a repayment".
    expect(withdrawProblem(USDC(60_000), USDC(50_000), USDC(50_000))).toBe("over-balance");
    expect(withdrawProblem(USDC(20_000), USDC(50_000), USDC(8_000))).toBe("over-liquidity");
  });

  it("reports the balance first when both are exceeded", () => {
    expect(withdrawProblem(USDC(60_000), USDC(50_000), USDC(8_000))).toBe("over-balance");
  });

  it("passes a withdrawal that fits under both", () => {
    expect(withdrawProblem(USDC(8_000), USDC(50_000), USDC(8_000))).toBeNull();
  });
});
