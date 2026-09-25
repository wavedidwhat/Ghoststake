import { formatAmount } from "./format";
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

/** What a side is called on screen. */
export function sideLabel(side: SideValue): "Yes" | "No" {
  return side === Side.Up ? "Yes" : "No";
}

/** The same, for the winner strings the API serves ("up" / "down"). */
export function winnerLabel(winner: string | null | undefined): "Yes" | "No" | null {
  if (winner === "up") return "Yes";
  if (winner === "down") return "No";
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
}): string {
  if (input.isQuestion) {
    // The contract's own words, or nothing. An event market with no readable
    // question is a market nobody should be shown a made-up sentence for.
    return input.feed?.trim() || "An outcome somebody has to report";
  }

  const asset = assetOf(input.feed);
  const at = input.closeTime === undefined ? null : timeOf(input.closeTime);

  if (input.strike === null || input.strike === undefined || input.strike === 0n) {
    return at ? `${asset} higher at ${at}` : `${asset} higher at the close`;
  }

  const level = `$${formatAmount(input.strike, 18, strikeDigits(input.strike))}`;
  return at ? `${asset} above ${level} at ${at}` : `${asset} above ${level}`;
}

/** "ETH / USD" is about ETH. A feed with no pair is used as it is. */
function assetOf(feed: string | undefined): string {
  if (!feed) return "The price";
  const [base] = feed.split("/");
  return base.trim() || feed;
}

/** Local time, because the person reading it is deciding whether to wait. */
function timeOf(closeTime: bigint | number): string {
  const seconds = typeof closeTime === "bigint" ? Number(closeTime) : closeTime;
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
 * How a position's side reads in a list: "yes", "no", "both" or "none".
 *
 * Takes the ledger's own words rather than the contract enum, because that is
 * what the API serves — and keeps the two list views (cards on a phone, a
 * table on a desktop) from drifting into different vocabularies.
 */
export function takenLabel(taken: "up" | "down" | "both" | "none"): string {
  switch (taken) {
    case "up":
      return "yes";
    case "down":
      return "no";
    default:
      return taken;
  }
}
