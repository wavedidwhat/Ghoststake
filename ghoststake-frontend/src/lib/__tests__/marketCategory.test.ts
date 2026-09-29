import { describe, expect, it } from "vitest";
import { CRYPTO_BASES, baseAsset, categoryOf, companyOf, displayName, logoSymbolFor, parseCategory, subjectOf } from "../marketCategory";
import { hasLogo } from "@/components/ui/AssetLogo";

// The strings are the real ones: the Chainlink descriptions, the label
// `scripts/deploy-network.sh` gives the mirrored feed, and the marker
// `DemoPriceFeed` puts in front of it.
const MIRRORED =
  "GHOSTSTAKE DEMO FEED (operator-set price) - RHTSLA / USD (mirrored from Robinhood Chain mainnet)";

describe("baseAsset", () => {
  it("reads the base of a plain Chainlink pair", () => {
    expect(baseAsset("ETH / USD")).toBe("ETH");
    expect(baseAsset("BTC / USD")).toBe("BTC");
  });

  it("strips the demo marker and the mirror's note", () => {
    expect(baseAsset(MIRRORED)).toBe("RHTSLA");
    expect(baseAsset("GHOSTSTAKE DEMO FEED (operator-set price) - ETH / USD")).toBe("ETH");
  });
});

describe("categoryOf", () => {
  it("files Robinhood equities under stocks, demo or not", () => {
    expect(categoryOf({ description: "RHTSLA / USD", isQuestion: false })).toBe("stocks");
    expect(categoryOf({ description: MIRRORED, isQuestion: false })).toBe("stocks");
    expect(categoryOf({ description: "RHAMZN / USD", isQuestion: false })).toBe("stocks");
  });

  it("files known crypto under crypto", () => {
    expect(categoryOf({ description: "ETH / USD", isQuestion: false })).toBe("crypto");
    expect(categoryOf({ description: "wBTC / USD", isQuestion: false })).toBe("crypto");
  });

  it("files a claimed outcome under questions, whatever its words say", () => {
    // A question can mention an asset, and can contain " - " and "/". It is
    // still a question, and must not be split like a feed label.
    const q = "Will ETH / USD close above $3,000 - on Friday?";
    expect(categoryOf({ description: q, isQuestion: true })).toBe("questions");
  });

  it("does not guess an unknown asset into crypto", () => {
    expect(categoryOf({ description: "XAU / USD", isQuestion: false })).toBe("other");
    // "RH" alone, or a long run of letters, is not a ticker.
    expect(categoryOf({ description: "RH / USD", isQuestion: false })).toBe("other");
    expect(categoryOf({ description: "RHODIUMX / USD", isQuestion: false })).toBe("other");
  });
});

describe("parseCategory", () => {
  it("accepts the four tabs", () => {
    expect(parseCategory("stocks")).toBe("stocks");
    expect(parseCategory("questions")).toBe("questions");
  });

  it("treats anything else as All rather than an empty list", () => {
    expect(parseCategory(undefined)).toBeUndefined();
    expect(parseCategory("Stocks")).toBeUndefined();
    expect(parseCategory("nonsense")).toBeUndefined();
  });
});

describe("logoSymbolFor (GHO-102)", () => {
  it("shows the company, not the Robinhood feed name", () => {
    expect(logoSymbolFor({ description: MIRRORED, isQuestion: false })).toBe("TSLA");
    expect(logoSymbolFor({ description: "RHAMZN / USD", isQuestion: false })).toBe("AMZN");
  });

  it("shows the coin for a crypto price", () => {
    expect(logoSymbolFor({ description: "ETH / USD", isQuestion: false })).toBe("ETH");
  });

  it("gives a question no brand, whatever it mentions", () => {
    expect(logoSymbolFor({ description: "Will TSLA / USD close higher?", isQuestion: true })).toBeUndefined();
  });

  it("has a real mark for every base it files under Crypto", () => {
    // Two lists in two files: the category rule and the logo table. A coin
    // added to one and not the other would show under Crypto as a ticker
    // in a grey circle, next to real marks.
    const missing = CRYPTO_BASES.filter((b) => !hasLogo(b));
    expect(missing).toEqual([]);
  });

  it("has a real mark for every stock the stock-loan vault lists", () => {
    for (const ticker of ["TSLA", "AMZN", "AMD", "PLTR", "NFLX"]) expect(hasLogo(ticker)).toBe(true);
  });
});

/**
 * What people call a market (GHO-114). Checked on the real labels the dev
 * stack serves, because the bug was a label nobody had put through the
 * function: every demo round was titled "GHOSTSTAKE DEMO FEED (operator-set
 * price) - ETH above $1,990".
 */
describe("displayName and subjectOf (GHO-114)", () => {
  const DEMO_ETH = "GHOSTSTAKE DEMO FEED (operator-set price) - ETH / USD";

  it("names a Robinhood stock by its company, not its token", () => {
    expect(displayName({ description: MIRRORED, isQuestion: false })).toBe("Tesla (TSLA)");
    expect(subjectOf(MIRRORED)).toBe("Tesla");
    expect(subjectOf("RHAMZN / USD")).toBe("Amazon");
  });

  it("keeps a stock it has no name for as its ticker, without the RH", () => {
    expect(displayName({ description: "RHXYZ / USD", isQuestion: false })).toBe("XYZ");
    expect(subjectOf("RHXYZ / USD")).toBe("XYZ");
  });

  it("strips the demo marker from a crypto pair", () => {
    expect(displayName({ description: DEMO_ETH, isQuestion: false })).toBe("ETH / USD");
    expect(subjectOf(DEMO_ETH)).toBe("ETH");
    expect(displayName({ description: "ETH / USD", isQuestion: false })).toBe("ETH / USD");
  });

  it("gives a question no name of its own: its words are the heading", () => {
    expect(displayName({ description: "Will it rain?", isQuestion: true })).toBeUndefined();
  });
});

/** The stock-loan page named Palantir by its token's name() (GHO-126). */
describe("companyOf", () => {
  it("names the company for a ticker the app knows", () => {
    expect(companyOf("PLTR")).toBe("Palantir");
    expect(companyOf("tsla")).toBe("Tesla");
  });

  it("is undefined for a ticker it doesn't, so the token's own name is used", () => {
    expect(companyOf("SPY")).toBeUndefined();
  });
});
