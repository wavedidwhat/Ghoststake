import { expect, test } from "./fixtures";
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
 *
 * There was a third spec here, for a hanging SIWE sign-in. GHO-84 removed the
 * sign-in itself — nothing in the app read the session it produced — so the
 * spec went with it rather than being kept green against a button nobody can
 * press. The escape it exercised is the same `useStalled` the two below use.
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

    // Wait for the *stall*, not for the button. "Connect wallet" is also what
    // the server renders, before hydration starts wagmi's reconnect — so
    // waiting for the button could resolve on that first frame, and the next
    // assertion then met a disabled "Connecting…" for the whole stall window.
    // Locally hydration beats the load event and the race never showed; on a
    // loaded CI runner it failed about one run in two. The hint only exists
    // once the wallet has been given up on, so it cannot be seen early.
    await expect(page.getByText(/your wallet didn.t respond/i)).toBeVisible({
      timeout: ESCAPE_TIMEOUT,
    });

    // And the affordance that comes back is usable, not a disabled button.
    const connect = page.getByRole("button", { name: /connect wallet/i });
    await expect(connect).toBeEnabled();
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
