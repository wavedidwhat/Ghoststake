import { describe, expect, it } from "vitest";
import { questionFor, sideLabel, winnerLabel } from "../question";
import { Side } from "../rounds";

const wad = (n: string) => BigInt(n) * 10n ** 18n;
// 2026-09-24 14:30 local, so the rendered time matches wherever this runs.
const closeTime = BigInt(Math.floor(new Date(2026, 8, 24, 14, 30).getTime() / 1000));
const at = new Date(2026, 8, 24, 14, 30).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("a market as a question", () => {
  it("states the level and the time", () => {
    expect(questionFor({ feed: "ETH / USD", strike: wad("2690"), closeTime })).toBe(
      `ETH above $2,690 at ${at}`,
    );
  });

  it("does not invent a level for a market that has no strike yet", () => {
    // Markets deployed before GHO-79 have no strike until they lock. The old
    // phrasing is the honest one; a made-up number would decide payouts.
    expect(questionFor({ feed: "ETH / USD", strike: null, closeTime })).toBe(`ETH higher at ${at}`);
    expect(questionFor({ feed: "ETH / USD", strike: 0n, closeTime })).toBe(`ETH higher at ${at}`);
  });

  it("keeps decimals only where they carry information", () => {
    expect(questionFor({ feed: "ETH / USD", strike: wad("2690"), closeTime })).toContain("$2,690 ");
    expect(questionFor({ feed: "LINK / USD", strike: 12_34n * 10n ** 16n, closeTime })).toContain("$12.34 ");
  });

  it("falls back rather than rendering a blank question", () => {
    expect(questionFor({ feed: undefined, strike: wad("2690"), closeTime })).toContain("The price above");
    expect(questionFor({ feed: "ETH / USD", strike: wad("2690"), closeTime: undefined })).toBe(
      "ETH above $2,690",
    );
  });
});

describe("the two answers", () => {
  it("are Yes and No on screen, whatever the contract calls them", () => {
    expect(sideLabel(Side.Up)).toBe("Yes");
    expect(sideLabel(Side.Down)).toBe("No");
    expect(winnerLabel("up")).toBe("Yes");
    expect(winnerLabel("down")).toBe("No");
    expect(winnerLabel(null)).toBeNull();
  });
});
