import { createConfig, http } from "wagmi";
import { arbitrum, arbitrumSepolia, foundry, mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { env } from "./env";

/** Every chain this app can be pointed at. */
const SUPPORTED = [mainnet, sepolia, arbitrum, arbitrumSepolia, foundry] as const;

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

/**
 * Transports for every supported chain, so `useSwitchChain` can move between
 * them. Only the active chain gets the configured RPC; the rest fall back to
 * their public default, which is all a network-switch prompt needs.
 */
const transports = Object.fromEntries(
  SUPPORTED.map((chain) => [
    chain.id,
    http(chain.id === activeChain.id ? env.rpcUrl : undefined),
  ]),
) as Record<(typeof SUPPORTED)[number]["id"], ReturnType<typeof http>>;

/**
 * `injected()` covers MetaMask, Rabby, and anything else announcing over
 * EIP-6963. WalletConnect would add a project ID and a cloud dependency.
 */
export const wagmiConfig = createConfig({
  chains: SUPPORTED,
  connectors: [injected()],
  // Without this, connection state is read during SSR and hydration mismatches.
  ssr: true,
  transports,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
