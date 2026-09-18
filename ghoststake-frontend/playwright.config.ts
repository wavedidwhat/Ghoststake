import { defineConfig, devices } from "@playwright/test";

/**
 * Layout tests (GHO-59). Separate from the vitest suite, which is unit-level
 * and has no browser.
 *
 * Two viewports, because the bug this issue fixes only exists at one of them:
 * 390×844 is an iPhone 15/16 in CSS pixels, and 1440×900 is the desktop the
 * app was built against. `pnpm test:layout` starts the production server
 * itself — the dev server serves different HTML (no CSP nonce) and is slower
 * to first paint, which makes screenshot diffs noisy.
 *
 * Why not headless Chrome via `--screenshot`, which the repo already used:
 * on macOS it clamps the window to 500px wide, so a "390px" screenshot taken
 * that way is actually 500px and quietly passes a layout that is broken on
 * every real phone. That cost me two rounds of screenshots that looked fine.
 */
export default defineConfig({
  testDir: "./tests",
  // A layout that only holds together when run alone is not a layout.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://127.0.0.1:3311",
    // Screenshots are the artefact worth keeping from a failure here.
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "phone",
      // Chromium with phone metrics rather than `devices["iPhone 15"]`: that
      // descriptor defaults to WebKit, which isn't installed here, so every
      // phone test failed in milliseconds with a launch error rather than a
      // layout failure. `isMobile` is what turns on the mobile viewport
      // meta handling, and it is Chromium-only.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: {
    // CI has already built in an earlier step, so building again there would
    // double the slowest part of the job for nothing. Locally there may be no
    // build at all, so one happens first.
    command: process.env.CI
      ? "pnpm exec next start --port 3311"
      : "pnpm build && pnpm exec next start --port 3311",
    url: "http://127.0.0.1:3311",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
