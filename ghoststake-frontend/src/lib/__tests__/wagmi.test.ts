import { describe, expect, it, vi, beforeEach } from "vitest";

describe("chain resolution", () => {
  beforeEach(() => vi.resetModules());

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

  it("supports the local foundry chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "31337");
    const { activeChain } = await import("../wagmi");
    expect(activeChain.id).toBe(31337);
  });
});
