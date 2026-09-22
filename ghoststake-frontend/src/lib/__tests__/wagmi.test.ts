import { describe, expect, it, vi, beforeEach } from "vitest";

describe("chain resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    // Stubs otherwise leak into the next test: a malformed id stubbed for one
    // case made the following, unrelated case throw on import.
    vi.unstubAllEnvs();
  });

  it("resolves the configured chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "11155111");
    const { activeChain } = await import("../wagmi");
    expect(activeChain.id).toBe(11155111);
    expect(activeChain.name).toBe("Sepolia");
  });

  it("refuses an unsupported chain rather than silently falling back", async () => {
    // The bug this replaces: an unknown id silently became Arbitrum Sepolia,
    // so reads were pinned to a chain with no contracts on it and the
    // wrong-network banner named the wrong network. Still a placeholder
    // chain underneath since GHO-85 — but recorded, and the layout renders
    // the problem instead of the app, so nothing reads through it.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "999999");
    const { configProblems, configured } = await import("../config");
    expect(configured).toBe(false);
    expect(configProblems).toEqual([
      expect.objectContaining({ variable: "NEXT_PUBLIC_CHAIN_ID", value: "999999", reason: expect.stringMatching(/not a supported chain/) }),
    ]);
  });

  it("supports Robinhood Chain testnet, the GHO-21 target", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "46630");
    const { activeChain } = await import("../wagmi");
    expect(activeChain.id).toBe(46630);
    expect(activeChain.name).toBe("Robinhood Chain Testnet");
  });

  it("never creates WalletConnect on the server", async () => {
    // Its setup opens IndexedDB, which broke `next build` prerendering.
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "f7da3a436480ac37fb519c982b6923c7");
    const { wagmiConfig } = await import("../wagmi");
    const types = wagmiConfig.connectors.map((c) => c.type);
    expect(types).toContain("coinbaseWallet");
    expect(types).not.toContain("walletConnect");
  });

  it("refuses a malformed WalletConnect project id", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "not-a-project-id");
    const { configProblems } = await import("../config");
    expect(configProblems.map((p) => p.variable)).toEqual(["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"]);
  });

  it("supports the local foundry chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "31337");
    const { activeChain } = await import("../wagmi");
    expect(activeChain.id).toBe(31337);
  });
});
