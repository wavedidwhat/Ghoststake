import { describe, expect, it } from "vitest";
import messages from "../../../messages/en.json";
import { translate } from "@/test/intl";
import { questionFor as ask, sideKey, winnerKey } from "../question";
import { Side } from "../rounds";
import { formatFor } from "@/lib/format";

const en = formatFor("en");

const questionFor = (input: Omit<Parameters<typeof ask>[0], "format">) => translate(ask({ ...input, format: en }));

const wad = (n: string) => BigInt(n) * 10n ** 18n;
// 2026-09-24 14:30 local, so the rendered time matches wherever this runs.
const closeTime = BigInt(Math.floor(new Date(2026, 8, 24, 14, 30).getTime() / 1000));
// Written out rather than computed with the call the code makes: a test that
// derives its expectation from the implementation agrees with any change to it.
const at = "2:30 PM";

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

  it("names the asset, not the feed's label (GHO-114)", () => {
    const demo = "GHOSTSTAKE DEMO FEED (operator-set price) - ETH / USD";
    const mirrored = "GHOSTSTAKE DEMO FEED (operator-set price) - RHTSLA / USD (mirrored from Robinhood Chain mainnet)";
    expect(questionFor({ feed: demo, strike: wad("1990"), closeTime })).toBe(`ETH above $1,990 at ${at}`);
    expect(questionFor({ feed: mirrored, strike: wad("371"), closeTime })).toBe(`Tesla above $371 at ${at}`);
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
    const word = (key: "yes" | "no" | null) => (key === null ? null : messages.round.sides[key]);
    expect(word(sideKey(Side.Up))).toBe("Yes");
    expect(word(sideKey(Side.Down))).toBe("No");
    expect(word(winnerKey("up"))).toBe("Yes");
    expect(word(winnerKey("down"))).toBe("No");
    expect(winnerKey(null)).toBeNull();
  });

  it("passes a question market's own words through untouched", () => {
    expect(questionFor({ feed: "Will it rain?", strike: 10n ** 18n, closeTime, isQuestion: true })).toBe(
      "Will it rain?",
    );
    expect(questionFor({ feed: " ", strike: 10n ** 18n, closeTime, isQuestion: true })).toBe(
      "An outcome somebody has to report",
    );
  });
});
