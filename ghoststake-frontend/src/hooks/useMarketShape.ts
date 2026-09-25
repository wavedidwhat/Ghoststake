"use client";

import { useReadContract } from "wagmi";
import { toFunctionSelector } from "viem";
import { chainlinkRoundOracleAbi, parimutuelRoundAbi } from "@/lib/abis";
import type { Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";
import { useCode } from "./useCode";

/** `openRound(uint64,uint64,uint64,uint256)` — the shape that takes a strike. */
const STRIKE_AT_OPEN = toFunctionSelector("openRound(uint64,uint64,uint64,uint256)");

/**
 * What a deployed market can do, and the price it would strike against.
 *
 * Contracts are not upgradeable here (GHO-52), so several versions are live at
 * once: the Sepolia markets predate GHO-79 and take three arguments to
 * `openRound`, anything newer takes a strike as well. The operator console
 * drives both, so it has to ask — sending the wrong shape reverts, and the
 * person pressing the button would only learn that from a failed transaction.
 *
 * Read from the deployed bytecode, the same way the keeper does
 * (`internal/keeper/capability.go`): a dispatch table contains its selectors.
 */
export function useMarketShape(market: Market) {
  const code = useCode(market.address);

  const oracle = useReadContract({
    address: market.address,
    abi: parimutuelRoundAbi,
    functionName: "oracle",
    chainId: activeChain.id,
    query: { staleTime: Infinity },
  });

  const spot = useReadContract({
    address: oracle.data,
    abi: chainlinkRoundOracleAbi,
    functionName: "readLatest",
    chainId: activeChain.id,
    query: { enabled: Boolean(oracle.data), refetchInterval: 12_000 },
  });

  const [usable, price] = spot.data ?? [];

  return {
    /** Undefined until the code is known: neither shape should be assumed. */
    strikeAtOpen: code.data === undefined ? undefined : code.data.includes(STRIKE_AT_OPEN.slice(2)),
    /** The adapter's price, 18 decimals, or undefined when it has none. */
    spot: usable ? price : undefined,
    isLoading: code.isLoading || oracle.isLoading || spot.isLoading,
  };
}
