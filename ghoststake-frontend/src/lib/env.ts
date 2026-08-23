import type { Address } from "viem";

/**
 * Runtime configuration, read once and validated here rather than at each
 * use site. Everything is `NEXT_PUBLIC_` because it is all public anyway —
 * contract addresses and an RPC URL are visible to anyone with devtools.
 * Nothing secret belongs in this file.
 */

function optionalAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    // Loud, because a typo'd address reads on-chain as "no code here" and
    // every balance silently renders as zero. A blank dashboard that looks
    // plausible is worse than a build that refuses to start.
    throw new Error(`Invalid contract address in environment: ${value}`);
  }
  return value as Address;
}

export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",

  /** 421614 = Arbitrum Sepolia. Must match the backend's CHAIN_ID, or the
   *  SIWE message the server builds names a chain the wallet did not sign for. */
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 421614),

  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,

  /**
   * Undefined until GHO-21 deploys. The UI treats "not configured" as a
   * distinct state from "connected but empty" — see `ContractsNotDeployed`.
   */
  vaultAddress: optionalAddress(process.env.NEXT_PUBLIC_VAULT_ADDRESS),
  poolAddress: optionalAddress(process.env.NEXT_PUBLIC_POOL_ADDRESS),
} as const;

export const contractsConfigured = Boolean(env.vaultAddress && env.poolAddress);
