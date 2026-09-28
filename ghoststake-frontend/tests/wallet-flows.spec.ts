import { E2E } from "./mock-chain";
import { expect, test } from "./fixtures";
import { installMockWallet } from "./mock-wallet";

/**
 * A market on screen, a wallet connected, a button pressed (GHO-87).
 *
 * Nothing in this repo had ever clicked through to a transaction: CI has no
 * chain, so every page stopped at "not deployed here". The mock chain puts one
 * market with one open round behind a fixed build (tests/e2e.env), and these
 * walk the paths the 2026-09-19 sweep found broken. Each one was checked to
 * fail with its fix reverted — see runbook Part 7.80.
 *
 * The rest of that sweep is pinned elsewhere: a wallet that never answers
 * `eth_accounts` and a declined network switch in wallet-escapes.spec.ts, and
 * the render-throw boundary in errors.spec.ts. A hanging `signMessage` has no
 * test because it has no surface — GHO-84 removed sign-in.
 */

const MARKET_URL = `/markets/${E2E.market}`;
const ESCAPE = /stop waiting|hasn.t answered|could not|declined/i;

const connected = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /0x1111/i });

async function openTicket(page: import("@playwright/test").Page, side: "Yes" | "No" = "Yes") {
  await page.goto(MARKET_URL);
  await expect(connected(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: new RegExp(`^${side}\\b`) }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("taking a position", () => {
  test("figures are on the token's scale", async ({ page }) => {
    // 5,000 of a 6-decimal token formatted at 18 decimals is 0.00.
    await installMockWallet(page);
    await openTicket(page);
    await expect(page.getByRole("dialog").getByText(/Wallet\s*5,000\.00/)).toBeVisible();
  });

  test("an over-precise amount says so instead of becoming zero", async ({ page }) => {
    await installMockWallet(page);
    await openTicket(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("From your wallet").fill("1.1234567");

    await expect(dialog.getByText("This token has 6 decimal places; that amount has 7.")).toBeVisible();
    // Before GHO-86 the refusal was coerced to zero: the button read
    // "Back Yes · 0.00" beside a field showing 1.1234567.
    const commit = dialog.getByRole("button", { name: /^Back Yes/ });
    await expect(commit).toBeDisabled();
    await expect(commit).not.toContainText("0.00");
  });

  test("a wallet that never answers a transaction leaves a way out", async ({ page }) => {
    // GHO-83: useTransaction awaited the wallet with no bound, behind every
    // write in the app.
    await installMockWallet(page, { methods: { eth_sendTransaction: "hang" } });
    await openTicket(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("From your wallet").fill("10");
    await dialog.getByRole("button", { name: /back yes/i }).click();

    await expect(dialog.getByText(ESCAPE)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("a read that has not resolved", () => {
  test("no figure is formatted before the token's scale is known", async ({ page, chain }) => {
    // The GHO-86 regression, pinned where it lived. The portfolio renders
    // before `decimals` resolves, and its pipeline strip asserted the scale
    // with `!` — so `formatAmount` fell back to its old default of 18 and
    // 1,000 staked mUSDC rendered as 0.00 for as long as the read took.
    // Holding the read open keeps that window open long enough to look.
    await installMockWallet(page);
    chain.hold(E2E.asset, "decimals");
    await page.goto("/portfolio");
    await expect(connected(page)).toBeVisible({ timeout: 20_000 });

    // Every other read has answered by now; only the scale is outstanding.
    await expect.poll(() => chain.calls.includes(`${E2E.vault}.collateralValue`)).toBe(true);
    await page.waitForTimeout(1_000);
    // Any zero-point figure. The first draft matched `0.000` and up, passed
    // against the regression it was written for — which rendered `0.00` — and
    // was only caught by running it with the fix reverted.
    await expect(page.getByText(/(^|[^\d,.])0\.00/)).toHaveCount(0);
  });
});

test.describe("a market that cannot be fully read", () => {
  test("unreadable terms render a message, not an empty space", async ({ page, chain }) => {
    // GHO-82: MarketBlock returned null when params failed, so the market
    // simply was not there.
    chain.revert(E2E.market, "rake");
    await page.goto(MARKET_URL);
    await expect(page.getByText(/terms could not be read/i)).toBeVisible({ timeout: 20_000 });
  });

  test("a rate-limited faucet probe does not hide the faucet for good", async ({ page, chain }) => {
    // GHO-86: one failed probe read as "a real ERC-20" for the session.
    // A probe that errors without a revert must not be taken as an answer.
    await installMockWallet(page);
    await page.route(E2E.rpcUrl, async (route) => {
      const body = route.request().postData() ?? "";
      // The mint simulation, and only it, fails the way a 429 does.
      if (body.includes("40c10f19")) return route.fulfill({ status: 429, body: "Too Many Requests" });
      return route.fallback();
    });
    await page.goto("/stake");
    await expect(connected(page)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(/could not check whether test mUSDC can be minted/i)).toBeVisible({
      timeout: 30_000,
    });

    // The network comes back; asking again finds the faucet.
    await page.unroute(E2E.rpcUrl);
    await chain.install(page);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("button", { name: /Get 10,000 mUSDC/ })).toBeVisible({ timeout: 20_000 });
  });
});
