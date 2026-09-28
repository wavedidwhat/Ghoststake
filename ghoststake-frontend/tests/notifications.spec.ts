import { expect, test } from "./fixtures";
import { installMockWallet } from "./mock-wallet";

/**
 * Transaction toasts (GHO-104).
 *
 * Driven through the faucet's mint, which is a real send through the same
 * `useTransaction` every write uses. The inline status line under the button
 * says "Confirmed." and the revert message too, so these look inside the
 * toast itself, not just anywhere on the page.
 */

const toast = (page: import("@playwright/test").Page) => page.locator("[data-sonner-toast]");

test.describe("transaction toasts", () => {
  test("a confirmed transaction says so in a toast", async ({ page }) => {
    await installMockWallet(page);
    await page.goto("/stake");
    await page.getByRole("button", { name: /Get 10,000 mUSDC/ }).click({ timeout: 20_000 });

    await expect(toast(page).getByText("Confirmed", { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test("a reverted transaction says so, and is not dressed up as success", async ({ page, chain }) => {
    chain.revertTransactions();
    await installMockWallet(page);
    await page.goto("/stake");
    await page.getByRole("button", { name: /Get 10,000 mUSDC/ }).click({ timeout: 20_000 });

    await expect(toast(page).getByText(/reverted on chain/)).toBeVisible({ timeout: 20_000 });
    await expect(toast(page).getByText("Confirmed", { exact: true })).toHaveCount(0);
  });

  test("a request declined in the wallet leaves no toast behind", async ({ page }) => {
    await installMockWallet(page, { methods: { eth_sendTransaction: "reject" } });
    await page.goto("/stake");
    await page.getByRole("button", { name: /Get 10,000 mUSDC/ }).click({ timeout: 20_000 });

    // The inline line reports the cancel; the toast layer stays empty.
    await expect(page.getByText("Cancelled.")).toBeVisible({ timeout: 20_000 });
    await expect(toast(page)).toHaveCount(0);
  });
});

test.describe("the bell", () => {
  test("is there for a connected wallet, and says when nothing needs you", async ({ page }) => {
    await installMockWallet(page);
    await page.goto("/stake");
    // The mock wallet has no debt and nothing to claim.
    const bell = page.getByRole("button", { name: /Notifications, none/ });
    await bell.click({ timeout: 20_000 });
    await expect(page.getByRole("dialog").getByText(/Nothing needs you right now/)).toBeVisible();
  });

  test("warns when loan health falls below 1.5, and links to the fix", async ({ page, chain }) => {
    // 1.30: inside the caution band, above danger.
    chain.set("0x00000000000000000000000000000000000e2e01", "healthFactor", 13n * 10n ** 17n);
    chain.set("0x00000000000000000000000000000000000e2e01", "lienOf", 100_000_000n);
    await installMockWallet(page);
    await page.goto("/stake");

    await page.getByRole("button", { name: /Notifications, 1/ }).click({ timeout: 20_000 });
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Loan health 1.30")).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Deposit more or repay" })).toHaveAttribute("href", "/borrow");
  });

  test("is not there without a wallet", async ({ page }) => {
    await page.goto("/stake");
    await expect(page.getByRole("heading", { level: 1, name: "Deposit" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Notifications/ })).toHaveCount(0);
  });
});
