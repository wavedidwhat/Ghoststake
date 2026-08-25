import { describe, expect, it, vi, beforeEach } from "vitest";

const MARKET = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const DEMO_MARKET = "0x3333333333333333333333333333333333333333";
const DEMO_ROUTER = "0x4444444444444444444444444444444444444444";

/**
 * GHO-29, and still true under GHO-34's registry: this is the fallback list,
 * used wherever no registry is configured — which includes the Sepolia
 * deployment that predates it. What is worth pinning is the two ways a demo
 * market could quietly stop being labelled: a half-configured pair appearing
 * anyway, or the demo market arriving without its hint and rendering
 * identically to the Chainlink one.
 */
describe("markets from the environment", () => {
  beforeEach(() => {
    // Both, and in this order: env stubs outlive a test otherwise, and a
    // leaked demo router made the "half a pair" case below pass for the wrong
    // reason — it was reading the previous test's configuration.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lists nothing when no market is configured", async () => {
    const { envMarkets, anyMarketConfigured } = await import("../markets");
    expect(envMarkets()).toEqual([]);
    expect(anyMarketConfigured()).toBe(false);
  });

  it("lists the real market alone when there is no demo one", async () => {
    vi.stubEnv("NEXT_PUBLIC_MARKET_ADDRESS", MARKET);
    vi.stubEnv("NEXT_PUBLIC_ROUTER_ADDRESS", ROUTER);
    const { envMarkets } = await import("../markets");
    expect(envMarkets()).toHaveLength(1);
    expect(envMarkets()[0].kindHint).toBe("chainlink");
  });

  it("puts the real market first and marks the demo one as a demo", async () => {
    vi.stubEnv("NEXT_PUBLIC_MARKET_ADDRESS", MARKET);
    vi.stubEnv("NEXT_PUBLIC_ROUTER_ADDRESS", ROUTER);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", DEMO_MARKET);
    vi.stubEnv("NEXT_PUBLIC_DEMO_ROUTER_ADDRESS", DEMO_ROUTER);

    const { envMarkets } = await import("../markets");
    const markets = envMarkets();
    expect(markets.map((m) => m.kindHint)).toEqual(["chainlink", "demo"]);
    // The headline market leads: the claim being made is that settlement is
    // pinned to Chainlink, so that is the market a reader meets first.
    expect(markets[0].address).toBe(MARKET);
    expect(markets[1].router).toBe(DEMO_ROUTER);
  });

  it("drops a demo market whose router was never configured", async () => {
    // Half a pair is not a market: staking through it would need a router
    // address the deployment does not have, so the card would offer a button
    // that cannot work.
    vi.stubEnv("NEXT_PUBLIC_MARKET_ADDRESS", MARKET);
    vi.stubEnv("NEXT_PUBLIC_ROUTER_ADDRESS", ROUTER);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", DEMO_MARKET);

    const { envMarkets } = await import("../markets");
    expect(envMarkets()).toHaveLength(1);
    expect(envMarkets()[0].kindHint).toBe("chainlink");
  });

  it("refuses a malformed demo address rather than reading a dead one", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", "0xnope");
    // Thrown at module load, from `env`: a malformed address reads on chain
    // as an address with no code, so every pool would render as a plausible
    // zero rather than as a misconfiguration.
    await expect(import("../markets")).rejects.toThrow(/Invalid contract address/);
  });
});
