import { createConfig, http } from "wagmi";
import { arbitrum, arbitrumSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { env } from "./env";

/**
 * The chain the contracts are actually deployed to. Chosen by env so a
 * testnet demo and a mainnet deploy build from the same source.
 */
export const activeChain = env.chainId === arbitrum.id ? arbitrum : arbitrumSepolia;

/**
 * Both Arbitrum networks are declared even though only `activeChain` is
 * supported. That is not hedging — `useSwitchChain` can only switch *to* a
 * chain the config knows about, so declaring the pair is what makes the
 * wrong-network prompt able to fix itself with one click instead of telling
 * the user to go find the network menu.
 *
 * `injected()` only: MetaMask, Rabby, and anything else that announces over
 * EIP-6963 are all discovered through it. WalletConnect would mean a Reown
 * project ID and a cloud dependency, which is not worth it yet.
 */
export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia, arbitrum],
  connectors: [injected()],
  // Required under Next's server render: without it wagmi reads connection
  // state during SSR and the client hydrates into a mismatch.
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
