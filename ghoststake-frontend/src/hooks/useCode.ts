"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { activeChain } from "@/lib/wagmi";

/**
 * The deployed bytecode at an address.
 *
 * Cached forever: code cannot change at an address, so a refetch is the same
 * answer. wagmi has no hook for `eth_getCode`, hence the query.
 */
export function useCode(address: `0x${string}` | undefined) {
  const client = usePublicClient({ chainId: activeChain.id });

  return useQuery({
    queryKey: ["code", activeChain.id, address],
    enabled: Boolean(address && client),
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => (await client!.getCode({ address: address! })) ?? "0x",
  });
}
