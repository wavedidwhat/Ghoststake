import { message, type Message } from "@/i18n/message";
import { formatSignedPercent } from "./format";
import { Side, type SideValue } from "./rounds";

/**
 * Where the price sits against a round's strike (GHO-64).
 *
 * The one thing everybody looks at on a price bet, and nothing in the app
 * showed it: the card rendered the strike only *after* lock, and no live
 * price at all, so a visitor could see the pools and the payouts without
 * being able to tell which way the thing was going.
 *
 * All of it in 18 decimals, which is the adapter's scale and the scale a
 * strike is stored in — see `useSpot` for why the price is read through the
 * oracle rather than off the aggregator.
 */

export type Standing = {
  /** Which side is currently winning, or null with no strike to compare to. */
  leading: SideValue | null;
  /**
   * How far the price is from the strike, in basis points, signed.
   *
   * Basis points rather than a float: a percentage of a bigint has to be
   * computed in integers to stay exact, and a round is decided by a strict
   * comparison that a rounded percentage would misreport at the boundary.
   */
  bps: number | null;
};

/**
 * How the round currently stands.
 *
 * `Side.Up` wins when the close is **strictly above** the strike, which is the
 * contract's own comparison — so a price exactly on the strike is Down, and
 * this says so rather than rounding it to a tie that does not exist.
 */
export function standingOf(spot: bigint | undefined, strike: bigint | undefined): Standing {
  if (spot === undefined || strike === undefined || strike === 0n || spot === 0n) {
    return { leading: null, bps: null };
  }

  const diff = spot - strike;
  // Truncates toward zero, so a move smaller than a basis point reads as 0
  // rather than as a rounded-up move that did not happen. The side is decided
  // by `diff`, not by `bps`, so a sub-basis-point move still reports the
  // correct leader.
  const bps = Number((diff * 10_000n) / strike);

  return { leading: diff > 0n ? Side.Up : Side.Down, bps };
}

/** The move as a percentage string, e.g. "+0.42%". */
export function formatMove(bps: number): string {
  return formatSignedPercent(bps / 100);
}

/**
 * Whether a move is close enough that the leader could plausibly flip.
 *
 * Used to soften the claim on screen: "Yes is ahead" is a fact about this
 * instant, and stating it the same way at +0.01% and at +4% would be
 * misleading in one of those cases. A tenth of a percent is a move an
 * ETH/USD feed makes several times an hour.
 */
export function isNarrow(bps: number): boolean {
  return Math.abs(bps) < 10;
}

/**
 * How old a price is, in seconds, or null when either end is unknown.
 *
 * `now` is passed in rather than read from the clock so that a card rendered
 * on the server and the same card rendered in the browser agree — the app's
 * one clock is `useNow` (GHO-44), and a second one here would hydrate
 * differently.
 */
export function priceAge(updatedAt: bigint | undefined, now: bigint | undefined): number | null {
  if (updatedAt === undefined || now === undefined) return null;
  const age = Number(now - updatedAt);
  // A print stamped in the future is a clock disagreement, not a negative
  // age. Clamped, because "printed in −3 minutes" is nonsense on screen and
  // the honest reading is "as recently as we can tell".
  return age < 0 ? 0 : age;
}

/**
 * The age of a price, in words, for a feed that publishes about hourly.
 *
 * Deliberately coarse. A per-second countdown next to a number that only
 * changes once an hour implies the number is moving, which is the exact
 * misreading this label exists to prevent.
 */
export function formatAge(seconds: number): Message {
  if (seconds < 90) return message("age.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return message("age.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return message("age.hours", { hours });
  return message("age.hoursMinutes", { hours, minutes: rest });
}

/**
 * Whether a price is old enough that it should not be read as "the price".
 *
 * The live ETH/USD feed publishes on an hourly heartbeat, so twenty minutes
 * is entirely normal and not worth flagging. Past about half the heartbeat
 * the figure is better described as the last print than as the current price,
 * and the wording on the card changes accordingly.
 */
export function isStalePrint(seconds: number): boolean {
  return seconds >= 30 * 60;
}
