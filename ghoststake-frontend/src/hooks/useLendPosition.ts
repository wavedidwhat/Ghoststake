"use client";

import { erc20Abi } from "viem";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { borrowLiquidityPoolAbi } from "@/lib/abis";
import { env, poolConfigured } from "@/lib/env";
import { activeChain } from "@/lib/wagmi";

/**
 * The lending pool, and the connected wallet's place in it.
 *
 * Split into two queries on purpose rather than one. The pool half is public
 * — utilization, the rates, what is supplied and borrowed — and reads the
 * same for everybody, so it is fetched with or without a wallet. The user
 * half needs an address and is enabled only once there is one.
 *
 * Each half is a single multicall, so every figure inside it resolves at one
 * block height. Reading utilization separately from the supplied and borrowed
 * figures it is derived from lets them land at different heights and visibly
 * disagree.
 */

/**
 * The pool's own asset, read rather than inherited from the vault.
 *
 * They are the same token on every deployment so far, but nothing in the
 * contracts requires it: `BorrowLiquidityPool` takes an asset in its
 * constructor and never consults the vault. Formatting supply balances with
 * the vault's decimals would be a plausible number wrong by a factor of
 * 10^12 the first time that stops being true.
 */
function usePoolAsset() {
  const asset = useReadContract({
    address: env.poolAddress,
    abi: borrowLiquidityPoolAbi,
    functionName: "asset",
    chainId: activeChain.id,
    query: { enabled: poolConfigured, staleTime: Infinity },
  });

  const token = useReadContracts({
    contracts: [
      { address: asset.data, abi: erc20Abi, functionName: "decimals", chainId: activeChain.id },
      { address: asset.data, abi: erc20Abi, functionName: "symbol", chainId: activeChain.id },
    ],
    query: { enabled: Boolean(asset.data), staleTime: Infinity },
  });

  const [decimals, symbol] = token.data ?? [];
  return {
    address: asset.data as `0x${string}` | undefined,
    decimals: decimals?.result as number | undefined,
    symbol: (symbol?.result as string | undefined) ?? "",
    isLoading: asset.isLoading || token.isLoading,
    // Surfaced, not swallowed. Every figure on the page is formatted against
    // these decimals, so the page renders a skeleton until they arrive — and
    // a failed read leaves `decimals` undefined forever, which is a loading
    // spinner that never resolves rather than an error anyone can act on.
    isError: asset.isError || token.isError || token.data?.some((r) => r.status === "failure"),
  };
}

export function useLendPosition() {
  const { address } = useConnection();
  const asset = usePoolAsset();

  const pool = {
    address: env.poolAddress!,
    abi: borrowLiquidityPoolAbi,
    chainId: activeChain.id,
  } as const;

  const shared = useReadContracts({
    contracts: [
      { ...pool, functionName: "totalSupplied" },
      { ...pool, functionName: "totalBorrowed" },
      { ...pool, functionName: "availableLiquidity" },
      { ...pool, functionName: "utilization" },
      { ...pool, functionName: "supplyRatePerSecond" },
      { ...pool, functionName: "borrowRatePerSecond" },
      // Immutable, but read rather than written into copy: a curve the UI
      // believes and the contract does not is the same class of bug as a
      // hardcoded entry cutoff.
      { ...pool, functionName: "kink" },
    ],
    query: { enabled: poolConfigured, refetchInterval: 12_000 },
  });

  const mine = useReadContracts({
    contracts: [{ ...pool, functionName: "balanceOfSupply", args: [address!] }],
    query: { enabled: poolConfigured && Boolean(address), refetchInterval: 12_000 },
  });

  const [supplied, borrowed, available, utilization, supplyRate, borrowRate, kink] =
    shared.data ?? [];
  const [balance] = mine.data ?? [];

  return {
    isLoading: shared.isLoading || asset.isLoading,
    // Surfaced so callers render an error rather than zero: an empty pool and
    // an unreadable one look identical and mean opposite things.
    isError:
      asset.isError || shared.isError || shared.data?.some((r) => r.status === "failure"),
    refetch: () => {
      void shared.refetch();
      void mine.refetch();
    },

    assetAddress: asset.address,
    decimals: asset.decimals,
    symbol: asset.symbol,

    totalSupplied: supplied?.result as bigint | undefined,
    totalBorrowed: borrowed?.result as bigint | undefined,
    availableLiquidity: available?.result as bigint | undefined,
    utilization: utilization?.result as bigint | undefined,
    supplyRatePerSecond: supplyRate?.result as bigint | undefined,
    borrowRatePerSecond: borrowRate?.result as bigint | undefined,
    kink: kink?.result as bigint | undefined,

    /** Undefined until a wallet is connected, which is not the same as zero. */
    balance: balance?.result as bigint | undefined,
  };
}
