import type { Address } from "viem";

/**
 * Runtime configuration, validated once here rather than at each use site.
 *
 * Everything is `NEXT_PUBLIC_` and ships to the browser. Nothing secret
 * belongs in this file.
 */

/**
 * A variable this deployment was built with that cannot be used.
 *
 * Recorded rather than thrown (GHO-85). Refusing a bad value is right — every
 * one of these would otherwise produce plausible wrong numbers — but a throw at
 * module scope is delivered as the worst possible failure: this module is
 * imported by `proxy.ts`, which runs before any page or error boundary exists,
 * so the throw was a blank 500 on every URL with nothing on screen naming the
 * variable. The root layout renders these instead of the app.
 */
export type ConfigProblem = {
  variable: string;
  value: string;
  reason: string;
};

const problems: ConfigProblem[] = [];

/** Every problem found in this module, in the order the variables appear. */
export const envProblems: readonly ConfigProblem[] = problems;

function optionalAddress(variable: string, value: string | undefined): Address | undefined {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    // Refused rather than warned about: a malformed address reads on-chain as
    // an address with no code, so every balance would render as a plausible
    // zero. `undefined` is only what the module evaluates to — the app does
    // not render with a problem recorded, so nothing reads it as "not
    // deployed".
    problems.push({ variable, value, reason: "is not a 20-byte hex address (0x followed by 40 hex digits)" });
    return undefined;
  }
  return value as Address;
}

/**
 * The origin this deployment is served from.
 *
 * Unset is **not** a recorded problem, deliberately, and the distinction is
 * the whole of GHO-90. `http://localhost:3000` is the right answer for
 * `next dev` and a silent lie in anything built for deployment — but the app
 * works perfectly either way, so rendering the misconfigured screen over it
 * would take down a working site for a wrong `og:image`. The refusal belongs
 * at build time instead, where it costs nobody anything: see `appUrlMissing`
 * and `next.config.ts`.
 *
 * A value that is *set and unusable* is a different thing, and is recorded,
 * because `new URL()` in the root layout throws on it — which is a blank 500
 * on every page rather than a bad preview.
 */
function siteUrl(value: string | undefined): string {
  if (!value) return LOCAL_SITE_URL;
  try {
    const parsed = new URL(value);
    // A `mailto:` or a bare host would parse and then resolve an image URL to
    // somewhere no crawler will follow.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      problems.push({
        variable: "NEXT_PUBLIC_APP_URL",
        value,
        reason: "is not an http(s) URL, so share images would resolve to nothing",
      });
      return LOCAL_SITE_URL;
    }
    return value;
  } catch {
    problems.push({
      variable: "NEXT_PUBLIC_APP_URL",
      value,
      reason: "is not an absolute URL (it needs a scheme and a host, e.g. https://example.com)",
    });
    return LOCAL_SITE_URL;
  }
}

/** The dev default, and the value a deployed build must not be left with. */
const LOCAL_SITE_URL = "http://localhost:3000";

/**
 * Whether this build would ship share cards pointing at the reader's own
 * machine (GHO-90).
 *
 * Separate from `envProblems` because the consequence is different: the app
 * runs, every page works, and the only thing broken is an unfurl — which is
 * visible to everyone except the people who deployed it. That is exactly the
 * failure a build refusal is for, and exactly the wrong reason to replace a
 * working site with an error screen.
 */
export const appUrlMissing = !process.env.NEXT_PUBLIC_APP_URL;

function requiredChainId(value: string | undefined): number {
  if (!value) return 421614;
  const parsed = Number(value);
  // A non-numeric value would coerce to NaN and silently select the default
  // chain, so the app would talk to a network nobody chose. Recorded, and the
  // default is only a placeholder for the rest of the module graph to evaluate
  // against; see `optionalAddress`.
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push({ variable: "NEXT_PUBLIC_CHAIN_ID", value, reason: "is not a positive integer chain id" });
    return 421614;
  }
  return parsed;
}

export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",

  /**
   * Where this deployment is served from. Only used to make the Open Graph
   * image URL absolute (GHO-58): a share card is fetched by someone else's
   * server, so a relative path resolves against the wrong host and the
   * preview silently comes back blank.
   */
  appUrl: siteUrl(process.env.NEXT_PUBLIC_APP_URL),

  /** Must match the backend's CHAIN_ID: it is bound into the SIWE message,
   *  so a mismatch means signing for a different chain. 421614 = Arb Sepolia. */
  chainId: requiredChainId(process.env.NEXT_PUBLIC_CHAIN_ID),

  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,

  /**
   * Undefined until the contracts are deployed. The UI renders this as a
   * distinct state from "connected with an empty position".
   */
  vaultAddress: optionalAddress("NEXT_PUBLIC_VAULT_ADDRESS", process.env.NEXT_PUBLIC_VAULT_ADDRESS),
  poolAddress: optionalAddress("NEXT_PUBLIC_POOL_ADDRESS", process.env.NEXT_PUBLIC_POOL_ADDRESS),

  /** The parimutuel market and the borrow-to-position router. */
  marketAddress: optionalAddress("NEXT_PUBLIC_MARKET_ADDRESS", process.env.NEXT_PUBLIC_MARKET_ADDRESS),
  routerAddress: optionalAddress("NEXT_PUBLIC_ROUTER_ADDRESS", process.env.NEXT_PUBLIC_ROUTER_ADDRESS),

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
  demoMarketAddress: optionalAddress("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", process.env.NEXT_PUBLIC_DEMO_MARKET_ADDRESS),
  demoRouterAddress: optionalAddress("NEXT_PUBLIC_DEMO_ROUTER_ADDRESS", process.env.NEXT_PUBLIC_DEMO_ROUTER_ADDRESS),

  /**
   * The market registry (GHO-34). When set, it is the list of markets and the
   * four addresses above are ignored — adding a market becomes a transaction
   * rather than a rebuild of this image.
   *
   * Still optional, because a deployment can predate the registry: the Sepolia
   * one does. Where it is absent the env pair is the whole list, which is what
   * every deployment did until now.
   */
  registryAddress: optionalAddress("NEXT_PUBLIC_REGISTRY_ADDRESS", process.env.NEXT_PUBLIC_REGISTRY_ADDRESS),

  /**
   * Reown (WalletConnect) project id. Public by design — what stops a clone
   * site reusing it is the allowed-origins list in the Reown dashboard, not
   * secrecy. Optional so local dev works without one; WalletConnect is simply
   * not offered.
   */
  walletConnectProjectId: optionalProjectId(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID),
} as const;

function optionalProjectId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Refused for the same reason addresses are: a typo'd id fails only when a
  // user taps WalletConnect on a phone, which is the last place to find it.
  if (!/^[0-9a-f]{32}$/.test(value)) {
    problems.push({
      variable: "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
      value,
      reason: "is not a 32-character lowercase hex project id",
    });
    return undefined;
  }
  return value;
}

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
