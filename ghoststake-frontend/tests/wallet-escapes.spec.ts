import { expect, test } from "@playwright/test";
import { installMockWallet } from "./mock-wallet";

/**
 * Every wait on a wallet has a way out (GHO-83).
 *
 * The bug these pin is always the same shape: an `await` on a wallet that
 * accepts a request and never answers, with nothing above it bounding the
 * wait. GHO-77 fixed it for connecting and left it in three other places.
 *
 * `useStalled` gives a surface 8 seconds before it offers an escape, so these
 * wait past that deliberately rather than racing it.
 */

const ESCAPE = /stop waiting|hasn.t answered|could not|declined/i;

/**
 * The stall window is 8s, so every assertion about an escape appearing gets
 * comfortably more than that. These are not latency tests — what they pin is
 * that a way out arrives at all, and a tight bound here would make them fail
 * for being on a slow machine rather than for being wrong.
 */
const ESCAPE_TIMEOUT = 30_000;

/** The address chip, which only renders once wagmi has actually connected. */
const connected = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /0x1111/i });

test.describe("a wallet that never answers", () => {
  test("connecting does not pin the app", async ({ page }) => {
    // `eth_accounts` is what wagmi's reconnect() probes on every mount, with
    // no click involved — the GHO-77 trigger.
    await installMockWallet(page, { methods: { eth_accounts: "hang" } });
    await page.goto("/");

    // The connect affordance comes back rather than staying disabled forever.
    const connect = page.getByRole("button", { name: /connect wallet/i });
    await expect(connect).toBeVisible({ timeout: ESCAPE_TIMEOUT });
    await expect(connect).toBeEnabled();
  });

  test("signing in offers a way to stop waiting", async ({ page }) => {
    await installMockWallet(page, { methods: { personal_sign: "hang" } });

    // Sign-in asks the API for a nonce *before* it reaches the wallet, so
    // without this the flow fails at the fetch and never gets to the state
    // under test. Stubbed rather than pointed at a running API: the wallet is
    // what is being tested, and a test that needs a backend up is a test that
    // will be deleted the first time it is inconvenient.
    await page.route("**/api/v1/auth/nonce", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          nonce: "test-nonce",
          message: "ghoststake wants you to sign in",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      }),
    );

    await page.goto("/");

    // No connect dance: wagmi's reconnect() probes on mount and this wallet
    // answers eth_accounts, so the app is already connected by first paint.
    // Only personal_sign hangs, which is the state under test.
    const signIn = page.getByRole("button", { name: /^sign in$/i });
    await expect(signIn).toBeVisible({ timeout: 20_000 });
    await signIn.click();

    // Pinned on "Check your wallet…" before GHO-83, with no control at all.
    await expect(page.getByText(/check your wallet/i)).toBeVisible();
    await expect(page.getByRole("button", { name: ESCAPE })).toBeVisible({
      timeout: ESCAPE_TIMEOUT,
    });

    // And taking the escape actually returns the surface to a usable state.
    await page.getByRole("button", { name: ESCAPE }).click();
    await expect(signIn).toBeVisible();
  });
});

test.describe("a wallet that refuses", () => {
  test("a declined network switch says so", async ({ page }) => {
    // Connected, on a chain the app is not deployed to, and refusing to move.
    await installMockWallet(page, {
      chainIdHex: "0x1",
      methods: { wallet_switchEthereumChain: "reject" },
    });
    await page.goto("/");

    await expect(connected(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/wrong network/i)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /switch to/i }).click();

    // Before GHO-83 this had no error path: isPending went false and nothing
    // was shown, so the button simply looked broken.
    await expect(page.getByText(ESCAPE)).toBeVisible({ timeout: ESCAPE_TIMEOUT });
  });
});
