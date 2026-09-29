"use client";

import { erc20Abi, maxUint256, type ContractFunctionParameters } from "viem";
import { useConnection, useReadContracts } from "wagmi";
import { aggregatorV3InterfaceAbi, borrowLiquidityPoolAbi, stockLoanVaultAbi } from "@/lib/abis";
import { env } from "@/lib/env";
import { companyOf } from "@/lib/marketCategory";
import { summarise, type StockCollateral } from "@/lib/stockLoan";
import { activeChain } from "@/lib/wagmi";

const vault = {
  address: env.stockVaultAddress!,
  abi: stockLoanVaultAbi,
  chainId: activeChain.id,
} as const;

/**
 * The stock-loan vault's fixed facts: its pool, stablecoin, fee and the
 * collateral list with each token's terms. Immutable for a deployment, so
 * read once.
 */
function useStockVaultConfig() {
  const enabled = Boolean(env.stockVaultAddress);

  const head = useReadContracts({
    contracts: [
      { ...vault, functionName: "pool" },
      { ...vault, functionName: "stable" },
      { ...vault, functionName: "stableDecimals" },
      { ...vault, functionName: "originationFee" },
      { ...vault, functionName: "collateralCount" },
    ],
    query: { enabled, staleTime: Infinity },
  });
  const [pool, stable, stableDecimals, originationFee, count] = head.data ?? [];
  const n = Number((count?.result as bigint | undefined) ?? 0n);

  const configs = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      ...vault,
      functionName: "collateralAt" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: n > 0, staleTime: Infinity },
  });
  const collaterals = (configs.data ?? []).flatMap((r) => (r.status === "success" ? [r.result] : []));

  const labels = useReadContracts({
    contracts: [
      { address: stable?.result as `0x${string}`, abi: erc20Abi, functionName: "symbol", chainId: activeChain.id },
      ...collaterals.flatMap((c) => [
        { address: c.token, abi: erc20Abi, functionName: "symbol" as const, chainId: activeChain.id },
        { address: c.token, abi: erc20Abi, functionName: "name" as const, chainId: activeChain.id },
      ]),
    ],
    query: { enabled: Boolean(stable?.result) && collaterals.length === n, staleTime: Infinity },
  });

  const [stableSymbol, ...names] = labels.data ?? [];
  return {
    pool: pool?.result as `0x${string}` | undefined,
    stable: stable?.result as `0x${string}` | undefined,
    stableDecimals: stableDecimals?.result as number | undefined,
    stableSymbol: (stableSymbol?.result as string | undefined) ?? "",
    originationFee: originationFee?.result as bigint | undefined,
    collaterals: collaterals.map((c, i) => {
      const symbol = (names[i * 2]?.result as string | undefined) ?? "";
      // The name people know, where the app has one, so the page matches the
      // markets; the token's own name() otherwise.
      const name = companyOf(symbol) ?? (names[i * 2 + 1]?.result as string | undefined) ?? "";
      return { ...c, symbol, name };
    }),
    ready: labels.isSuccess && collaterals.length === n && n > 0,
    isError: head.isError || configs.isError || labels.isError,
  };
}

/**
 * Everything the stock-loan screen shows, for the connected address.
 *
 * Per-token value is asked of the vault (`valueOf`) with an unbounded age, so
 * the number on screen is the contract's own arithmetic — split multiplier
 * included — whether or not the price is fresh enough to borrow against.
 * Freshness is reported separately, from the feed's `updatedAt` against each
 * collateral's `maxAge`, because "what it is worth" and "whether you may
 * borrow against it right now" are different questions and on a weekend they
 * have different answers.
 */
