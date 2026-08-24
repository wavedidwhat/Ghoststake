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

function requiredChainId(value: string | undefined): number {
  if (!value) return 421614;
  const parsed = Number(value);
  // A non-numeric value would coerce to NaN and silently select the default
  // chain, so the app would talk to a network nobody chose.
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid NEXT_PUBLIC_CHAIN_ID: ${value}`);
  }
  return parsed;
}

export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",

  /** Must match the backend's CHAIN_ID: it is bound into the SIWE message,
   *  so a mismatch means signing for a different chain. 421614 = Arb Sepolia. */
  chainId: requiredChainId(process.env.NEXT_PUBLIC_CHAIN_ID),

  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,

  /**
   * Undefined until the contracts are deployed. The UI renders this as a
   * distinct state from "connected with an empty position".
   */
  vaultAddress: optionalAddress(process.env.NEXT_PUBLIC_VAULT_ADDRESS),
  poolAddress: optionalAddress(process.env.NEXT_PUBLIC_POOL_ADDRESS),

  /** The parimutuel market and the borrow-to-position router. */
  marketAddress: optionalAddress(process.env.NEXT_PUBLIC_MARKET_ADDRESS),
  routerAddress: optionalAddress(process.env.NEXT_PUBLIC_ROUTER_ADDRESS),
} as const;

export const contractsConfigured = Boolean(env.vaultAddress && env.poolAddress);

/**
 * The market half is tracked separately from the lending half on purpose.
 *
 * A deployment can legitimately have one and not the other — the Sepolia
 * deploy predates the router — and collapsing both into one flag would black
 * out a working dashboard because rounds are missing.
 */
export const marketConfigured = Boolean(env.marketAddress && env.routerAddress);
