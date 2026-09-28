"use client";

import { useMarkets } from "@/hooks/useMarkets";
import { useRounds } from "@/hooks/useRounds";

/**
 * Everything this wallet can collect, across every market (GHO-69).
 *
 * Read from the chain rather than from the indexer: these figures fund a
 * transaction about to be signed, and `claimableOf` five blocks stale can
 * offer a claim that has already been collected. `useRounds` is already
 * batching them for the market pages, so this costs no extra call.
 *
 * Shared by the portfolio's claim panel and the notification bell (GHO-104),
 * so both count the same winnings.
 */
export function useClaimables() {
  const { markets } = useMarkets();
  const rounds = useRounds(markets);

  const claims = rounds.rounds
    .filter((r) => (r.claimable ?? 0n) > 0n && r.isClaimed !== true)
    .map((r) => ({ market: r.market.address, roundId: r.id, amount: r.claimable! }));

  return { claims, refetch: rounds.refetch };
}
