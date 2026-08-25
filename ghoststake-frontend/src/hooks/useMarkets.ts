"use client";

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { marketRegistryAbi } from "@/lib/abis";
import { env } from "@/lib/env";
import { envMarkets, type Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";

type Listing = {
  market: `0x${string}`;
  router: `0x${string}`;
  horizon: bigint;
  enabled: boolean;
};

/**
 * The markets this deployment offers.
 *
 * From `MarketRegistry.all()` where a registry is configured, and from the
 * environment where one is not. Both shapes are `Market[]`, so nothing above
 * this hook has to know which it got — which is the point: the Sepolia
 * deployment predates the registry and still has to work.
 *
 * # Why this is a hook and not a constant
 *
 * It used to be a constant, read out of `NEXT_PUBLIC_MARKET_ADDRESS` at
 * module load. That made adding a market a rebuild of the image and a
 * redeploy of the app, for what is conceptually one row. Now it is a read,
 * and adding a market is a transaction.
 *
 * The cost is that the list is briefly empty while the read is in flight,
 * where before it was there at import. Callers therefore have to distinguish
 * "loading" from "no markets" — `isLoading` exists for that, and rendering
 * "no markets are configured" during a pending read would be a lie about a
 * deployment that has plenty.
 */
export function useMarkets() {
  const registry = useReadContract({
    address: env.registryAddress,
    abi: marketRegistryAbi,
    functionName: "all",
    chainId: activeChain.id,
    // Listings change only when the owner sends a transaction, which is rare
    // and never during a session that matters. Refetched on mount rather than
    // polled.
    query: { enabled: Boolean(env.registryAddress), staleTime: 60_000 },
  });

  const markets = useMemo<Market[]>(() => {
    if (!env.registryAddress) return envMarkets();
    if (!registry.data) return [];

    return (registry.data as readonly Listing[]).map((listing) => ({
      key: listing.market.toLowerCase(),
      address: listing.market,
      router: listing.router,
      horizon: listing.horizon,
      enabled: listing.enabled,
      // Deliberately no hint. The registry stores no label, so the feed's own
      // `description()` is the only claim about a market's price source, and
      // `useMarketFeeds` is what reads it.
      kindHint: "unknown" as const,
    }));
  }, [registry.data]);

  return {
    markets,
    /** Markets to offer for browsing. A delisted one is still in `markets`,
     *  because someone holding a position in it has to be able to find it. */
    listed: useMemo(() => markets.filter((m) => m.enabled), [markets]),
    isLoading: Boolean(env.registryAddress) && registry.isLoading,
    isError: registry.isError,
    /** Which source answered, for surfaces that should say so. */
    source: env.registryAddress ? ("registry" as const) : ("env" as const),
  };
}
