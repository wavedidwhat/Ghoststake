import type { Address } from "viem";

/**
 * Runtime configuration, validated once here rather than at each use site.
 *
 * Everything is `NEXT_PUBLIC_` and ships to the browser. Nothing secret
 * belongs in this file.
 */

function optionalAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    // Throws rather than warns: a malformed address reads on-chain as an
    // address with no code, so every balance would render as a plausible zero.
    throw new Error(`Invalid contract address in environment: ${value}`);
  }
  return value as Address;
}

export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",

  /** Must match the backend's CHAIN_ID: it is bound into the SIWE message,
   *  so a mismatch means signing for a different chain. 421614 = Arb Sepolia. */
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 421614),

  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,

  /**
   * Undefined until the contracts are deployed. The UI renders this as a
   * distinct state from "connected with an empty position".
   */
  vaultAddress: optionalAddress(process.env.NEXT_PUBLIC_VAULT_ADDRESS),
  poolAddress: optionalAddress(process.env.NEXT_PUBLIC_POOL_ADDRESS),
} as const;

export const contractsConfigured = Boolean(env.vaultAddress && env.poolAddress);
