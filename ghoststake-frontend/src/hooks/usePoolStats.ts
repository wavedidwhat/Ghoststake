"use client";

import { useReadContracts } from "wagmi";
import { borrowLiquidityPoolAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { activeChain } from "@/lib/wagmi";

/**
 * Protocol-level pool state, shared by every user.
 *
 * Batched into one multicall so utilization is consistent with the supplied
 * and borrowed figures it is derived from — read separately they can land at
 * different block heights and visibly disagree.
 */
export function usePoolStats() {
  const pool = {
    address: env.poolAddress!,
    abi: borrowLiquidityPoolAbi,
    chainId: activeChain.id,
  } as const;

  const query = useReadContracts({
    contracts: [
      { ...pool, functionName: "totalSupplied" },
      { ...pool, functionName: "totalBorrowed" },
      { ...pool, functionName: "utilization" },
      { ...pool, functionName: "borrowRatePerSecond" },
    ],
    query: { enabled: contractsConfigured, refetchInterval: 12_000 },
  });

  const [supplied, borrowed, utilization, borrowRate] = query.data ?? [];

  return {
    isLoading: query.isLoading,
    isError: query.isError || query.data?.some((r) => r.status === "failure"),
    totalSupplied: supplied?.result as bigint | undefined,
    totalBorrowed: borrowed?.result as bigint | undefined,
    utilization: utilization?.result as bigint | undefined,
    borrowRatePerSecond: borrowRate?.result as bigint | undefined,
  };
}
