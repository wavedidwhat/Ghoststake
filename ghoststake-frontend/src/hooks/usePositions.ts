"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { parimutuelRoundAbi } from "@/lib/abis";
import {
  fetchPositions,
  isUnclaimed,
  type Position,
  type PositionsResponse,
} from "@/lib/positions";
import { activeChain } from "@/lib/wagmi";

/** Key for a round. The pair, never the id — ids restart at 1 per market. */
export function roundKey(position: Position): string {
  return `${position.round.market.toLowerCase()}:${position.round.id}`;
}

/**
 * One address's round positions, from the API.
 *
 * A plain `useQuery` rather than the `useInfiniteQuery` the activity feed
 * uses, because this endpoint takes a `limit` and returns everything under it
 * in one response — there is no cursor to page on. If the history outgrows a
 * single request, the endpoint grows a cursor first and this follows.
 */
export function usePositions(address: string | undefined, limit = 100) {
  const query = useQuery<PositionsResponse>({
    queryKey: ["positions", activeChain.id, address, limit],
    queryFn: () => fetchPositions(address!, { limit }),
    enabled: Boolean(address),
    // The indexer is behind the head by design, so refetching faster than it
    // writes buys nothing. Roughly a block time.
    staleTime: 15_000,
  });

  return {
    open: query.data?.open ?? [],
    history: query.data?.history ?? [],
    indexedBlock: query.data?.indexedBlock,
    asOf: query.data?.asOf,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The chain's answer for the positions the API says are unclaimed.
 *
 * This is the one place the page cannot rely on the indexer, and it is worth
 * being explicit about why rather than treating it as belt-and-braces.
 *
 * The API is `INDEXER_CONFIRMATIONS` behind the head. For everything else on
 * this page that costs nothing — a settled round does not change, so a stale
 * reading of it is simply an old reading of a fixed fact. A claim is different:
 * the moment someone claims, the API keeps saying "unclaimed" until the
 * indexer catches up. Offering a Claim button on that answer means offering a
 * transaction that reverts, and charging the user gas to find out.
 *
 * So the listing comes from the API — deep, complete, one request — and the
 * small actionable subset is confirmed against the chain before a button is
 * put in front of anyone. That subset is normally zero to a handful of rounds,
 * which is why this does not reintroduce the multicall the page was built to
 * remove: it scales with unclaimed wins, not with history.
 */
export function useClaimConfirmation(positions: Position[], address: string | undefined) {
  const pending = useMemo(() => positions.filter(isUnclaimed), [positions]);

  const reads = useReadContracts({
    contracts: pending.flatMap((p) => [
      {
        address: p.round.market as `0x${string}`,
        abi: parimutuelRoundAbi,
        chainId: activeChain.id,
        functionName: "claimableOf",
        args: [BigInt(p.round.id), address as `0x${string}`],
      } as const,
      {
        address: p.round.market as `0x${string}`,
        abi: parimutuelRoundAbi,
        chainId: activeChain.id,
        functionName: "claimed",
        args: [BigInt(p.round.id), address as `0x${string}`],
      } as const,
    ]),
    query: {
      enabled: pending.length > 0 && Boolean(address),
      refetchInterval: 12_000,
    },
  });

  const confirmed = useMemo(() => {
    const out = new Map<string, bigint>();
    if (!reads.data) return out;
    pending.forEach((p, i) => {
      const claimable = reads.data?.[i * 2]?.result as bigint | undefined;
      const claimed = reads.data?.[i * 2 + 1]?.result as boolean | undefined;
      if (claimable === undefined || claimed === undefined) return;
      out.set(roundKey(p), claimed ? 0n : claimable);
    });
    return out;
  }, [pending, reads.data]);

  return {
    /**
     * What the chain says is claimable, keyed by round. A missing key means
     * the chain has not answered yet — which is not the same as zero, and the
     * page must not render it as such.
     */
    confirmed,
    isLoading: reads.isLoading,
    // Surfaced rather than swallowed. A failed read leaves every entry
    // undefined forever, and a page that waits on it shows a skeleton with
    // nothing behind it — the bug the lend page shipped with.
    isError: reads.isError || reads.data?.some((r) => r.status === "failure"),
    refetch: reads.refetch,
    pendingCount: pending.length,
  };
}
