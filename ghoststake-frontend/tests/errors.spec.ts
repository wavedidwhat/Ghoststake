import { expect, test } from "./fixtures";

/**
 * A failure renders a stated screen, not a blank page (GHO-85).
 *
 * Before this there was no `error.tsx`, `global-error.tsx` or `not-found.tsx`
 * anywhere, and nothing in the repo exercised a render throw — so the absence
 * was invisible until someone hit it. `/e2e/throw` exists only because the
 * web server below is started with `GHOSTSTAKE_E2E=1`.
 */

test("a component that throws renders the error screen, with a way out", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/e2e/throw");

  await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toBeVisible();
  await expect(page.getByText(/Your money hasn’t moved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // The way out works, and lands on the app rather than another error.
  await page.getByRole("link", { name: "Go to markets" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toHaveCount(0);
});

test("a malformed market URL is a 404 with a way home", async ({ page }) => {
  const response = await page.goto("/markets/not-an-address");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to markets" })).toBeVisible();
});

test("a malformed round URL is a 404", async ({ page }) => {
  const response = await page.goto(
    "/markets/0x4650029f444997f76f4c6e0e0159865582da6ab5/not-a-round",
  );
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
});

test("an unmatched path is the same 404, not the framework's", async ({ page }) => {
  const response = await page.goto("/this/does/not/exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
});
