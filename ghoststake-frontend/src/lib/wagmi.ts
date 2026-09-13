import { createConfig, http } from "wagmi";
import {
  arbitrum,
  arbitrumSepolia,
  foundry,
  mainnet,
  robinhood,
  robinhoodTestnet,
  sepolia,
} from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { env } from "./env";

/**
 * Every chain this app can be pointed at. Robinhood Chain (an Arbitrum Orbit
 * L2) is the GHO-21 target; the others are where it has run so far.
 */
const SUPPORTED = [
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
 * Three ways in, because a phone's default browser has no injected wallet.
 *
 * - `injected` — desktop extensions and wallet in-app browsers (EIP-6963).
 * - `coinbaseWallet`, EOA only — the Coinbase app. Its smart-wallet mode is
 *   switched off: Coinbase's smart wallet runs on a fixed list of chains and
 *   Robinhood Chain is not on it, so offering it would be a sign-up that
 *   cannot transact here.
 * - `walletConnect` — every other mobile wallet, only when a project id is set.
 *
 * WalletConnect is created in the browser only. `createConfig` sets connectors
 * up immediately, and WalletConnect's setup opens IndexedDB — during `next
 * build` prerendering that threw `indexedDB is not defined` and initialised
 * its core twice. The server and browser configs therefore differ by one
 * connector, so nothing rendered on the server may depend on the connector
 * count — `ConnectButton` got that wrong once (React #418).
 */
const connectors = [
  injected(),
  coinbaseWallet({
    appName: "GhostStake",
    preference: { options: "eoaOnly" },
  }),
  ...(env.walletConnectProjectId && typeof window !== "undefined"
    ? [
        walletConnect({
          projectId: env.walletConnectProjectId,
          metadata: {
            name: "GhostStake",
            description: "Stake, borrow against it, and take a position.",
            // The wallet shows this and WalletConnect's Verify checks it
            // against the real origin, so it must be where the page is served.
            url: window.location.origin,
            // Empty until the logo exists (GHO-58); no placeholder mark.
            icons: [],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig({
  chains: SUPPORTED,
  connectors,
  // Without this, connection state is read during SSR and hydration mismatches.
  ssr: true,
  transports,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
