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

  it("throws on an unsupported chain rather than falling back", async () => {
    // The bug this replaces: an unknown id silently became Arbitrum Sepolia,
    // so reads were pinned to a chain with no contracts on it and the
    // wrong-network banner named the wrong network.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "999999");
    await expect(import("../wagmi")).rejects.toThrow(/not a supported chain/);
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

  it("throws on a malformed WalletConnect project id", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "not-a-project-id");
    await expect(import("../wagmi")).rejects.toThrow(/WALLETCONNECT_PROJECT_ID/);
  });

  it("supports the local foundry chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "31337");
    const { activeChain } = await import("../wagmi");
    expect(activeChain.id).toBe(31337);
  });
});
