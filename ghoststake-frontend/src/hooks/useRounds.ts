"use client";

import { useMemo } from "react";
import { useConnection, useReadContracts } from "wagmi";
import { parimutuelRoundAbi } from "@/lib/abis";
import type { Market } from "@/lib/markets";
import type { Round } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";

/** How many of the most recent rounds to load, per market. */
const WINDOW = 12;

const base = { abi: parimutuelRoundAbi, chainId: activeChain.id } as const;

export type MarketParams = {
  entryCutoff: bigint;
  minSidePool: bigint;
  rake: bigint;
  /** How late a lock may land before the round voids instead. */
  lockWindow: bigint;
  /** How long a locked round may go unsettled before it may be refunded. */
  resolveDeadline: bigint;
  /** Who may open and force-void rounds here. */
  owner: `0x${string}`;
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
export function useMarketParams(markets: Market[]) {
  const query = useReadContracts({
    contracts: markets.flatMap((m) => [
      { ...base, address: m.address, functionName: "entryCutoff" } as const,
      { ...base, address: m.address, functionName: "minSidePool" } as const,
      { ...base, address: m.address, functionName: "rake" } as const,
      // Only the operator console reads these three, but they belong in the
      // same batch: a console that read the timings separately would render
      // deadlines from one block against pools from another.
      { ...base, address: m.address, functionName: "lockWindow" } as const,
      { ...base, address: m.address, functionName: "resolveDeadline" } as const,
      { ...base, address: m.address, functionName: "owner" } as const,
    ]),
    query: { enabled: markets.length > 0, staleTime: Infinity },
  });

  const byMarket = useMemo(() => {
    const out = new Map<string, MarketParams>();
    if (!query.data) return out;
    const PER_MARKET = 6;
    markets.forEach((m, i) => {
      const at = (n: number) => query.data?.[i * PER_MARKET + n]?.result;
      const cutoff = at(0) as bigint | undefined;
      const minSide = at(1) as bigint | undefined;
      const rake = at(2) as bigint | undefined;
      const lockWindow = at(3) as bigint | undefined;
      const resolveDeadline = at(4) as bigint | undefined;
      const owner = at(5) as `0x${string}` | undefined;
      if (
        cutoff === undefined ||
        minSide === undefined ||
        rake === undefined ||
        lockWindow === undefined ||
        resolveDeadline === undefined ||
        owner === undefined
      ) {
        return;
      }
      out.set(m.key, {
        entryCutoff: cutoff,
        minSidePool: minSide,
        rake,
        lockWindow,
        resolveDeadline,
        owner,
      });
    });
    return out;
  }, [query.data, markets]);

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
 *
 * Stays on the chain rather than moving to `/api/v1/rounds`, which GHO-38 asked
 * to decide. The API returns the same information in one request and is cheaper
 * by every measure — but it is `INDEXER_CONFIRMATIONS` behind the head by
 * design, and every number this hook produces feeds a transaction the user is
 * about to sign. A pool split five blocks stale quotes odds that no longer
 * exist; an `entryOpen` computed server-side lets the stake button stay live
 * past the cutoff, which is the one piece of round state a UI can get wrong in
 * a way that costs a user gas. The lag is free on a settled round and not free
 * here.
 *
 * The historical read went to the API instead — see `lib/positions.ts`. That is
 * not two sources of truth for one number: it is two questions, each asked
 * where it can be answered. "What can I bet on now" is the chain's; "what
 * happened" is the indexer's, and the chain is worst at it.
 */
export function useRounds(markets: Market[]) {
  const { address } = useConnection();

  const counts = useReadContracts({
    contracts: markets.map(
      (m) => ({ ...base, address: m.address, functionName: "roundCount" }) as const,
    ),
    query: { enabled: markets.length > 0, refetchInterval: 12_000 },
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
  }, [counts.data, markets]);

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
