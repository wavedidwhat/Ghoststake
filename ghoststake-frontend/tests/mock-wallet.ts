import type { Page } from "@playwright/test";

/**
 * A mock EIP-6963 wallet, installed before the app's own scripts run.
 *
 * This exists because every wallet bug in this repo so far has been a state
 * with no exit — GHO-77 for connecting, GHO-83 for signing, sending and
 * switching network — and all of them were reproduced with a throwaway script
 * that was then thrown away (runbook Part 7.70). So the regression tests were
 * never written, and the same bug reappeared in three more places.
 *
 * `hang` is the whole point. A wallet that *rejects* is the easy case and was
 * always handled; a wallet that accepts a request and simply never answers is
 * what pins the interface, and it is what nothing in CI has ever exercised.
 */
export type WalletBehaviour = "answers" | "hang" | "reject";

export interface MockWalletOptions {
  /** How the wallet responds to everything, unless overridden below. */
  behaviour?: WalletBehaviour;
  /** Override per RPC method, e.g. `{ personal_sign: "hang" }`. */
  methods?: Record<string, WalletBehaviour>;
  address?: string;
  chainIdHex?: string;
}

const DEFAULT_ADDRESS = "0x1111111111111111111111111111111111111111";

/**
 * Installs the wallet. Must be called before `page.goto`.
 *
 * wagmi's `reconnect()` probes every announced connector on mount, so the
 * provider has to be announcing before the app's first render — an init
 * script, not an evaluate after load.
 */
export async function installMockWallet(page: Page, options: MockWalletOptions = {}) {
  const config = {
    behaviour: options.behaviour ?? "answers",
    methods: options.methods ?? {},
    address: options.address ?? DEFAULT_ADDRESS,
    chainIdHex: options.chainIdHex ?? "0x7a69", // 31337, the local stack
  };

  await page.addInitScript((cfg) => {
    const behaviourFor = (method: string): string =>
      (cfg.methods as Record<string, string>)[method] ?? cfg.behaviour;

    const answer = (method: string): unknown => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [cfg.address];
        case "eth_chainId":
          return cfg.chainIdHex;
        case "personal_sign":
          return `0x${"ab".repeat(65)}`;
        case "eth_sendTransaction":
          return `0x${"cd".repeat(32)}`;
        case "wallet_switchEthereumChain":
          return null;
        default:
          return null;
      }
    };

    const provider = {
      isMockWallet: true,
      async request({ method }: { method: string; params?: unknown[] }) {
        const how = behaviourFor(method);
        if (how === "hang") {
          // Never settles, and never rejects. This is the shape of a wallet
          // that is installed but locked, busy or mid-update: it accepts the
          // call and goes quiet.
          return new Promise(() => {});
        }
        if (how === "reject") {
          const err = new Error("User rejected the request.") as Error & { code: number };
          err.code = 4001;
          throw err;
        }
        return answer(method);
      },
      on() {},
      removeListener() {},
    };

    const detail = Object.freeze({
      info: Object.freeze({
        uuid: "00000000-0000-0000-0000-00000000dead",
        name: "Mock Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        rdns: "dev.ghoststake.mock",
      }),
      provider,
    });

    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));

    window.addEventListener("eip6963:requestProvider", announce);
    announce();

    // Some paths still look for a window-level provider.
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  }, config);
}
