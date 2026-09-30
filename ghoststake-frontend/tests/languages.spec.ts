import { expect, test } from "./fixtures";

/**
 * The app in the visitor's language (GHO-128).
 *
 * The catalogs themselves are checked in vitest (translations.test.ts). What
 * only a browser can show is the choosing: that the browser's language is
 * honoured with no cookie, that the switcher's choice wins and survives a
 * reload, and that figures change separators with the words, since a
 * Spanish page printing "1,500" means one and a half.
 */

test.describe("with a Spanish browser", () => {
  test.use({ locale: "es-ES" });

  test("serves Spanish, figures included", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mercados");
    // The demo round's pool, from the mock chain: 300 mUSDC on Yes, written
    // the Spanish way. "300.00" here would be a separator a Spanish reader
    // takes for thousands.
    await expect(page.locator("main")).toContainText("300,00");
    await expect(page.locator("main")).not.toContainText("300.00");
  });
});

test.describe("with a Traditional Chinese browser", () => {
  test.use({ locale: "zh-TW" });

  test("falls back to English rather than a different script", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

test.describe("with a Singapore Chinese browser", () => {
  test.use({ locale: "zh-SG" });

  test("serves Simplified Chinese", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  });
});

test("the switcher's choice wins, and outlasts a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/markets");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.getByLabel("Language").filter({ visible: true }).selectOption("pt-BR");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mercados");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByLabel("Idioma").filter({ visible: true })).toHaveValue("pt-BR");
});
