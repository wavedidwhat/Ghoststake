import { describe, expect, it } from "vitest";
import {
  NO_DEBT,
  WAD,
  formatAmount,
  formatHealthFactor,
  formatPercent,
  hasDebt,
  healthBand,
  shortenAddress,
  splitFigure,
} from "../format";

/**
 * These functions stand between a uint256 and a number a user acts on, so
 * the cases worth testing are the ones that would still *look* fine on
 * screen while being wrong.
 */

describe("the no-debt sentinel", () => {
  it("never renders uint256 max as a health factor", () => {
    // The contract returns type(uint256).max for a position with no lien.
    // Rendered naively that is a 78-digit number sitting where a user
    // expects "1.84" — the single worst thing this screen could show.
    expect(formatHealthFactor(NO_DEBT)).toBeNull();
    expect(hasDebt(NO_DEBT)).toBe(false);
    expect(healthBand(NO_DEBT)).toBe("none");
  });

  it("matches the contract's sentinel exactly", () => {
    expect(NO_DEBT).toBe(2n ** 256n - 1n);
  });

  it("treats one below the sentinel as real debt", () => {
    // Guards against a sloppy `>=` comparison: this value is absurd but it
    // is not the sentinel, so it must not be swallowed as "no debt".
    expect(hasDebt(NO_DEBT - 1n)).toBe(true);
  });
});

describe("health bands", () => {
  it("warns well before the contract's liquidation line", () => {
    // 1.0 is where liquidation becomes possible. A user first warned at 1.0
    // has already lost the window to act, so `danger` starts at 1.2.
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
    // Debt renders as "(2,400.0000)". The tail split must not lose the
    // closing paren into the lead.
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

describe("addresses", () => {
  it("shortens without dropping the checksum-bearing ends", () => {
    expect(shortenAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});
