import { describe, expect, it } from "vitest";
import { baseAsset, categoryOf, parseCategory } from "../marketCategory";

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
