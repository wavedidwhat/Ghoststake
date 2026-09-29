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

/** Tab order. The words on them are `markets.categories.<category>` (GHO-118). */
export const CATEGORIES: readonly Category[] = ["crypto", "stocks", "questions", "other"];

/**
 * Crypto bases. Wrapped forms are listed because a feed may name the token
 * it prices rather than the asset.
 */
const CRYPTO = new Set([
  "BTC",
  "WBTC",
  "ETH",
  "WETH",
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
  return CATEGORIES.find((c) => c === value);
}

/**
 * Which logo stands for a market (GHO-102): the token behind the price.
 *
 * A Robinhood equity feed prices "RHTSLA", but the company people recognise
 * is TSLA, which is also the symbol the stock token itself reports and the
 * key `AssetLogo` knows it by. A question has no asset, so no logo: it gets
 * a neutral mark of its own rather than some brand its words mention.
 */
export function logoSymbolFor(feed: { description: string; isQuestion: boolean }): string | undefined {
  if (feed.isQuestion) return undefined;
  const base = baseAsset(feed.description);
  return /^RH[A-Z]{1,5}$/.test(base) ? base.slice(2) : base;
}

/**
 * Company names for the stock tickers the app has a mark for (GHO-114).
 * Proper nouns, so they live here as data rather than in the catalog.
 */
const COMPANIES: Record<string, string> = {
  TSLA: "Tesla",
  AMD: "AMD",
  AMZN: "Amazon",
  NFLX: "Netflix",
  PLTR: "Palantir",
};

/**
 * What a question is about, the way a person says it (GHO-114): "Tesla" for
 * the RHTSLA feed, "ETH" for ETH / USD. The feed's own label read "GHOSTSTAKE
 * DEMO FEED (operator-set price) - ETH" into every round title, because the
 * demo marker sits before the last " - " and nothing stripped it.
 */
export function subjectOf(description: string): string {
  const base = baseAsset(description);
  if (/^RH[A-Z]{1,5}$/.test(base)) {
    const ticker = base.slice(2);
    return COMPANIES[ticker] ?? ticker;
  }
  return base;
}

/**
 * A market's heading (GHO-114): "Tesla (TSLA)" for a stock, "ETH / USD" for a
 * pair. Undefined for a question, whose own words are its heading. The raw
 * feed label stays in the small print beside it.
 */
export function displayName(feed: { description: string; isQuestion: boolean }): string | undefined {
  if (feed.isQuestion) return undefined;
  const base = baseAsset(feed.description);
  if (/^RH[A-Z]{1,5}$/.test(base)) {
    const ticker = base.slice(2);
    return COMPANIES[ticker] ? `${COMPANIES[ticker]} (${ticker})` : ticker;
  }
  // The pair without the demo marker or a trailing note: "ETH / USD".
  const pair = (feed.description.split(" - ").pop() ?? feed.description).replace(/\s*\(.*\)\s*$/, "").trim();
  return pair || base;
}

/** The crypto bases, for the test that holds them to `AssetLogo`'s marks. */
export const CRYPTO_BASES: readonly string[] = [...CRYPTO];
