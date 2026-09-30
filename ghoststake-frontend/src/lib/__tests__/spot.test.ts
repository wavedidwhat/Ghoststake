import { describe, expect, it } from "vitest";
import { Side } from "../rounds";
import { translate } from "@/test/intl";
import { formatAge as ageOf, formatMove, isNarrow, isStalePrint, priceAge, standingOf } from "../spot";
import { formatFor } from "@/lib/format";

const en = formatFor("en");

const formatAge = (seconds: number) => translate(ageOf(seconds));

const usd = (n: string) => BigInt(Math.round(parseFloat(n) * 1e6)) * 10n ** 12n;

describe("standingOf", () => {
  it("names the side that would win if the round closed now", () => {
    expect(standingOf(usd("2712.00"), usd("2690.00")).leading).toBe(Side.Up);
    expect(standingOf(usd("2670.00"), usd("2690.00")).leading).toBe(Side.Down);
  });

  it("puts a price exactly on the strike on the Down side", () => {
    // The contract settles Up only when the close is *strictly* above the
    // strike. Calling this a tie on screen would tell half the market they
    // are level when they are losing.
    const { leading, bps } = standingOf(usd("2690.00"), usd("2690.00"));
    expect(leading).toBe(Side.Down);
    expect(bps).toBe(0);
  });

  it("measures the move in basis points", () => {
    expect(standingOf(usd("2690.00"), usd("2690.00")).bps).toBe(0);
    // 2690 → 2716.90 is exactly 1%.
    expect(standingOf(usd("2716.90"), usd("2690.00")).bps).toBe(100);
    expect(standingOf(usd("2663.10"), usd("2690.00")).bps).toBe(-100);
  });

  it("does not round a sub-basis-point move up into one", () => {
    // A move of 0.002% is not a move of 0.01%. Truncating toward zero keeps
    // the figure honest, and the *leader* still comes from the comparison
    // rather than from the rounded figure.
    const tiny = standingOf(usd("2690.00") + 1n, usd("2690.00"));
    expect(tiny.bps).toBe(0);
    expect(tiny.leading).toBe(Side.Up);
  });

  it("says nothing at all without both numbers", () => {
    // A market deployed before GHO-79 has no strike until it locks, and a
    // feed that has never published has no price. Neither is an error, and
    // neither may be rendered as a zero.
    expect(standingOf(undefined, usd("2690"))).toEqual({ leading: null, bps: null });
    expect(standingOf(usd("2690"), undefined)).toEqual({ leading: null, bps: null });
    expect(standingOf(usd("2690"), 0n)).toEqual({ leading: null, bps: null });
    expect(standingOf(0n, usd("2690"))).toEqual({ leading: null, bps: null });
  });
});

describe("formatMove", () => {
  it("always carries a sign", () => {
    expect(formatMove(42, en)).toBe("+0.42%");
    // A minus sign, not a hyphen: the figures are tabular and a hyphen is
    // narrower than a digit.
    expect(formatMove(-42, en)).toBe("−0.42%");
    expect(formatMove(0, en)).toBe("±0.00%");
  });
});

describe("isNarrow", () => {
  it("flags a lead small enough to flip", () => {
    // "Yes is ahead" at +0.01% and at +4% are not the same claim, and an
    // ETH/USD feed crosses a tenth of a percent several times an hour.
    expect(isNarrow(5)).toBe(true);
    expect(isNarrow(-5)).toBe(true);
    expect(isNarrow(400)).toBe(false);
  });
});

describe("priceAge", () => {
  it("is the gap between the print and now", () => {
    expect(priceAge(1000n, 1600n)).toBe(600);
  });

  it("is null when either end is unknown", () => {
    expect(priceAge(undefined, 1600n)).toBeNull();
    expect(priceAge(1000n, undefined)).toBeNull();
  });

  // A feed's clock and the browser's clock are different clocks. A print
  // stamped a few seconds ahead is ordinary skew, and "printed in −4 seconds"
  // on screen would look like a bug in us rather than a fact about time.
  it("clamps a print stamped in the future to zero rather than going negative", () => {
    expect(priceAge(2000n, 1600n)).toBe(0);
  });
});

describe("formatAge", () => {
  it("calls a fresh print just now", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(89)).toBe("just now");
  });

  it("counts minutes, then hours", () => {
    expect(formatAge(90)).toBe("2 min ago");
    expect(formatAge(20 * 60)).toBe("20 min ago");
    expect(formatAge(60 * 60)).toBe("1 hour ago");
    expect(formatAge(2 * 60 * 60)).toBe("2 hours ago");
    expect(formatAge(90 * 60)).toBe("1h 30m ago");
  });
});

describe("isStalePrint", () => {
  // The measured cadence of the live Sepolia ETH/USD feed on 2026-09-25 was
  // 60, 61, 60, 60, 61, 60, 61 and 34 minutes. Twenty minutes is therefore an
  // ordinary age on this feed and must not be flagged, or the warning fires
  // on almost every page load and stops meaning anything.
  it("does not flag an age that is normal for an hourly feed", () => {
    expect(isStalePrint(20 * 60)).toBe(false);
  });

  it("flags a print past half the heartbeat", () => {
    expect(isStalePrint(30 * 60)).toBe(true);
    expect(isStalePrint(59 * 60)).toBe(true);
  });
});
