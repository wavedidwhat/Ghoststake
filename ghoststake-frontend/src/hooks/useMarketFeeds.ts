"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import {
  aggregatorV3InterfaceAbi,
  chainlinkRoundOracleAbi,
  eventRoundOracleAbi,
  parimutuelRoundAbi,
} from "@/lib/abis";
import type { Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";

/** A feed self-describes as operator-driven. `DemoPriceFeed` puts this in
 *  `description()` for exactly this purpose — see its contract docs. */
const DEMO_MARKER = "GHOSTSTAKE DEMO FEED";

/** A stand-in for a hop that did not resolve. Reads against it return no
 *  data, which is exactly the "absent" this hook already handles — and it
 *  keeps every batch the same length as `markets`, so indices stay aligned. */
const ZERO = "0x0000000000000000000000000000000000000000" as const;

export type MarketFeed = {
  /**
   * The feed's own `description()` ("ETH / USD"), or the oracle's own
   * `question()` on a market that settles a question instead (GHO-91).
   *
   * One field for both because it is the same slot in every sentence the app
   * builds: what this market is about, in the words of the contract that
   * decides it.
   */
  description: string;
  isDemo: boolean;
  /** True when this market is settled by a claimed outcome, not a price. */
  isQuestion: boolean;
  /** The oracle's address, for reading and acting on the claim. */
  oracle?: `0x${string}`;
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

  // Both shapes of oracle, asked at once. An event oracle has no `feed()` and
  // a price adapter has no `question()`, so exactly one of these answers per
  // market — and the one that reverts is the signal, not a failure.
  //
  // The bug this replaces mattered more than it looks: the feed read was
  // batched over `oracleAddresses.filter(Boolean)` and the result map was
  // abandoned wholesale if *any* address was missing. One event market on the
  // registry would therefore have left every price market unlabelled, which
  // is the same one-question-breaks-everything failure the keeper had.
  const feeds = useReadContracts({
    contracts: oracleAddresses.map(
      (address: `0x${string}` | undefined) =>
        ({
          address: address ?? ZERO,
          abi: chainlinkRoundOracleAbi,
          functionName: "feed",
          chainId: activeChain.id,
        }) as const,
    ),
    query: { enabled: oracleAddresses.some(Boolean), staleTime: Infinity },
  });

  const questions = useReadContracts({
    contracts: oracleAddresses.map(
      (address: `0x${string}` | undefined) =>
        ({
          address: address ?? ZERO,
          abi: eventRoundOracleAbi,
          functionName: "question",
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
    contracts: feedAddresses.map(
      (address: `0x${string}` | undefined) =>
        ({
          address: address ?? ZERO,
          abi: aggregatorV3InterfaceAbi,
          functionName: "description",
          chainId: activeChain.id,
        }) as const,
    ),
    query: { enabled: feedAddresses.some(Boolean), staleTime: Infinity },
  });

  // Per market, independently. Indices line up because nothing is filtered:
  // a market whose oracle could not be read is simply absent from the map,
  // and its neighbours are unaffected. A mislabelled market is worse than an
  // unlabelled one, and a market blanked by an unrelated market's shape is
  // worse than both.
  const byMarket = useMemo(() => {
    const out = new Map<string, MarketFeed>();
    markets.forEach((m, i) => {
      const oracle = oracleAddresses[i];
      if (!oracle) return;

      const question = questions.data?.[i]?.result as string | undefined;
      if (question) {
        out.set(m.key, { description: question, isDemo: false, isQuestion: true, oracle });
        return;
      }

      const description = descriptions.data?.[i]?.result as string | undefined;
      if (description === undefined) return;
      out.set(m.key, {
        description,
        isDemo: description.includes(DEMO_MARKER),
        isQuestion: false,
        oracle,
      });
    });
    return out;
  }, [descriptions.data, questions.data, oracleAddresses, markets]);

  return {
    isLoading: oracles.isLoading || feeds.isLoading || questions.isLoading || descriptions.isLoading,
    byMarket,
  };
}
