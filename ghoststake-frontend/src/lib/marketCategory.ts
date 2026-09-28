/**
 * What kind of thing a market is about, for the tabs over the market list
 * (GHO-101).
 *
 * Derived from what the market already says about itself, not tagged by
 * hand. A hand-kept list of which market is a stock is a list that goes
 * stale the day someone adds a market, and a market filed under the wrong
 * tab is not merely hard to find, it is missing from the tab where the
 * reader looked.
 *
 * - A market settled by a claimed outcome (GHO-80) is a question.
 * - A Robinhood tokenized equity prices as `RH` + ticker ("RHTSLA / USD"),
 *   on mainnet and in our mirrored testnet feeds alike (GHO-21), so that
 *   prefix is a stock.
 * - A base asset on the crypto list is crypto.
 * - Anything else is `other`, rather than being guessed into crypto. A gold
 *   or FX feed filed under Crypto would be the wrong tab confidently shown.
 */

export type Category = "crypto" | "stocks" | "questions" | "other";

/** Tab order, and the words on them. */
export const CATEGORIES: readonly { value: Category; label: string }[] = [
  { value: "crypto", label: "Crypto" },
  { value: "stocks", label: "Stocks" },
  { value: "questions", label: "Questions" },
  { value: "other", label: "Other" },
];

/**
 * Crypto bases. Wrapped forms are listed because a feed may name the token
 * it prices rather than the asset.
 */
const CRYPTO = new Set([
  "BTC",
  "WBTC",
  "ETH",
  "WETH",
  "STETH",
  "SOL",
  "LINK",
  "ARB",
  "OP",
  "AVAX",
  "BNB",
  "DOGE",
  "XRP",
  "POL",
  "MATIC",
  "USDC",
  "USDT",
  "DAI",
]);

/**
 * The base asset a price feed names.
 *
 * "GHOSTSTAKE DEMO FEED (operator-set price) - RHTSLA / USD (mirrored from
 * Robinhood Chain mainnet)" → "RHTSLA". The demo marker sits before the last
 * " - ", which is how `MarketRow` already strips it for display. The pair is
 * then split on "/", and anything after the base is ignored.
 */
export function baseAsset(description: string): string {
  const pair = description.split(" - ").pop() ?? description;
  return pair.split("/")[0].trim().toUpperCase();
}

export function categoryOf(feed: { description: string; isQuestion: boolean }): Category {
  // A question's own words are not a feed label: never split them.
  if (feed.isQuestion) return "questions";

  const base = baseAsset(feed.description);
  if (/^RH[A-Z]{1,5}$/.test(base)) return "stocks";
  if (CRYPTO.has(base)) return "crypto";
  return "other";
}

/**
 * `?c=` from the URL, as a category, or undefined for "All".
 *
 * Anything unrecognised is "All" rather than an empty list: a stale or
 * hand-typed link should still show markets.
 */
export function parseCategory(value: string | undefined): Category | undefined {
  return CATEGORIES.find((c) => c.value === value)?.value;
}
