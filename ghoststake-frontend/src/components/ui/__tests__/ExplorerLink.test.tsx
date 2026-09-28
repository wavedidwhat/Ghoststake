import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// This file re-imports modules after `vi.resetModules()`, which reloads wagmi
// and viem's chain list from cold on every test. Alone that is quick; in the
// full parallel suite it can pass vitest's 5s default, and a timeout reads as
// a broken assertion (GHO-103, and likely the unexplained config/markets/wagmi
// failure in runbook Part 7.92). The limit is raised for this pattern only.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ExplorerLink (GHO-103). The browser tests run on a local chain with no
 * explorer, where the link correctly degrades to text, so the linked case is
 * checked here against a chain that has one.
 */

const TX = "0x" + "ab".repeat(32);
const ADDR = "0x0ea31e490f9a9a21d2410add76668e4c2c24ba0e";

async function load(chainId: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", chainId);
  return (await import("../ExplorerLink")).ExplorerLink;
}

describe("ExplorerLink", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("links a transaction to the chain's explorer, in a new tab, safely", async () => {
    const ExplorerLink = await load("11155111");
    const html = renderToStaticMarkup(<ExplorerLink tx={TX} />);
    expect(html).toContain(`/tx/${TX}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("opens the explorer in a new tab");
    // Shortened for display, full in the tooltip.
    expect(html).toContain("0xabab");
    expect(html).toContain(`title="${TX}"`);
  });

  it("links an address to its page", async () => {
    const ExplorerLink = await load("11155111");
    expect(renderToStaticMarkup(<ExplorerLink address={ADDR} />)).toContain(`/address/${ADDR}"`);
  });

  it("is plain text where the chain has no explorer, never a dead link", async () => {
    const ExplorerLink = await load("31337");
    const html = renderToStaticMarkup(<ExplorerLink tx={TX} />);
    expect(html).not.toContain("<a");
    expect(html).toContain("0xabab");
  });
});
