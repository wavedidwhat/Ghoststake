import { beforeEach, describe, expect, it, vi } from "vitest";

// This file re-imports modules after `vi.resetModules()`, which reloads wagmi
// and viem's chain list from cold on every test. Alone that is quick; in the
// full parallel suite it can pass vitest's 5s default, and a timeout reads as
// a broken assertion (GHO-103, and likely the unexplained config/markets/wagmi
// failure in runbook Part 7.92). The limit is raised for this pattern only.
vi.setConfig({ testTimeout: 30_000 });

/**
 * GHO-85: a bad `NEXT_PUBLIC_*` value used to throw at module scope. That
 * module is imported by `proxy.ts`, so the throw was a blank 500 on every URL,
 * before any error boundary existed, naming nothing. These pin that each bad
 * value is now *recorded by name* — and, as importantly, that importing the
 * modules no longer throws at all.
 */
describe("configuration problems", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("is empty for a healthy configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "11155111");
    vi.stubEnv("NEXT_PUBLIC_VAULT_ADDRESS", "0x0ea31e490f9a9a21d2410add76668e4c2c24ba0e");
    const { configProblems, configured } = await import("../config");
    expect(configProblems).toEqual([]);
    expect(configured).toBe(true);
  });

  it("names a malformed address and its value, and does not throw", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAULT_ADDRESS", "0x0ea31e490f9a9a21d2410add76668e4c2c24ba0");
    const { configProblems } = await import("../config");
    expect(configProblems).toEqual([
      {
        variable: "NEXT_PUBLIC_VAULT_ADDRESS",
        value: "0x0ea31e490f9a9a21d2410add76668e4c2c24ba0",
        reason: expect.stringMatching(/20-byte hex address/),
      },
    ]);
  });

  it("names a non-numeric chain id once, not twice", async () => {
    // It fails in env.ts (does not parse). The placeholder it leaves behind is
    // a supported chain, so chains.ts must not report a second, misleading
    // "unsupported chain 421614" for a value nobody typed.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "sepolia");
    const { configProblems } = await import("../config");
    expect(configProblems).toEqual([
      expect.objectContaining({ variable: "NEXT_PUBLIC_CHAIN_ID", value: "sepolia" }),
    ]);
  });

  it("collects every problem rather than stopping at the first", async () => {
    // Fixing one variable per rebuild is the cost of reporting only the first.
    vi.stubEnv("NEXT_PUBLIC_POOL_ADDRESS", "pool");
    vi.stubEnv("NEXT_PUBLIC_ROUTER_ADDRESS", "router");
    const { configProblems } = await import("../config");
    expect(configProblems.map((p) => p.variable)).toEqual([
      "NEXT_PUBLIC_POOL_ADDRESS",
      "NEXT_PUBLIC_ROUTER_ADDRESS",
    ]);
  });

  it("keeps a refused address out of the configured set", async () => {
    // Undefined is what an unset address means ("not deployed here"). The
    // layout never renders with a problem recorded, but the flags must still
    // not claim the contract is configured.
    vi.stubEnv("NEXT_PUBLIC_POOL_ADDRESS", "0xnope");
    const { poolConfigured } = await import("../env");
    expect(poolConfigured).toBe(false);
  });

  it("does not read a feed label against a placeholder chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "999999");
    // Asserted on the request, not the result: feedLabel returns null on any
    // failure, so a read against the wrong chain that happened to fail would
    // pass a test that only checked for null.
    const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const { feedLabel } = await import("../marketMeta");
      await expect(feedLabel("0x4650029f444997f76f4c6e0e0159865582da6ab5")).resolves.toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails a production build, naming every problem", async () => {
    // The build is the cheapest place to catch these: the values are inlined
    // there. It used to refuse only because a module threw during page
    // collection; now that nothing throws, next.config.ts has to say so.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "999999");
    vi.stubEnv("NEXT_PUBLIC_POOL_ADDRESS", "0xnope");
    const { PHASE_PRODUCTION_BUILD } = await import("next/constants");
    const { default: config } = await import("../../../next.config");
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(
      /NEXT_PUBLIC_POOL_ADDRESS[\s\S]*NEXT_PUBLIC_CHAIN_ID/,
    );
  });

  it("lets the dev server start, so it can render the problem instead", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "999999");
    const { PHASE_DEVELOPMENT_SERVER } = await import("next/constants");
    const { default: config } = await import("../../../next.config");
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
  });
});
