import { test as base } from "@playwright/test";
import { MockChain } from "./mock-chain";

/**
 * The `test` every spec imports (GHO-87).
 *
 * Installs the mock chain on every page before the test runs, so nothing in
 * the browser suite can reach a real network by accident and every spec sees
 * the same deployment. A test that needs a contract to say something else
 * takes the `chain` fixture and changes it before `page.goto`.
 */
export const test = base.extend<{ chain: MockChain }>({
  // `auto`, so specs that never mention the chain still get one.
  chain: [
    async ({ page }, use) => {
      const chain = new MockChain();
      await chain.install(page);
      await use(chain);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
