import { afterEach, describe, expect, it, vi } from "vitest";

// Re-imports after `vi.resetModules()` reload viem's chain list from cold, which
// can pass vitest's 5s default in the full parallel suite (see ExplorerLink.test).
vi.setConfig({ testTimeout: 30_000 });

/**
 * The network badge (GHO-127). The browser tests run on anvil, which has no
 * mark and no explorer, so the real case, Robinhood Chain, is checked here.
 */
async function load(chainId: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", chainId);
  const { ChainBadge, hasChainMark } = await import("../ChainBadge");
  const { renderWithMessages } = await import("@/test/intl");
  return { ChainBadge, hasChainMark, render: renderWithMessages };
}

describe("ChainBadge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names Robinhood Chain once, says testnet once, and links its explorer", async () => {
    const { ChainBadge, render } = await load("46630");
    const html = render(<ChainBadge />);
    expect(html).toContain('href="https://explorer.testnet.chain.robinhood.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain(">Robinhood Chain<");
    expect(html).toContain(">Testnet<");
    // The chip says it, so the name must not say it again.
    expect(html).not.toContain("Robinhood Chain Testnet Testnet");
    expect(html).toContain('title="GhostStake runs on Robinhood Chain Testnet"');
    // Robinhood's mark, not the fallback dot.
    expect(html).toContain("<svg");
    expect(html).not.toContain("rounded-full bg-ink-faint");
  });

  it("keeps a testnet's name whole when the name does not say testnet", async () => {
    const { ChainBadge, render } = await load("11155111");
    const html = render(<ChainBadge />);
    expect(html).toContain(">Sepolia<");
    expect(html).toContain(">Testnet<");
  });

  it("shows a plain dot and no link on a chain with no mark or explorer", async () => {
    const { ChainBadge, hasChainMark, render } = await load("31337");
    const html = render(<ChainBadge />);
    expect(hasChainMark(31337)).toBe(false);
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<svg");
    expect(html).toContain("rounded-full bg-ink-faint");
    expect(html).toContain(">Foundry<");
    // viem does not mark anvil as a testnet, so no chip is claimed for it.
    expect(html).not.toContain(">Testnet<");
  });

  it("has a mark for both Robinhood chains", async () => {
    const { hasChainMark } = await load("46630");
    expect(hasChainMark(46630)).toBe(true);
    expect(hasChainMark(4663)).toBe(true);
  });
});

describe("ChainBadge compact (sidebar)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the mark and the Testnet chip, and the name for screen readers only", async () => {
    const { ChainBadge, render } = await load("46630");
    const html = render(<ChainBadge compact />);
    expect(html).toContain("<svg");
    expect(html).toContain(">Testnet<");
    expect(html).toContain('<span class="sr-only">Robinhood Chain</span>');
    expect(html).not.toContain("sm:inline");
  });
});
