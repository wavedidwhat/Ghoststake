"use client";

import { erc20Abi } from "viem";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { collateralVaultAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { activeChain } from "@/lib/wagmi";

/**
 * The underlying asset's decimals and symbol, read from the chain.
 *
 * Never assumed. USDC is 6 decimals, not 18, so a hardcoded 18 renders every
 * balance wrong by a factor of 10^12 — and wrong in the flattering
 * direction, which is how it survives a glance. The vault's own `decimals()`
 * is no help either: it is an ERC-4626, so that returns *share* decimals
 * (asset + a 6-place offset), not the asset's.
 */
function useUnderlyingAsset() {
  const asset = useReadContract({
    address: env.vaultAddress,
    abi: collateralVaultAbi,
    functionName: "asset",
    chainId: activeChain.id,
    query: { enabled: contractsConfigured, staleTime: Infinity },
  });

  const token = useReadContracts({
    contracts: [
      { address: asset.data, abi: erc20Abi, functionName: "decimals", chainId: activeChain.id },
      { address: asset.data, abi: erc20Abi, functionName: "symbol", chainId: activeChain.id },
    ],
    // The asset address and its metadata are immutable for a deployment, so
    // this is fetched once and never revalidated.
    query: { enabled: Boolean(asset.data), staleTime: Infinity },
  });

  const [decimals, symbol] = token.data ?? [];
  return {
    decimals: decimals?.result as number | undefined,
    symbol: (symbol?.result as string | undefined) ?? "",
    isLoading: asset.isLoading || token.isLoading,
  };
}

/**
 * The four numbers GHO-11 asks for, plus the two that give them context.
 *
 * Batched through `useReadContracts` rather than six separate hooks: the
 * calls are multicalled into one RPC round trip, so every figure on screen
 * comes from the *same block*. Read separately they would land at different
 * heights, and a health factor computed at one block against a lien read at
 * another is exactly the kind of quietly-wrong number this screen exists to
 * prevent.
 */
export function useVaultPosition() {
  const { address } = useConnection();
  const asset = useUnderlyingAsset();
  const enabled = Boolean(address) && contractsConfigured;

  const vault = {
    address: env.vaultAddress!,
    abi: collateralVaultAbi,
    chainId: activeChain.id,
  } as const;
  const args = [address!] as const;

  const query = useReadContracts({
    contracts: [
      { ...vault, functionName: "collateralValue", args },
      { ...vault, functionName: "accruedYield", args },
      { ...vault, functionName: "lienOf", args },
      { ...vault, functionName: "healthFactor", args },
      { ...vault, functionName: "maxBorrowable", args },
      { ...vault, functionName: "isLiquidatable", args },
    ],
    query: {
      enabled,
      // Arbitrum blocks are sub-second, but interest accrues per second and
      // none of this is worth a request per block. 12s keeps a health factor
      // near the line visibly moving without hammering a public RPC.
      refetchInterval: 12_000,
    },
  });

  const [collateral, yieldAccrued, lien, healthFactor, maxBorrowable, liquidatable] =
    query.data ?? [];

  return {
    enabled,
    isLoading: query.isLoading || asset.isLoading,
    // A failed read must never render as zero: zero collateral and unknown
    // collateral look identical on screen and mean opposite things.
    isError: query.isError || query.data?.some((r) => r.status === "failure"),
    refetch: query.refetch,
    decimals: asset.decimals,
    symbol: asset.symbol,
    collateralValue: collateral?.result as bigint | undefined,
    accruedYield: yieldAccrued?.result as bigint | undefined,
    lien: lien?.result as bigint | undefined,
    healthFactor: healthFactor?.result as bigint | undefined,
    maxBorrowable: maxBorrowable?.result as bigint | undefined,
    isLiquidatable: liquidatable?.result as boolean | undefined,
  };
}
