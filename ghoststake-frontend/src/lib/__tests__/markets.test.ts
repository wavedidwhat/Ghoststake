import { describe, expect, it, vi, beforeEach } from "vitest";

const MARKET = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const DEMO_MARKET = "0x3333333333333333333333333333333333333333";
const DEMO_ROUTER = "0x4444444444444444444444444444444444444444";

/**
 * GHO-29. What is worth pinning here is not the list itself but the two ways
 * a demo market could quietly stop being labelled: a half-configured pair
 * appearing anyway, or the demo market arriving without `kind: "demo"` and
 * rendering identically to the Chainlink one.
 */
describe("configured markets", () => {
  beforeEach(() => {
    // Both, and in this order: env stubs outlive a test otherwise, and a
    // leaked demo router made the "half a pair" case below pass for the wrong
    // reason — it was reading the previous test's configuration.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lists nothing when no market is configured", async () => {
    const { markets, marketsConfigured } = await import("../markets");
    expect(markets).toEqual([]);
    expect(marketsConfigured).toBe(false);
  });

  it("lists the real market alone when there is no demo one", async () => {
    vi.stubEnv("NEXT_PUBLIC_MARKET_ADDRESS", MARKET);
    vi.stubEnv("NEXT_PUBLIC_ROUTER_ADDRESS", ROUTER);
    const { markets } = await import("../markets");
    expect(markets).toHaveLength(1);
    expect(markets[0].kind).toBe("chainlink");
  });

  it("puts the real market first and marks the demo one as a demo", async () => {
    vi.stubEnv("NEXT_PUBLIC_MARKET_ADDRESS", MARKET);
    vi.stubEnv("NEXT_PUBLIC_ROUTER_ADDRESS", ROUTER);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", DEMO_MARKET);
    vi.stubEnv("NEXT_PUBLIC_DEMO_ROUTER_ADDRESS", DEMO_ROUTER);

    const { markets } = await import("../markets");
    expect(markets.map((m) => m.kind)).toEqual(["chainlink", "demo"]);
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

    const { markets } = await import("../markets");
    expect(markets).toHaveLength(1);
    expect(markets[0].kind).toBe("chainlink");
  });

  it("refuses a malformed demo address rather than reading a dead one", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MARKET_ADDRESS", "0xnope");
    await expect(import("../markets")).rejects.toThrow(/Invalid contract address/);
  });
});