export function useStockLoan() {
  const { address } = useConnection();
  const config = useStockVaultConfig();
  const user = address ?? "0x0000000000000000000000000000000000000000";
  const enabled = config.ready && Boolean(address);

  const perToken = config.collaterals.flatMap((c) => [
    { address: c.token, abi: erc20Abi, functionName: "balanceOf" as const, args: [user] as const, chainId: activeChain.id },
    { address: c.token, abi: erc20Abi, functionName: "allowance" as const, args: [user, env.stockVaultAddress!] as const, chainId: activeChain.id },
    { ...vault, functionName: "collateralOf" as const, args: [user, c.token] as const },
    { ...vault, functionName: "valueOf" as const, args: [c.token, 10n ** BigInt(c.tokenDecimals), maxUint256] as const },
    { address: c.feed, abi: aggregatorV3InterfaceAbi, functionName: "latestRoundData" as const, chainId: activeChain.id },
  ]);

  // One multicall, so every figure is from the same block (see
  // useVaultPosition). Typed loosely because the list is a fixed head plus a
  // run per collateral; each result is read back through `ok` with its type.
  const calls: (ContractFunctionParameters & { chainId?: typeof activeChain.id })[] = [
      { ...vault, functionName: "debtOf", args: [user] },
      { ...vault, functionName: "healthFactor", args: [user] },
      { address: config.stable!, abi: erc20Abi, functionName: "balanceOf", args: [user], chainId: activeChain.id },
      { address: config.stable!, abi: erc20Abi, functionName: "allowance", args: [user, env.stockVaultAddress!], chainId: activeChain.id },
      { address: config.stable!, abi: erc20Abi, functionName: "allowance", args: [user, config.pool!], chainId: activeChain.id },
      { address: config.pool!, abi: borrowLiquidityPoolAbi, functionName: "balanceOfSupply", args: [user], chainId: activeChain.id },
      { address: config.pool!, abi: borrowLiquidityPoolAbi, functionName: "supplyRatePerSecond", chainId: activeChain.id },
      { address: config.pool!, abi: borrowLiquidityPoolAbi, functionName: "borrowRatePerSecond", chainId: activeChain.id },
      { address: config.pool!, abi: borrowLiquidityPoolAbi, functionName: "availableLiquidity", chainId: activeChain.id },
      ...perToken,
  ];
  const live = useReadContracts({ contracts: calls, query: { enabled, refetchInterval: 12_000 } });

  const r = live.data ?? [];
  const ok = <T,>(i: number) => (r[i]?.status === "success" ? (r[i].result as T) : undefined);

  const collaterals: StockCollateral[] = config.collaterals.map((c, i) => {
    const base = 9 + i * 5;
    const round = ok<readonly [bigint, bigint, bigint, bigint, bigint]>(base + 4);
    return {
      token: c.token,
      symbol: c.symbol,
      name: c.name,
      decimals: c.tokenDecimals,
      maxLTV: c.maxLTV,
      liquidationThreshold: c.liquidationThreshold,
      liquidationBonus: c.liquidationBonus,
      maxAge: c.maxAge,
      liquidationMaxAge: c.liquidationMaxAge,
      wallet: ok<bigint>(base),
      allowance: ok<bigint>(base + 1),
      deposited: ok<bigint>(base + 2),
      valuePerToken: ok<bigint>(base + 3),
      updatedAt: round?.[3],
    };
  });

  return {
    configured: Boolean(env.stockVaultAddress),
    ready: enabled && live.isSuccess,
    isError: config.isError || live.isError,
    pool: config.pool,
    stable: config.stable,
    stableDecimals: config.stableDecimals,
    stableSymbol: config.stableSymbol,
    originationFee: config.originationFee,
    debt: ok<bigint>(0),
    // Reverts when a held token's price is past even the liquidation bound;
    // undefined then, and the screen says the position cannot be priced.
    healthFactor: ok<bigint>(1),
    stableWallet: ok<bigint>(2),
    stableAllowanceVault: ok<bigint>(3),
    stableAllowancePool: ok<bigint>(4),
    supplied: ok<bigint>(5),
    supplyRate: ok<bigint>(6),
    borrowRate: ok<bigint>(7),
    liquidity: ok<bigint>(8),
    collaterals,
    summary: summarise(collaterals),
    refetch: live.refetch,
  };
}
