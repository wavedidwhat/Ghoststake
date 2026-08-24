import { describe, expect, it, vi } from "vitest";
describe("session parsing", () => {
  it("rejects a malformed stored session instead of crashing", async () => {
    // localStorage is writable by the user and by any extension, so a
    // malformed entry is reachable without an exploit. Previously the cast
    // was unchecked and the missing `address` threw during render.
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const { loadSession } = await import("../api");

    for (const bad of [
      "not json at all",
      JSON.stringify({ token: "x" }),
      JSON.stringify({ token: "x", address: "0xabc", expiresAt: "not a date" }),
      JSON.stringify({ token: 1, address: "0xabc", expiresAt: new Date().toISOString() }),
      JSON.stringify(null),
    ]) {
      store.set("ghoststake.session", bad);
      expect(loadSession()).toBeNull();
    }

    vi.unstubAllGlobals();
  });
});
