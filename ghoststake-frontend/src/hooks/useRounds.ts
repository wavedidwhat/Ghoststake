"use client";

import { useMemo } from "react";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { parimutuelRoundAbi } from "@/lib/abis";
import { env, marketConfigured } from "@/lib/env";
import type { Round } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";

/** How many of the most recent rounds to load. */
const WINDOW = 12;

const market = {
  address: env.marketAddress!,
  abi: parimutuelRoundAbi,
  chainId: activeChain.id,
} as const;

/**
 * The market's fixed parameters.
 *
 * Immutable on the contract, so fetched once and never revalidated — and read
 * from the chain rather than duplicated in the UI, because an entry cutoff the
 * frontend believes and the contract does not is a button that lies.
 */
export function useMarketParams() {
  const query = useReadContracts({
    contracts: [
      { ...market, functionName: "entryCutoff" },
      { ...market, functionName: "minSidePool" },
      { ...market, functionName: "rake" },
    ],
    query: { enabled: marketConfigured, staleTime: Infinity },
  });

  const [cutoff, minSide, rake] = query.data ?? [];
  return {
    isLoading: query.isLoading,
    entryCutoff: cutoff?.result as bigint | undefined,
    minSidePool: minSide?.result as bigint | undefined,
    rake: rake?.result as bigint | undefined,
  };
}

export type RoundWithId = Round & { id: bigint };

/**
 * The most recent rounds, newest first, with this wallet's stake in each.
 *
 * One multicall for the lot: a round's pools and the viewer's stake in it have
 * to come from the same block, or a payout quote is computed from figures that
 * never coexisted.
 */
export function useRounds() {
  const { address } = useConnection();

  const count = useReadContract({
    ...market,
    functionName: "roundCount",
    query: { enabled: marketConfigured, refetchInterval: 12_000 },
  });

  const ids = useMemo(() => {
    const total = count.data as bigint | undefined;
    if (total === undefined || total === 0n) return [];
    const out: bigint[] = [];
    for (let id = total; id > 0n && out.length < WINDOW; id -= 1n) out.push(id);
    return out;
  }, [count.data]);

  const rounds = useReadContracts({
    contracts: ids.flatMap((id) => [
      { ...market, functionName: "rounds", args: [id] } as const,
      { ...market, functionName: "phaseOf", args: [id] } as const,
    ]),
    query: { enabled: ids.length > 0, refetchInterval: 6_000 },
  });

  // Positions are a separate batch because they are only fetched when a wallet
  // is connected; folding them into the round batch would make every round
  // read depend on a connection.
  const positions = useReadContracts({
    contracts: ids.flatMap((id) => [
      { ...market, functionName: "stakeOf", args: [id, address!, 0] } as const,
      { ...market, functionName: "stakeOf", args: [id, address!, 1] } as const,
      { ...market, functionName: "claimableOf", args: [id, address!] } as const,
      { ...market, functionName: "claimed", args: [id, address!] } as const,
    ]),
    query: { enabled: ids.length > 0 && Boolean(address), refetchInterval: 6_000 },
  });

  const list = useMemo(() => {
    if (!rounds.data) return [];
    return ids.map((id, i) => {
      const round = rounds.data[i * 2]?.result as Round | undefined;
      const phase = rounds.data[i * 2 + 1]?.result as number | undefined;
      const up = positions.data?.[i * 4]?.result as bigint | undefined;
      const down = positions.data?.[i * 4 + 1]?.result as bigint | undefined;
      const claimable = positions.data?.[i * 4 + 2]?.result as bigint | undefined;
      const isClaimed = positions.data?.[i * 4 + 3]?.result as boolean | undefined;
      return round ? { id, round, phase, up, down, claimable, isClaimed } : undefined;
    }).filter((r): r is NonNullable<typeof r> => r !== undefined);
  }, [ids, rounds.data, positions.data]);

  return {
    isLoading: count.isLoading || rounds.isLoading,
    isError:
      count.isError || rounds.isError || rounds.data?.some((r) => r.status === "failure"),
    rounds: list,
    refetch: () => {
      void rounds.refetch();
      void positions.refetch();
      void count.refetch();
    },
  };
}
