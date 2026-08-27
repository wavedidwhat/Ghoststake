"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { collateralVaultAbi } from "@/lib/abis";
import { fetchActivity, type ActivityPage } from "@/lib/activity";
import { env } from "@/lib/env";
import { activeChain } from "@/lib/wagmi";

/**
 * One address's history, paged.
 *
 * `useInfiniteQuery` rather than a `useState` array of pages, because the
 * cursor contract maps onto it exactly: `getNextPageParam` is the server's
 * `nextCursor`, and "there is no next page" is that field being null. Hand
 * rolling the accumulation would mean reimplementing the deduplication and
 * the in-flight guard, and the failure mode of getting those wrong is a row
 * appearing twice — which on a history page reads as a duplicated
 * transaction.
 */
export function useActivity(address: string | undefined, pageSize = 50) {
  const query = useInfiniteQuery<ActivityPage>({
    queryKey: ["activity", activeChain.id, address, pageSize],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      fetchActivity(address!, { cursor: pageParam as string | null, limit: pageSize }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(address),
    // The indexer is behind the head by design, so there is nothing to gain
    // from refetching faster than it writes. Stale after a block time or so.
    staleTime: 15_000,
  });

  const pages = query.data?.pages ?? [];
  return {
    events: pages.flatMap((page) => page.events),
    // From the newest page: it is the most recent statement of how far the
    // indexer has read, and the older pages' copies are stale by definition.
    indexedBlock: pages[0]?.indexedBlock,
    asOf: pages[0]?.asOf,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
    refetch: query.refetch,
  };
}

/**
 * The decimals every amount on the page is formatted against.
 *
 * Two of them, and they are not the same number. The underlying asset has its
 * own decimals, and the vault's shares have `_decimalsOffset() = 6` more —
 * so a share amount rendered with the asset's decimals is wrong by a factor
 * of a million, and it is wrong in a way that looks like a plausible balance.
 *
 * Read from the contracts rather than assumed, for the same reason
 * `usePoolAsset` reads the pool's asset instead of inheriting the vault's:
 * the offset is a constant in the contract today and nothing forces it to
 * stay one.
 */
export function useActivityDecimals() {
  const asset = useReadContract({
    address: env.vaultAddress,
    abi: collateralVaultAbi,
    functionName: "asset",
    chainId: activeChain.id,
    query: { enabled: Boolean(env.vaultAddress), staleTime: Infinity },
  });

  const reads = useReadContracts({
    contracts: [
      { address: asset.data, abi: erc20Abi, functionName: "decimals", chainId: activeChain.id },
      { address: asset.data, abi: erc20Abi, functionName: "symbol", chainId: activeChain.id },
      {
        address: env.vaultAddress,
        abi: collateralVaultAbi,
        functionName: "decimals",
        chainId: activeChain.id,
      },
    ],
    query: { enabled: Boolean(asset.data), staleTime: Infinity },
  });

  const [assetDecimals, assetSymbol, shareDecimals] = reads.data ?? [];
  return {
    assetDecimals: assetDecimals?.result as number | undefined,
    assetSymbol: (assetSymbol?.result as string | undefined) ?? "",
    shareDecimals: shareDecimals?.result as number | undefined,
    isLoading: asset.isLoading || reads.isLoading,
    // Surfaced rather than swallowed, the lesson from the lend page's
    // permanent skeleton: a failed decimals read leaves the value undefined
    // forever, and a page that waits for it renders a loading animation with
    // nothing behind it and no way for anyone to tell.
    isError: asset.isError || reads.isError || reads.data?.some((r) => r.status === "failure"),
  };
}
