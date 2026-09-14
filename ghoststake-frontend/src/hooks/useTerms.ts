"use client";

import { useReadContracts } from "wagmi";
import { borrowLiquidityPoolAbi, collateralVaultAbi, parimutuelRoundAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import type { Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";

/**
 * The rules a position is actually governed by, read off the contracts.
 *
 * Every value here is a Solidity `immutable` or `constant`, so this is fetched
 * once per session and never revalidated — and, more to the point, it is
 * fetched at all. Before GHO-30 the deployed max LTV was 60%, the liquidation
 * threshold 80% and the liquidation bonus 5%, and a user could not learn any
 * of them without reading Solidity.
 *
 * Read rather than written into copy, for the reason the `yieldRatePerSecond`
 * read in `useVaultPosition` already gives: a term the UI believes and the
 * contract does not is the same class of bug as a hardcoded entry cutoff. It
 * is a worse one here, because these are the numbers that decide when somebody
 * loses collateral.
 */
export function useLendingTerms() {
  const vault = {
    address: env.vaultAddress!,
    abi: collateralVaultAbi,
    chainId: activeChain.id,
  } as const;

  const query = useReadContracts({
    contracts: [
      { ...vault, functionName: "yieldRatePerSecond" },
      { ...vault, functionName: "maxLTV" },
      { ...vault, functionName: "liquidationThreshold" },
      { ...vault, functionName: "liquidationBonus" },
      { ...vault, functionName: "closeFactor" },
      // Derived on chain from the threshold and the bonus, not configured.
      // Read rather than recomputed here: deriving it was how the contract
      // stopped two copies of the number drifting, and recomputing it in the
      // UI would reintroduce the second copy.
      { ...vault, functionName: "fullLiquidationThreshold" },
      {
        address: env.poolAddress!,
        abi: borrowLiquidityPoolAbi,
        chainId: activeChain.id,
        functionName: "kink",
      },
    ],
    query: { enabled: contractsConfigured, staleTime: Infinity },
  });

  const [yieldRate, maxLTV, threshold, bonus, closeFactor, fullLiquidation, kink] =
    query.data ?? [];

  return {
    isLoading: query.isLoading,
    isError: query.isError || query.data?.some((r) => r.status === "failure"),
    yieldRatePerSecond: yieldRate?.result as bigint | undefined,
    maxLTV: maxLTV?.result as bigint | undefined,
    liquidationThreshold: threshold?.result as bigint | undefined,
    liquidationBonus: bonus?.result as bigint | undefined,
    closeFactor: closeFactor?.result as bigint | undefined,
    fullLiquidationThreshold: fullLiquidation?.result as bigint | undefined,
    kink: kink?.result as bigint | undefined,
  };
}

export type RoundTerms = {
  market: `0x${string}`;
  rake: bigint | undefined;
  entryCutoff: bigint | undefined;
  minSidePool: bigint | undefined;
  lockWindow: bigint | undefined;
  resolveDeadline: bigint | undefined;
};

const ROUND_TERMS = ["rake", "entryCutoff", "minSidePool", "lockWindow", "resolveDeadline"] as const;

/**
 * Per-market round terms.
 *
 * One row per market rather than one set for the deployment, because these are
 * `ParimutuelRound` immutables and each market is its own deployment — two
 * markets in the same registry can genuinely carry different rakes and
 * different cutoffs. Showing one set and calling it "the" rake would be right
 * today and silently wrong the first time somebody lists a market on different
 * terms.
 */
export function useRoundTerms(markets: Market[]) {
  const query = useReadContracts({
    contracts: markets.flatMap((m) =>
      ROUND_TERMS.map(
        (functionName) =>
          ({
            address: m.address,
            abi: parimutuelRoundAbi,
            chainId: activeChain.id,
            functionName,
          }) as const,
      ),
    ),
    query: { enabled: markets.length > 0, staleTime: Infinity },
  });

  const terms: RoundTerms[] = markets.map((m, i) => {
    const at = (offset: number) => {
      const entry = query.data?.[i * ROUND_TERMS.length + offset];
      return entry?.status === "success" ? (entry.result as bigint) : undefined;
    };
    return {
      market: m.address,
      rake: at(0),
      entryCutoff: at(1),
      minSidePool: at(2),
      lockWindow: at(3),
      resolveDeadline: at(4),
    };
  });

  return { terms, isLoading: query.isLoading, isError: query.isError };
}
