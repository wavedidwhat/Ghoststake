import { defineConfig } from "vitest/config";

/**
 * The unit suite is `src/**` only.
 *
 * Without this, vitest also collected `tests/layout.spec.ts` and failed on
 * Playwright's `test()` — two runners, two meanings of the same global. The
 * layout suite runs under `pnpm test:layout`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
