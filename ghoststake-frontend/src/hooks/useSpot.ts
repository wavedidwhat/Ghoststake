"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { aggregatorV3InterfaceAbi, chainlinkRoundOracleAbi, parimutuelRoundAbi } from "@/lib/abis";
import type { MarketFeed } from "@/hooks/useMarketFeeds";
import type { Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";

/**
 * What each market's asset is worth right now (GHO-64).
 *
 * Read through the market's own `ChainlinkRoundOracle.readLatest()` rather
 * than off the aggregator, for three reasons that all point the same way:
 *
 *  - **The scale already matches.** The adapter normalises to 18 decimals,
 *    which is the scale `lockPrice` is stored in — so the spot and the strike
 *    can be compared without anybody rescaling anything. Reading the
 *    aggregator means reading `decimals()` too and dividing, which is exactly
 *    the class of arithmetic GHO-86 was about.
 *  - **It is the same number the round will settle against.** A price taken
 *    from somewhere else could disagree with the contract, and the whole
 *    point of showing it is to say which side is ahead.
 *  - **`ok` is honest.** The adapter refuses a reading that is stale, or from
 *    behind a sequencer outage, or from a paused feed. That is information
 *    worth showing, not an error to swallow — a price nobody could settle on
 *    should not be rendered as a price.
 *
 * One call per market on top of the oracle lookup, refreshed on a timer. Not
 * cheap enough to be free, and cheap enough for a screen whose entire subject
 * is this number.
 *
 * **And when it was printed.** Measured on the live Sepolia ETH/USD feed on
 * 2026-09-25, the gaps between publications were 60, 61, 60, 60, 61, 60, 61,
 * 34 minutes — an hourly heartbeat with the odd deviation update in between.
 * Rounds here are an hour long. So the "current" price can easily be
 * fifty-nine minutes old, on a market whose whole subject is where that price
 * goes in the next hour. Showing it under the word "Now" would be the single
 * most misleading thing on the screen, so the print time is read too and the
 * age is shown beside the figure.
 */

export type Spot = {
  /** 18 decimals, the same scale as a round's strike. */
  price: bigint;
  /** False when the adapter would refuse this reading at settlement. */
  usable: boolean;
  /**
   * Unix seconds when the feed published this price, or undefined if the
   * aggregator round could not be read.
   *
   * Undefined is rendered as "no print time", never as "just now". An unknown
   * age on an hourly feed is not the same claim as a fresh one.
   */
  updatedAt?: bigint;
};

/** How often the spot is re-read. */
const REFRESH_MS = 15_000;

export function useSpot(markets: Market[], feeds?: Map<string, MarketFeed>) {
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
    // A market's oracle is a constructor immutable, so this never changes.
    query: { enabled: markets.length > 0, staleTime: Infinity },
  });

  const oracleAddresses = useMemo(
    () =>
      (oracles.data ?? []).map(
        (r: { result?: unknown }) => r.result as `0x${string}` | undefined,
      ),
    [oracles.data],
  );

  const latest = useReadContracts({
    // Not filtered, so index i is always market i. Filtering collapses the
    // indices and a market whose oracle failed to resolve would take its
    // neighbour's price — which is the bug GHO-91 found in `useMarketFeeds`,
    // and a wrong price is worse than an absent one.
    contracts: oracleAddresses.map(
      (address: `0x${string}` | undefined) =>
        ({
          address: address ?? ZERO,
          abi: chainlinkRoundOracleAbi,
          functionName: "readLatest",
          chainId: activeChain.id,
        }) as const,
    ),
    query: {
      enabled: oracleAddresses.some(Boolean),
      refetchInterval: REFRESH_MS,
    },
  });

  // When each of those prices was actually published.
  //
  // `readLatest` hands back the aggregator round its answer came from but not
  // that round's timestamp, so the round is read to get `updatedAt`. Same
  // no-filtering rule as above: index i is market i, and a market whose feed
  // did not resolve gets the zero address and comes back empty rather than
  // shifting its neighbours along.
  const prints = useReadContracts({
    contracts: markets.map((m: Market, i: number) => {
      const result = latest.data?.[i]?.result as readonly [boolean, bigint, bigint] | undefined;
      return {
        address: feeds?.get(m.key)?.feed ?? ZERO,
        abi: aggregatorV3InterfaceAbi,
        functionName: "getRoundData",
        args: [result?.[2] ?? 0n],
        chainId: activeChain.id,
      } as const;
    }),
    query: {
      enabled: Boolean(feeds) && (latest.data?.length ?? 0) > 0,
      refetchInterval: REFRESH_MS,
    },
  });

  const byMarket = useMemo(() => {
    const out = new Map<string, Spot>();
    markets.forEach((m, i) => {
      if (!oracleAddresses[i]) return;
      const result = latest.data?.[i]?.result as
        | readonly [boolean, bigint, bigint]
        | undefined;
      if (!result) return;

      const [ok, price] = result;
      // A zero price is not a price. The adapter returns `(false, 0, 0)` for a
      // feed that has never published, and rendering "$0.00" would read as a
      // crash rather than as an absence.
      if (price === 0n) return;

      // (roundId, answer, startedAt, updatedAt, answeredInRound). `updatedAt`
      // is the publication time; `startedAt` is when the round began
      // collecting, which is earlier and is not what was printed.
      const print = prints.data?.[i]?.result as
        | readonly [bigint, bigint, bigint, bigint, bigint]
        | undefined;
      // Zero means the round carries no timestamp, which Chainlink documents
      // as "do not use this answer". Dropped rather than shown as 1970.
      const updatedAt = print && print[3] > 0n ? print[3] : undefined;

      out.set(m.key, { price, usable: ok, updatedAt });
    });
    return out;
  }, [latest.data, prints.data, oracleAddresses, markets]);

  return {
    isLoading: oracles.isLoading || latest.isLoading,
    byMarket,
  };
}

/** A stand-in for an oracle that did not resolve; reads against it come back
 *  empty, which keeps every batch the same length as `markets`. */
const ZERO = "0x0000000000000000000000000000000000000000" as const;
