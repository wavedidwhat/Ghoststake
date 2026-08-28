"use client";

import { erc20Abi } from "viem";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { collateralVaultAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { activeChain } from "@/lib/wagmi";

/**
 * Decimals and symbol of the vault's underlying asset, read rather than
 * assumed — USDC is 6, and formatting it as 18 is wrong by 10^12.
 *
 * Note this cannot use the vault's own `decimals()`: it is an ERC-4626, so
 * that returns share decimals (the asset's plus a 6-place offset).
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
    // Immutable for a deployment, so fetched once and never revalidated.
    query: { enabled: Boolean(asset.data), staleTime: Infinity },
  });

  const [decimals, symbol] = token.data ?? [];
  return {
    address: asset.data as `0x${string}` | undefined,
    decimals: decimals?.result as number | undefined,
    symbol: (symbol?.result as string | undefined) ?? "",
    isLoading: asset.isLoading || token.isLoading,
    // Surfaced for the same reason the position's own errors are: `decimals`
    // gates every figure on the page, so a failed read here is a skeleton
    // that never resolves rather than an error a user can retry.
    isError: asset.isError || token.isError || token.data?.some((r) => r.status === "failure"),
  };
}

/**
 * A user's vault position.
 *
 * Batched into one multicall so every figure resolves at the same block
 * height. Separate hooks would land at different heights, making a health
 * factor inconsistent with the lien shown beside it.
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
      // The ledger's own figure, beside the capped one. The two together are
      // the only way the UI can tell "you have earned this" from "the ledger
      // credits this and nothing funds it" — see lib/stake.ts and GHO-55.
      { ...vault, functionName: "totalLedgerValue", args },
      { ...vault, functionName: "lienOf", args },
      { ...vault, functionName: "healthFactor", args },
      { ...vault, functionName: "maxBorrowable", args },
      { ...vault, functionName: "isLiquidatable", args },
      { ...vault, functionName: "balanceOf", args },
      // Immutable risk parameter, but read here so the health-factor preview
      // computes with the same threshold the contract enforces rather than a
      // constant the UI believes.
      { ...vault, functionName: "liquidationThreshold" },
      // The rate the stake earns. Read rather than written into copy — a rate
      // the UI believes and the contract does not is the same bug as a
      // hardcoded entry cutoff.
      { ...vault, functionName: "yieldRatePerSecond" },
    ],
    query: {
      enabled,
      // Arbitrum blocks are sub-second; interest accrues per second. 12s
      // keeps a health factor near the line moving without polling per block.
      refetchInterval: 12_000,
    },
  });

  const [
    collateral,
    yieldAccrued,
    ledgerValue,
    lien,
    healthFactor,
    maxBorrowable,
    liquidatable,
    shares,
    threshold,
    yieldRate,
  ] = query.data ?? [];

  return {
    enabled,
    isLoading: query.isLoading || asset.isLoading,
    // Surfaced so callers render an error rather than zero: an empty position
    // and an unreadable one look identical but mean opposite things.
    isError: asset.isError || query.isError || query.data?.some((r) => r.status === "failure"),
    refetch: query.refetch,
    assetAddress: asset.address,
    decimals: asset.decimals,
    symbol: asset.symbol,
    collateralValue: collateral?.result as bigint | undefined,
    accruedYield: yieldAccrued?.result as bigint | undefined,
    totalLedgerValue: ledgerValue?.result as bigint | undefined,
    lien: lien?.result as bigint | undefined,
    healthFactor: healthFactor?.result as bigint | undefined,
    maxBorrowable: maxBorrowable?.result as bigint | undefined,
    isLiquidatable: liquidatable?.result as boolean | undefined,
    shares: shares?.result as bigint | undefined,
    liquidationThreshold: threshold?.result as bigint | undefined,
    yieldRatePerSecond: yieldRate?.result as bigint | undefined,
  };
}
