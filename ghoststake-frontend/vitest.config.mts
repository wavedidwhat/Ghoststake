import { fileURLToPath } from "node:url";
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
  // The `@/` alias `tsconfig.json` and Next both understand.
  //
  // Absent until GHO-91, which is why no component importing runtime code
  // through it had a unit test: a type-only `@/` import is erased by the
  // transform and resolves fine, so the gap looked like a choice rather than
  // four missing lines.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
