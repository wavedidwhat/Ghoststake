import type { MarketParams, MarketRound } from "@/hooks/useRounds";
import type { Market } from "./markets";
import { Phase } from "./rounds";

/**
 * A market as the browsing list shows it: what it prices, and what is
 * currently at stake on it.
 */
export type Summary = {
  market: Market;
  params: MarketParams | undefined;
  /** The round someone could act on: the newest one not yet settled. */
  live: MarketRound | undefined;
  /** Both pools added up, which is what "activity" means here. */
  volume: bigint;
};

export function summarise(
  market: Market,
  rounds: MarketRound[],
  params: MarketParams | undefined,
): Summary {
  // `rounds` arrives newest-first per market, so the first unsettled one is
  // the current round rather than an old one that happens to still be open.
  const live = rounds.find(
    (r) => r.market.key === market.key && r.phase !== Phase.Resolved && r.phase !== Phase.Void,
  );
  return {
    market,
    params,
    live,
    volume: live ? live.round.upPool + live.round.downPool : 0n,
  };
}

/**
 * Sorted by what is actually happening, not by name.
 *
 * A market with a live round outranks one without, and among live ones the
 * bigger pool leads — that is what "activity" means to someone deciding where
 * to look first. Ties fall back to the market's address so the order is
 * stable between renders rather than shuffling every time a pool moves.
 */
export function byActivity(a: Summary, b: Summary): number {
  if (Boolean(a.live) !== Boolean(b.live)) return a.live ? -1 : 1;
  if (a.volume !== b.volume) return a.volume > b.volume ? -1 : 1;
  return a.market.key < b.market.key ? -1 : 1;
}

/** Seconds as an operator would say them: "5m", "1h", "24h". */
export function formatHorizon(seconds: bigint): string {
  if (seconds % 3600n === 0n) return `${seconds / 3600n}h`;
  if (seconds % 60n === 0n) return `${seconds / 60n}m`;
  return `${seconds}s`;
}
