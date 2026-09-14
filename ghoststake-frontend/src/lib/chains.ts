import {
  arbitrum,
  arbitrumSepolia,
  foundry,
  mainnet,
  robinhood,
  robinhoodTestnet,
  sepolia,
} from "viem/chains";
import { env } from "./env";

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

/**
 * The chain the contracts are deployed to.
 *
 * An unsupported id throws rather than falling back. A fallback here has now
 * caused the same failure twice — the app quietly targeting a chain nobody
 * chose, reads failing against contracts that were never there, and the
 * wrong-network banner confidently naming the wrong network. A build that
 * refuses to start is a far cheaper way to find a typo'd chain id.
 */
function resolveChain() {
  const chain = SUPPORTED.find((c) => c.id === env.chainId);
  if (!chain) {
    throw new Error(
      `NEXT_PUBLIC_CHAIN_ID=${env.chainId} is not a supported chain. ` +
        `Supported: ${SUPPORTED.map((c) => `${c.name} (${c.id})`).join(", ")}`,
    );
  }
  return chain;
}

export const activeChain = resolveChain();

/** The RPC every chain read goes to: the configured one, else the chain's public default. */
export const activeRpcUrl: string = env.rpcUrl || activeChain.rpcUrls.default.http[0];
