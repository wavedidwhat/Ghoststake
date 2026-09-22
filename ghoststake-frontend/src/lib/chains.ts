import {
  arbitrum,
  arbitrumSepolia,
  foundry,
  mainnet,
  robinhood,
  robinhoodTestnet,
  sepolia,
} from "viem/chains";
import { env, type ConfigProblem } from "./env";

/**
 * Every chain this app can be pointed at. Robinhood Chain (an Arbitrum Orbit
 * L2) is the GHO-21 target; the others are where it has run so far.
 *
 * Kept apart from `wagmi.ts` so server code (the CSP in `proxy.ts`) can know
 * the active chain's RPC without importing wallet SDKs.
 */
export const SUPPORTED = [
  mainnet,
  sepolia,
  arbitrum,
  arbitrumSepolia,
  robinhood,
  robinhoodTestnet,
  foundry,
] as const;

const problems: ConfigProblem[] = [];

/** A chain id that parsed but is not one this app supports. */
export const chainProblems: readonly ConfigProblem[] = problems;

/**
 * The chain the contracts are deployed to.
 *
 * An unsupported id is refused rather than quietly replaced. A silent fallback
 * here has caused the same failure twice — the app targeting a chain nobody
 * chose, reads failing against contracts that were never there, and the
 * wrong-network banner confidently naming the wrong network.
 *
 * ~~Thrown, on the grounds that "a build that refuses to start is a far cheaper
 * way to find a typo'd chain id".~~ It never refused a build: every route has
 * rendered per request since GHO-66, so nothing evaluated this at build time
 * and the throw fired on every *request* instead — inside `proxy.ts`, before
 * any error boundary, as a blank 500 (GHO-85). Now recorded as a problem the
 * root layout renders by name, and the fallback below is only what the module
 * graph evaluates against; the app does not render with a problem recorded.
 */
function resolveChain() {
  const chain = SUPPORTED.find((c) => c.id === env.chainId);
  if (!chain) {
    problems.push({
      variable: "NEXT_PUBLIC_CHAIN_ID",
      value: String(env.chainId),
      reason: `is not a supported chain. Supported: ${SUPPORTED.map((c) => `${c.name} (${c.id})`).join(", ")}`,
    });
    return arbitrumSepolia;
  }
  return chain;
}

export const activeChain = resolveChain();

/** The RPC every chain read goes to: the configured one, else the chain's public default. */
export const activeRpcUrl: string = env.rpcUrl || activeChain.rpcUrls.default.http[0];
