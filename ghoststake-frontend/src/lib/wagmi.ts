import { createConfig, http } from "wagmi";
import { arbitrum, arbitrumSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { env } from "./env";

/** The chain the contracts are deployed to, so one build serves both. */
export const activeChain = env.chainId === arbitrum.id ? arbitrum : arbitrumSepolia;

/**
 * Both Arbitrum networks are declared although only `activeChain` is
 * supported: `useSwitchChain` can only switch *to* a chain in the config, so
 * declaring the pair is what lets the wrong-network banner correct itself.
 *
 * `injected()` covers MetaMask, Rabby, and anything else announcing over
 * EIP-6963. WalletConnect would add a project ID and a cloud dependency.
 */
export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia, arbitrum],
  connectors: [injected()],
  // Without this, connection state is read during SSR and hydration mismatches.
  ssr: true,
  transports: {
    [arbitrumSepolia.id]: http(env.chainId === arbitrumSepolia.id ? env.rpcUrl : undefined),
    [arbitrum.id]: http(env.chainId === arbitrum.id ? env.rpcUrl : undefined),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
