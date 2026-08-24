import { createConfig, http } from "wagmi";
import { arbitrum, arbitrumSepolia, foundry } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { env } from "./env";

const SUPPORTED = [arbitrumSepolia, arbitrum, foundry] as const;

/**
 * The chain the contracts are deployed to, so one build serves all of them.
 *
 * `foundry` (31337) is here for local anvil. Without it a local deploy is
 * unreachable: an unrecognised id fell through to Arbitrum Sepolia, so the
 * app would read a testnet while claiming to be on localhost.
 */
export const activeChain = SUPPORTED.find((c) => c.id === env.chainId) ?? arbitrumSepolia;

/**
 * Every supported chain is declared although only `activeChain` is used:
 * `useSwitchChain` can only switch *to* a chain in the config, so declaring
 * them is what lets the wrong-network banner correct itself.
 *
 * `injected()` covers MetaMask, Rabby, and anything else announcing over
 * EIP-6963. WalletConnect would add a project ID and a cloud dependency.
 */
export const wagmiConfig = createConfig({
  chains: SUPPORTED,
  connectors: [injected()],
  // Without this, connection state is read during SSR and hydration mismatches.
  ssr: true,
  transports: {
    [arbitrumSepolia.id]: http(env.chainId === arbitrumSepolia.id ? env.rpcUrl : undefined),
    [arbitrum.id]: http(env.chainId === arbitrum.id ? env.rpcUrl : undefined),
    // anvil's default. Overridable for a non-default port.
    [foundry.id]: http(env.rpcUrl ?? "http://127.0.0.1:8545"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
