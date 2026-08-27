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

  /**
   * The demo market (GHO-29): the same contracts over a price feed the
   * operator publishes into by hand, so a round can be shown settling without
   * waiting on a real feed's heartbeat.
   *
   * Optional and separate from the pair above rather than folded into a list,
   * because the two are not interchangeable — one settles against Chainlink
   * and one settles against whatever the operator typed, and every surface
   * that shows them has to keep saying which is which.
   */
  demoMarketAddress: optionalAddress(process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS),
  demoRouterAddress: optionalAddress(process.env.NEXT_PUBLIC_DEMO_ROUTER_ADDRESS),

  /**
   * The market registry (GHO-34). When set, it is the list of markets and the
   * four addresses above are ignored — adding a market becomes a transaction
   * rather than a rebuild of this image.
   *
   * Still optional, because a deployment can predate the registry: the Sepolia
   * one does. Where it is absent the env pair is the whole list, which is what
   * every deployment did until now.
   */
  registryAddress: optionalAddress(process.env.NEXT_PUBLIC_REGISTRY_ADDRESS),
} as const;

export const contractsConfigured = Boolean(env.vaultAddress && env.poolAddress);

/**
 * The lending pool on its own. Tracked separately from `contractsConfigured`
 * because the supply side (GHO-39) needs only the pool: a lender never
 * touches the vault, and blacking out a working lending pool because no
 * stake vault is configured would be a lie about which contract is missing.
 */
export const poolConfigured = Boolean(env.poolAddress);

// The market half is tracked separately from the lending half on purpose: a
// deployment can legitimately have one and not the other — the Sepolia deploy
// predates the router — and collapsing both into one flag would black out a
// working dashboard because rounds are missing. That flag now lives in
// `markets.ts` as `marketsConfigured`, since there can be more than one.
