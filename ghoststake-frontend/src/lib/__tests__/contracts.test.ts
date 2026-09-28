import messages from "../../../messages/en.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file re-imports modules after `vi.resetModules()`, which reloads wagmi
// and viem's chain list from cold on every test. Alone that is quick; in the
// full parallel suite it can pass vitest's 5s default, and a timeout reads as
// a broken assertion (GHO-103, and likely the unexplained config/markets/wagmi
// failure in runbook Part 7.92). The limit is raised for this pattern only.
vi.setConfig({ testTimeout: 30_000 });

/**
 * The "Check it yourself" list (GHO-103). With nothing configured the list is
 * empty and any assertion about it passes vacuously, so these stub a
 * deployment first, the way config.test.ts does.
 */

const VAULT = "0x0ea31e490f9a9a21d2410add76668e4c2c24ba0e";
const POOL = "0x1111111111111111111111111111111111111111";
const STOCKS = "0x2222222222222222222222222222222222222222";

describe("deployedContracts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "11155111");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lists exactly the contracts this deployment is configured with", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAULT_ADDRESS", VAULT);
    vi.stubEnv("NEXT_PUBLIC_POOL_ADDRESS", POOL);
    vi.stubEnv("NEXT_PUBLIC_STOCK_VAULT_ADDRESS", STOCKS);
    const { deployedContracts } = await import("../contracts");

    expect(deployedContracts().map((c) => c.address.toLowerCase())).toEqual([VAULT, POOL, STOCKS]);
  });

  it("leaves out what isn't configured, rather than listing a blank", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAULT_ADDRESS", VAULT);
    const { deployedContracts } = await import("../contracts");

    expect(deployedContracts().map((c) => c.id)).toEqual(["vault"]);
  });

  it("says what each one does, in a sentence", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAULT_ADDRESS", VAULT);
    vi.stubEnv("NEXT_PUBLIC_POOL_ADDRESS", POOL);
    const { deployedContracts } = await import("../contracts");

    for (const c of deployedContracts()) expect(messages.contracts[c.id].role).toMatch(/^[A-Z].*\.$/);
  });
});
