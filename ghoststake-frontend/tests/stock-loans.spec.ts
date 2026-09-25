import { E2E } from "./mock-chain";
import { expect, test } from "./fixtures";
import { installMockWallet } from "./mock-wallet";

/**
 * The borrow-against-stock screen (GHO-97), on the mock chain's copy of the
 * contract's worked example: 100 TSLA deposited at $400, 40% LTV, 0.5% fee.
 */

const connected = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /0x1111/i });

/**
 * The action button, not the mode toggle that shares its name.
 *
 * Since GHO-96 the mode toggle is a `SegmentedControl`, whose options carry
 * the same words as the button that submits the form — "Borrow" sits above
 * "Borrow", "Withdraw" above "Withdraw". Matching on the name alone finds
 * both, and `.first()` quietly finds the *toggle*, so an assertion that a
 * submit is enabled would pass without ever looking at the submit.
 *
 * A `SegmentedControl` option has `aria-pressed` because it has an on/off
 * state; an action button has none. That is the real difference between the
 * two, not their order on the page.
 */
const action = (page: import("@playwright/test").Page, name: RegExp) =>
  page.getByRole("button", { name }).and(page.locator("button:not([aria-pressed])"));

test.describe("stock loans", () => {
  test("lists each stock with its logo and prices the position", async ({ page }) => {
    await installMockWallet(page);
    await page.goto("/stocks");
    await expect(connected(page)).toBeVisible({ timeout: 20_000 });

    const rows = page.getByRole("list").first();
    await expect(rows.getByRole("button", { name: /TSLA/ })).toBeVisible();
    await expect(rows.getByRole("button", { name: /AMZN/ })).toBeVisible();
    // A real mark, drawn as a path, beside each: not a ticker in a box.
    await expect(rows.getByRole("button", { name: /TSLA/ }).locator("svg path")).toHaveCount(1);
    await expect(rows.getByRole("button", { name: /AMZN/ }).locator("svg path")).not.toHaveCount(0);

    // Figures on a 6-decimal scale (GHO-86): 40,000, not 0.00.
    await expect(page.getByText(/40,000\.00/).first()).toBeVisible();
    await expect(page.getByText(/16,000\.00/).first()).toBeVisible();
    await page.screenshot({ path: `test-results/stocks-${test.info().project.name}.png`, fullPage: true });
  });

  test("states the fee before signing, added to the loan", async ({ page }) => {
    await installMockWallet(page);
    await page.goto("/stocks");
    await expect(connected(page)).toBeVisible({ timeout: 20_000 });

    await page.getByLabel("Amount to receive").fill("10000");
    await expect(page.getByText("Fee, added to your loan")).toBeVisible();
    await expect(page.getByText(/^50\.00 mUSDC$/)).toBeVisible();
    await expect(page.getByText(/^10,050\.00 mUSDC$/)).toBeVisible();
    await expect(action(page, /^Borrow$/)).toBeEnabled();

    // Over the limit once the fee counts: 15,950 + 79.75 > 16,000.
    await page.getByLabel("Amount to receive").fill("15950");
    await expect(page.getByText(/Above your borrow limit/)).toBeVisible();
    await expect(action(page, /^Borrow$/)).toBeDisabled();
  });

  test("a weekend-old price pauses borrowing and says why", async ({ page, chain }) => {
    const twoDaysAgo = () => {
      const t = BigInt(Math.floor(Date.now() / 1000)) - 2n * 86_400n;
      return [1n, 40_000_000_000n, t, t, 1n];
    };
    chain.set(E2E.tslaFeed, "latestRoundData", twoDaysAgo);

    await installMockWallet(page);
    await page.goto("/stocks");
    await expect(connected(page)).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(/TSLA has not traded for over 24h/)).toBeVisible();
    await expect(page.getByText(/Normal when the stock market is closed/)).toBeVisible();
    await page.getByLabel("Amount to receive").fill("100");
    await expect(action(page, /^Borrow$/)).toBeDisabled();
    // With no loan, taking stock back needs no price at all.
    await page.getByRole("group", { name: "Deposit or withdraw stock" }).getByRole("button", { name: /^Withdraw$/ }).click();
    await page.getByLabel("Amount to withdraw").first().fill("1");
    await expect(action(page, /^Withdraw$/).first()).toBeEnabled();
    await page.screenshot({ path: `test-results/stocks-stale-${test.info().project.name}.png`, fullPage: true });
  });

  test("a held stock that cannot be priced is said, not silently dropped", async ({ page, chain }) => {
    chain.revert(E2E.stockVault, "valueOf");
    await installMockWallet(page);
    await page.goto("/stocks");
    await expect(connected(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/could not be read, so the figures above leave it out/)).toBeVisible();
  });
});
