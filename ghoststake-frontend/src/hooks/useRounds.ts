"use client";

import { useMemo } from "react";
import { useConnection, useReadContracts } from "wagmi";
import { parimutuelRoundAbi } from "@/lib/abis";
import { markets, marketsConfigured, type Market } from "@/lib/markets";
import type { Round } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";

/** How many of the most recent rounds to load, per market. */
const WINDOW = 12;

const base = { abi: parimutuelRoundAbi, chainId: activeChain.id } as const;

export type MarketParams = {
  entryCutoff: bigint;
  minSidePool: bigint;
  rake: bigint;
};

/**
 * Each market's fixed parameters, keyed by market.
 *
 * Immutable on the contracts, so fetched once and never revalidated — and read
 * from the chain rather than duplicated in the UI, because an entry cutoff the
 * frontend believes and the contract does not is a button that lies.
 *
 * Read per market rather than once: the demo market is deployed from the same
 * script with the same arguments today, but "the parameters happen to match"
 * is not something a UI should assume on a user's behalf.
 */
export function useMarketParams() {
  const query = useReadContracts({
    contracts: markets.flatMap((m) => [
      { ...base, address: m.address, functionName: "entryCutoff" } as const,
      { ...base, address: m.address, functionName: "minSidePool" } as const,
      { ...base, address: m.address, functionName: "rake" } as const,
    ]),
    query: { enabled: marketsConfigured, staleTime: Infinity },
  });

  const byMarket = useMemo(() => {
    const out = new Map<string, MarketParams>();
    if (!query.data) return out;
    markets.forEach((m, i) => {
      const cutoff = query.data[i * 3]?.result as bigint | undefined;
      const minSide = query.data[i * 3 + 1]?.result as bigint | undefined;
      const rake = query.data[i * 3 + 2]?.result as bigint | undefined;
      if (cutoff === undefined || minSide === undefined || rake === undefined) return;
      out.set(m.key, { entryCutoff: cutoff, minSidePool: minSide, rake });
    });
    return out;
  }, [query.data]);

  return { isLoading: query.isLoading, byMarket };
}

/** A round, the market it belongs to, and this wallet's stake in it. */
export type MarketRound = {
  market: Market;
  id: bigint;
  round: Round;
  phase: number | undefined;
  up: bigint | undefined;
  down: bigint | undefined;
  claimable: bigint | undefined;
  isClaimed: boolean | undefined;
};

/**
 * The most recent rounds across every configured market, with this wallet's
 * stake in each.
 *
 * One multicall for the lot: a round's pools and the viewer's stake in it have
 * to come from the same block, or a payout quote is computed from figures that
 * never coexisted. Batching across markets rather than per market keeps that
 * property when there is more than one — two independent hooks would refetch
 * on their own timers, and the pipeline summary would add up numbers from two
 * different blocks.
 *
 * Round ids restart at 1 in each market, so nothing here keys on `id` alone.
 */
export function useRounds() {
  const { address } = useConnection();

  const counts = useReadContracts({
    contracts: markets.map(
      (m) => ({ ...base, address: m.address, functionName: "roundCount" }) as const,
    ),
    query: { enabled: marketsConfigured, refetchInterval: 12_000 },
  });

  // Flat, so the two batches below index straight into it.
  const keys = useMemo(() => {
    const out: { market: Market; id: bigint }[] = [];
    markets.forEach((m, i) => {
      const total = counts.data?.[i]?.result as bigint | undefined;
      if (total === undefined || total === 0n) return;
      let taken = 0;
      for (let id = total; id > 0n && taken < WINDOW; id -= 1n, taken += 1) {
        out.push({ market: m, id });
      }
    });
    return out;
  }, [counts.data]);

  const rounds = useReadContracts({
    contracts: keys.flatMap(({ market, id }) => [
      { ...base, address: market.address, functionName: "rounds", args: [id] } as const,
      { ...base, address: market.address, functionName: "phaseOf", args: [id] } as const,
    ]),
    query: { enabled: keys.length > 0, refetchInterval: 6_000 },
  });

  // Positions are a separate batch because they are only fetched when a wallet
  // is connected; folding them into the round batch would make every round
  // read depend on a connection.
  const positions = useReadContracts({
    contracts: keys.flatMap(({ market, id }) => [
      { ...base, address: market.address, functionName: "stakeOf", args: [id, address!, 0] } as const,
      { ...base, address: market.address, functionName: "stakeOf", args: [id, address!, 1] } as const,
      { ...base, address: market.address, functionName: "claimableOf", args: [id, address!] } as const,
      { ...base, address: market.address, functionName: "claimed", args: [id, address!] } as const,
    ]),
    query: { enabled: keys.length > 0 && Boolean(address), refetchInterval: 6_000 },
  });

  const list = useMemo<MarketRound[]>(() => {
    if (!rounds.data) return [];
    return keys
      .map(({ market, id }, i) => {
        const round = rounds.data[i * 2]?.result as Round | undefined;
        if (!round) return undefined;
        return {
          market,
          id,
          round,
          phase: rounds.data[i * 2 + 1]?.result as number | undefined,
          up: positions.data?.[i * 4]?.result as bigint | undefined,
          down: positions.data?.[i * 4 + 1]?.result as bigint | undefined,
          claimable: positions.data?.[i * 4 + 2]?.result as bigint | undefined,
          isClaimed: positions.data?.[i * 4 + 3]?.result as boolean | undefined,
        };
      })
      .filter((r): r is MarketRound => r !== undefined);
  }, [keys, rounds.data, positions.data]);

  return {
    isLoading: counts.isLoading || rounds.isLoading,
    isError:
      counts.isError || rounds.isError || rounds.data?.some((r) => r.status === "failure"),
    rounds: list,
    refetch: () => {
      void rounds.refetch();
      void positions.refetch();
      void counts.refetch();
    },
  };
}
