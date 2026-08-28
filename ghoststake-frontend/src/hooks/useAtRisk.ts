"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAtRisk, type AtRiskResponse } from "@/lib/atRisk";
import { activeChain } from "@/lib/wagmi";

/**
 * Borrowers near or past the liquidation line.
 *
 * Refetched faster than the other API-backed views. Those read settled
 * history, which cannot change; this reads a race — every second of interest
 * moves a health factor, and a liquidator looking at a stale list is looking
 * at positions somebody else has already taken.
 */
export function useAtRisk(limit = 50) {
  const query = useQuery<AtRiskResponse>({
    queryKey: ["at-risk", activeChain.id, limit],
    queryFn: () => fetchAtRisk(limit),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  return {
    positions: query.data?.positions ?? [],
    block: query.data?.block,
    indexedBlock: query.data?.indexedBlock,
    scanned: query.data?.scanned ?? 0,
    truncated: query.data?.truncated ?? false,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
