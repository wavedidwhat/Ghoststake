"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import {
  aggregatorV3InterfaceAbi,
  chainlinkRoundOracleAbi,
  parimutuelRoundAbi,
} from "@/lib/abis";
import type { Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";

/** A feed self-describes as operator-driven. `DemoPriceFeed` puts this in
 *  `description()` for exactly this purpose — see its contract docs. */
const DEMO_MARKER = "GHOSTSTAKE DEMO FEED";

export type MarketFeed = {
  /** The feed's own `description()`: "ETH / USD" on a Chainlink aggregator. */
  description: string;
  isDemo: boolean;
};

/**
 * Where each market's settlement price actually comes from, read from the
 * chain rather than inferred from which environment variable the market's
 * address arrived in.
 *
 * Three hops, each one batched: `market.oracle()`, `oracle.feed()`,
 * `feed.description()`. It could be one env var instead, and that is precisely
 * the version worth avoiding — the one label a user must be able to trust is
 * "this price is set by hand", and a label that lives in the deployer's
 * environment is a label that can be wrong while the app looks fine. Locally
 * every feed is operator-driven, and this hook says so without anyone having
 * to remember to configure it.
 *
 * Immutable all the way down — a market's oracle and an adapter's feed are
 * both constructor immutables — so this is fetched once and never revalidated.
 */
export function useMarketFeeds(markets: Market[]) {
  const oracles = useReadContracts({
    contracts: markets.map(
      (m: Market) =>
        ({
          address: m.address,
          abi: parimutuelRoundAbi,
          functionName: "oracle",
          chainId: activeChain.id,
        }) as const,
    ),
    query: { enabled: markets.length > 0, staleTime: Infinity },
  });

  const oracleAddresses = useMemo(
    () => (oracles.data ?? []).map((r: { result?: unknown }) => r.result as `0x${string}` | undefined),
    [oracles.data],
  );

  const feeds = useReadContracts({
    contracts: oracleAddresses.filter(Boolean).map(
      (address: `0x${string}` | undefined) =>
        ({
          address: address!,
          abi: chainlinkRoundOracleAbi,
          functionName: "feed",
          chainId: activeChain.id,
        }) as const,
    ),
    query: { enabled: oracleAddresses.some(Boolean), staleTime: Infinity },
  });

  const feedAddresses = useMemo(
    () => (feeds.data ?? []).map((r: { result?: unknown }) => r.result as `0x${string}` | undefined),
    [feeds.data],
  );

  const descriptions = useReadContracts({
    contracts: feedAddresses.filter(Boolean).map(
      (address: `0x${string}` | undefined) =>
        ({
          address: address!,
          abi: aggregatorV3InterfaceAbi,
          functionName: "description",
          chainId: activeChain.id,
        }) as const,
    ),
    query: { enabled: feedAddresses.some(Boolean), staleTime: Infinity },
  });

  // Indices line up with `markets` only while every hop resolves for every
  // market. A market whose oracle read failed drops out of the next batch, so
  // it is left absent here rather than picking up its neighbour's feed — a
  // mislabelled market is worse than an unlabelled one.
  const byMarket = useMemo(() => {
    const out = new Map<string, MarketFeed>();
    if (!descriptions.data) return out;
    if (oracleAddresses.some((a: unknown) => !a) || feedAddresses.some((a: unknown) => !a)) return out;

    markets.forEach((m, i) => {
      const description = descriptions.data?.[i]?.result as string | undefined;
      if (description === undefined) return;
      out.set(m.key, {
        description,
        isDemo: description.includes(DEMO_MARKER),
      });
    });
    return out;
  }, [descriptions.data, oracleAddresses, feedAddresses, markets]);

  return {
    isLoading: oracles.isLoading || feeds.isLoading || descriptions.isLoading,
    byMarket,
  };
}
