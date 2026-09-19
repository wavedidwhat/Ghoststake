import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { STATIC_SECURITY_HEADERS, buildCsp, type CspInput } from "../csp";

const prod: CspInput = {
  nonce: "abc123",
  isDev: false,
  apiUrl: "https://api.ghoststake.dev.wavedidwhat.com",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  walletConnect: true,
};

function directive(csp: string, name: string): string[] {
  const found = csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);
  if (!found) throw new Error(`missing directive ${name}`);
  return found.split(" ").slice(1);
}

describe("buildCsp", () => {
  it("forbids framing, the clickjacking drainer's prerequisite", () => {
    expect(directive(buildCsp(prod), "frame-ancestors")).toEqual(["'none'"]);
  });

  it("allows only nonce'd scripts, never inline or eval in production", () => {
    const script = directive(buildCsp(prod), "script-src");
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("adds eval in development only", () => {
    expect(directive(buildCsp({ ...prod, isDev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("closes the classic bypasses", () => {
    const csp = buildCsp(prod);
    expect(directive(csp, "base-uri")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
  });

  it("lets script reach our API, its websocket and the chain, and nothing it does not need", () => {
    const connect = directive(buildCsp(prod), "connect-src");
    expect(connect).toContain("https://api.ghoststake.dev.wavedidwhat.com");
    expect(connect).toContain("wss://api.ghoststake.dev.wavedidwhat.com");
    expect(connect).toContain("https://rpc.testnet.chain.robinhood.com");
    // WalletConnect's analytics.
    expect(connect.some((h) => h.includes("pulse.walletconnect"))).toBe(false);
  });

  it("lets the Coinbase SDK reach its relay, whatever else is configured", () => {
    // `wagmi.ts` registers coinbaseWallet() unconditionally, so unlike the
    // WalletConnect hosts these cannot hang off a flag. Omitting them was
    // GHO-77: the relay socket was blocked, the SDK waits on it without a
    // timeout, and the button never left "Connecting…".
    for (const walletConnect of [true, false]) {
      const connect = directive(buildCsp({ ...prod, walletConnect }), "connect-src");
      expect(connect).toContain("https://www.walletlink.org");
      expect(connect).toContain("wss://www.walletlink.org");
      expect(connect).toContain("https://rpc.wallet.coinbase.com");
    }
  });

  it("keeps the Coinbase popup out of connect-src, since a popup is not a fetch", () => {
    expect(buildCsp(prod)).not.toContain("keys.coinbase.com");
  });

  it("drops every WalletConnect host when WalletConnect is not configured", () => {
    const csp = buildCsp({ ...prod, walletConnect: false });
    expect(csp).not.toMatch(/walletconnect|web3modal/);
    expect(directive(csp, "frame-src")).toEqual(["'none'"]);
  });

  it("does not upgrade requests against a local http stack", () => {
    const local = buildCsp({ ...prod, apiUrl: "http://localhost:8080", rpcUrl: "http://127.0.0.1:8545" });
    expect(local).not.toContain("upgrade-insecure-requests");
    expect(directive(local, "connect-src")).toContain("ws://localhost:8080");
    expect(buildCsp(prod)).toContain("upgrade-insecure-requests");
  });
});

describe("static security headers", () => {
  it("are applied to every path, so a refactor cannot quietly drop them", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    const keys = all?.headers.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "Strict-Transport-Security",
        "X-Frame-Options",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "Permissions-Policy",
      ]),
    );
    expect(STATIC_SECURITY_HEADERS.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
