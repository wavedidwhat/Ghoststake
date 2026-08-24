import { describe, expect, it } from "vitest";
import {
  NO_DEBT,
  WAD,
  formatAmount,
  formatApr,
  formatHealthFactor,
  formatPercent,
  hasDebt,
  healthBand,
  shortenAddress,
  splitFigure,
} from "../format";

/**
 * These sit between a uint256 and a number a user acts on, so the cases
 * covered are the ones that would render plausibly while being wrong.
 */

describe("the no-debt sentinel", () => {
  it("never renders uint256 max as a health factor", () => {
    // The no-lien sentinel, which would otherwise print as 78 digits.
    expect(formatHealthFactor(NO_DEBT)).toBeNull();
    expect(hasDebt(NO_DEBT)).toBe(false);
    expect(healthBand(NO_DEBT)).toBe("none");
  });

  it("matches the contract's sentinel exactly", () => {
    expect(NO_DEBT).toBe(2n ** 256n - 1n);
  });

  it("treats one below the sentinel as real debt", () => {
    // Catches a `>=` comparison: absurd, but not the sentinel.
    expect(hasDebt(NO_DEBT - 1n)).toBe(true);
  });
});

describe("health bands", () => {
  it("warns well before the contract's liquidation line", () => {
    // 1.0 is where liquidation becomes possible, so danger starts at 1.2.
    expect(healthBand(WAD)).toBe("danger");
    expect(healthBand((WAD * 119n) / 100n)).toBe("danger");
    expect(healthBand((WAD * 12n) / 10n)).toBe("caution");
  });

  it("separates caution from safe at 1.5", () => {
    expect(healthBand((WAD * 149n) / 100n)).toBe("caution");
    expect(healthBand((WAD * 15n) / 10n)).toBe("safe");
    expect(healthBand(WAD * 3n)).toBe("safe");
  });

  it("bands a position already past the line as danger", () => {
    expect(healthBand((WAD * 95n) / 100n)).toBe("danger");
    expect(healthBand(0n)).toBe("danger");
  });
});

describe("figures", () => {
  it("splits the decimal tail so it can be dimmed", () => {
    expect(splitFigure("107,843.82")).toEqual({ lead: "107,843", tail: ".82" });
    expect(splitFigure("31.39686")).toEqual({ lead: "31", tail: ".39686" });
  });

  it("leaves an integer with no tail", () => {
    expect(splitFigure("2048")).toEqual({ lead: "2048", tail: "" });
  });

  it("keeps accounting parentheses intact", () => {
    // Debt renders as "(2,400.0000)"; the closing paren belongs to the tail.
    const { lead, tail } = splitFigure("(2,400.0000)");
    expect(lead + tail).toBe("(2,400.0000)");
    expect(tail).toBe(".0000)");
  });
});

describe("amounts and percentages", () => {
  it("formats 18-decimal amounts with grouped thousands", () => {
    expect(formatAmount(1234567n * 10n ** 18n)).toBe("1,234,567.0000");
    expect(formatAmount(10n ** 18n / 2n)).toBe("0.5000");
  });

  it("renders a zero balance rather than an empty string", () => {
    expect(formatAmount(0n)).toBe("0.0000");
  });

  it("does not fall back to scientific notation on large balances", () => {
    expect(formatAmount(10n ** 30n)).not.toMatch(/e\+/i);
  });

  it("scales WAD ratios to percentages", () => {
    expect(formatPercent((WAD * 8n) / 10n)).toBe("80.00%");
    expect(formatPercent(0n)).toBe("0.00%");
  });

  it("formats a health factor to two places", () => {
    expect(formatHealthFactor((WAD * 184n) / 100n)).toBe("1.84");
    expect(formatHealthFactor(WAD)).toBe("1.00");
  });
});

describe("audit regressions", () => {
  it("never renders a health factor in scientific notation", () => {
    // toFixed switches to exponential at 1e21, and a dust lien pushes the
    // ratio well past it: repay down to 1 wei and the figure explodes.
    const dustLien = (1_000n * WAD * ((85n * WAD) / 100n)) / 1n;
    const rendered = formatHealthFactor(dustLien);
    expect(rendered).not.toMatch(/e\+/i);
    expect(rendered).toBe("999+");
  });

  it("caps only above the ceiling, not at ordinary values", () => {
    expect(formatHealthFactor(999n * WAD)).toBe("999.00");
    expect(formatHealthFactor(999n * WAD + 1n)).toBe("999+");
  });

  it("does not fabricate digits on a large balance", () => {
    // Via Number this rendered as ...567,000.0000 — trailing zeros that look
    // exact and are float precision running out.
    const value = 12345678901234567891234567890123456789n;
    expect(formatAmount(value)).toBe("12,345,678,901,234,567,891.2346");
  });

  it("stays exact at the far end of uint256", () => {
    // Carries every digit, where Number would have rounded off the tail.
    // Compared against half-up, not integer division, which truncates.
    const huge = 2n ** 200n;
    const unit = 10n ** 18n;
    const expected = (huge + unit / 2n) / unit;
    expect(formatAmount(huge, 18, 0).replace(/,/g, "")).toBe(expected.toString());
    expect(formatAmount(huge, 18, 0)).toHaveLength(43 + 14); // 43 digits, 14 separators
  });

  it("rounds half-up rather than truncating", () => {
    expect(formatAmount(15n * 10n ** 17n, 18, 0)).toBe("2");
    expect(formatAmount(14n * 10n ** 17n, 18, 0)).toBe("1");
  });

  it("renders zero and sub-unit amounts without losing the leading zero", () => {
    expect(formatAmount(1n)).toBe("0.0000");
    expect(formatAmount(10n ** 14n)).toBe("0.0001");
  });

  it("groups thousands only in the integer part", () => {
    expect(formatAmount(1234567n * WAD)).toBe("1,234,567.0000");
    expect(formatPercent(WAD * 1234n)).toBe("123,400.00%");
  });
});

describe("addresses", () => {
  it("shortens without dropping the checksum-bearing ends", () => {
    expect(shortenAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});

describe("apr", () => {
  it("annualises a per-second rate", () => {
    // The pool stores 5% APR as a per-second WAD; the UI must show 5%, not
    // the per-second figure, and not a compounded APY the contract never
    // charges.
    const fivePercent = (5n * WAD) / 100n / (365n * 24n * 60n * 60n);
    expect(formatApr(fivePercent)).toBe("5.00%");
  });

  it("shows a zero rate as zero, not blank", () => {
    expect(formatApr(0n)).toBe("0.00%");
  });
});
