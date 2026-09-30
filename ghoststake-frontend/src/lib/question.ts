import { message, type Message } from "@/i18n/message";
import type { Format } from "./format";
import { subjectOf } from "./marketCategory";
import { Side, type SideValue } from "./rounds";

/**
 * A market as a question, and its two answers (GHO-78).
 *
 * Reported on 2026-09-19: *"I can't see where the bets like who would win the
 * world cup are — this app is so confusing."* A market here was an asset and a
 * direction, and a side was an arrow on a chart. The same round is a question
 * with a Yes and a No, and that is the only form anybody outside this codebase
 * thinks in.
 *
 * Up and Down stay in the contracts, where they are the enum the pools are
 * keyed by. This is the display layer: nothing below it changes.
 */

/**
 * Which answer a side is, as the key its word lives under:
 * `round.sides.<key>` ("Yes" / "No") in the catalog (GHO-118).
 */
export function sideKey(side: SideValue): "yes" | "no" {
  return side === Side.Up ? "yes" : "no";
}

/** The same, for the winner strings the API serves ("up" / "down"). */
export function winnerKey(winner: string | null | undefined): "yes" | "no" | null {
  if (winner === "up") return "yes";
  if (winner === "down") return "no";
  return null;
}

/**
 * The question a round is asking.
 *
 * Needs a strike, which only exists before lock on markets deployed since
 * GHO-79. Without one the honest phrasing is the one the old contract could
 * support — "higher at 14:30" — rather than inventing a level.
 *
 * `feed` is the feed's own description ("ETH / USD"), which is what the market
 * is about. It is trimmed to the asset where that reads better: "ETH above
 * $2,690" rather than "ETH / USD above $2,690".
 */
export function questionFor(input: {
  feed: string | undefined;
  strike: bigint | null | undefined;
  closeTime: bigint | number | undefined;
  /**
   * Set when this market settles a question rather than a price (GHO-91).
   *
   * `feed` then holds the oracle's own `question()` and is used verbatim: the
   * strike on such a round is the sentinel the outcome is compared against
   * (1e18), not a price level, so deriving a sentence from it would render
   * "Brazil win the World Cup" as "Brazil above $1.00 at 14:30".
   */
  isQuestion?: boolean;
  /** The strike and the close time in the reader's language (GHO-128). */
  format: Format;
}): Message {
  if (input.isQuestion) {
    // The contract's own words, or nothing. An event market with no readable
    // question is a market nobody should be shown a made-up sentence for.
    // The contract's words are passed through as they are: they are the
    // market's data, not the app's copy.
    const own = input.feed?.trim();
    return own ? message("question.asked", { text: own }) : message("question.unnamed");
  }

  // No feed yet: the sentence names "the price" in place of an asset.
  const asset = assetOf(input.feed);
  const at = input.closeTime === undefined ? null : timeOf(input.closeTime, input.format);

  if (input.strike === null || input.strike === undefined || input.strike === 0n) {
    if (!asset) return at ? message("question.priceHigherAt", { at }) : message("question.priceHigherAtClose");
    return at ? message("question.higherAt", { asset, at }) : message("question.higherAtClose", { asset });
  }

  const level = `$${input.format.formatAmount(input.strike, 18, strikeDigits(input.strike))}`;
  if (!asset) return at ? message("question.priceAboveAt", { level, at }) : message("question.priceAbove", { level });
  return at ? message("question.aboveAt", { asset, level, at }) : message("question.above", { asset, level });
}

/**
 * "ETH / USD" is about ETH; the RHTSLA feed is about Tesla (GHO-114). Null
 * with no feed.
 */
function assetOf(feed: string | undefined): string | null {
  if (!feed) return null;
  return subjectOf(feed) || feed;
}

/** Local time, because the person reading it is deciding whether to wait. */
function timeOf(closeTime: bigint | number, format: Format): string {
  const seconds = typeof closeTime === "bigint" ? Number(closeTime) : closeTime;
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return format.formatClock(seconds * 1000);
}

/**
 * Cents only where they carry information. "$2,690.00" reads as a machine
 * reading; "$2,690" reads as a question. Sub-unit prices keep their decimals,
 * because that is where the whole number lives.
 */
function strikeDigits(strike: bigint): number {
  const whole = strike / 10n ** 18n;
  if (whole === 0n) return 4;
  if (whole < 100n) return 2;
  return strike % 10n ** 18n === 0n ? 0 : 2;
}

/**
 * How a position's side reads in a list: the key under `round.taken`
 * ("yes", "no", "both", "none").
 *
 * Takes the ledger's own words rather than the contract enum, because that is
 * what the API serves — and keeps the two list views (cards on a phone, a
 * table on a desktop) from drifting into different vocabularies.
 */
export function takenKey(taken: "up" | "down" | "both" | "none"): "yes" | "no" | "both" | "none" {
  switch (taken) {
    case "up":
      return "yes";
    case "down":
      return "no";
    default:
      return taken;
  }
}
