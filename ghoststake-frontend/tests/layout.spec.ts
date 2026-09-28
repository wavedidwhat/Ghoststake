import { expect, test } from "./fixtures";

/**
 * Every route, at 390px and at 1440px (GHO-59).
 *
 * What these assert is deliberately narrow: no horizontal scroll, the right
 * nav for the viewport, and tap targets big enough to hit. They cannot tell
 * whether a screen looks good — that is a human's job, and GHO-73's — but
 * they can tell whether it is *usable*, which is what regressed silently
 * before.
 *
 * No wallet and, in CI, no chain. Every route renders its disconnected or
 * unreachable state, which is exactly the state a first-time visitor sees, so
 * it is worth pinning. Anything that needs a connected wallet is covered by
 * the vitest suite instead.
 */

const ROUTES = [
  "/",
  "/portfolio",
  "/how-it-works",
  "/stake",
  "/borrow",
  "/positions",
  "/activity",
  "/lend",
  "/liquidate",
  "/operator",
];

for (const route of ROUTES) {
  test(`${route} has no horizontal scroll`, async ({ page }) => {
    await page.goto(route);
    // The heading is the app's own, so this waits for the shell rather than
    // for an arbitrary timeout.
    await expect(page.locator("h1")).toBeVisible();

    // Polled rather than measured once. These pages read the chain, so a
    // figure can arrive after first paint and widen its row for a frame;
    // against a slow local node that produced a failure that would not
    // reproduce, which is worse than no test at all. What must hold is that
    // the page settles without overflow, not that it never overflows mid-load.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const doc = document.documentElement;
            return {
              over: doc.scrollWidth - doc.clientWidth,
              // Whatever is actually wider than the viewport, named, so a
              // failure says which element to go and look at.
              widest: [...document.querySelectorAll("body *")]
                .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
                .slice(0, 3)
                .map(
                  (el) =>
                    `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 60)}`,
                ),
            };
          }),
        { timeout: 5_000, message: `${route} overflows its viewport` },
      )
      // One pixel of slack: sub-pixel layout rounding is not a bug.
      .toEqual({ over: expect.any(Number), widest: [] });

    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(1);
  });
}

test.describe("phone", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, "phone layout only");

  test("navigates with a bottom tab bar, not a sidebar", async ({ page }) => {
    await page.goto("/");

    const tabs = page.getByRole("navigation", { name: "Primary" });
    await expect(tabs).toBeVisible();

    // The sidebar, found by its nav's name. This used to find it by its
    // tagline, which GHO-100 removed; left as it was, "the tagline is hidden"
    // would have passed forever on every viewport and checked nothing.
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

    // Every target at least 44px tall, which is the smallest thing a thumb
    // hits reliably.
    for (const link of await tabs.getByRole("link").all()) {
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("no tab label is clipped", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();

    // Five tabs across 390px leaves about 70px each, and Nippo sets wide, so
    // a label one word too long silently becomes "MARKE…". That happened to
    // Overview, Positions and Markets in turn; the first two got shorter
    // names and the type got smaller.
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("nav[aria-label='Primary'] span")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent?.trim()),
    );
    expect(clipped).toEqual([]);
  });

  test("the tab bar sits above the page, and More reaches everything else", async ({ page }) => {
    await page.goto("/");

    const tabs = page.getByRole("navigation", { name: "Primary" });
    const viewport = page.viewportSize()!;

    // Pinned to the bottom of the screen, not welded to its edge: the pill
    // floats with a gap under it, which is where the iOS home bar goes. What
    // matters is that it stays in the thumb zone rather than scrolling away.
    //
    // Polled, because the measurement raced the stylesheet. Before CSS
    // applies, the nav is still in normal flow at the end of a long page —
    // measured there it sat 447px below the fold, which reads as "the tab bar
    // scrolled away" and is really "the test was early".
    await expect
      .poll(
        async () => {
          const bar = await tabs.boundingBox();
          return bar === null ? null : viewport.height - (bar.y + bar.height);
        },
        { timeout: 5_000, message: "the tab bar never settled at the bottom of the screen" },
      )
      .toBeGreaterThanOrEqual(0);

    const bar = (await tabs.boundingBox())!;
    expect(viewport.height - (bar.y + bar.height)).toBeLessThan(40);

    // Clicked until it takes. Server-rendered HTML is interactive-looking
    // before React attaches, so a tap that lands during hydration does
    // nothing at all — under four parallel workers against a local chain that
    // window is wide enough to fail the run about one time in three. This is
    // the same race a real user hits on a slow phone, so retrying is the
    // honest test rather than a sleep.
    const sheet = page.getByRole("dialog");
    await expect(async () => {
      await page.getByRole("button", { name: "More" }).click();
      await expect(sheet).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    // Lend is a tab now (GHO-62) and Operator is hidden unless the connected
    // wallet owns a market, so neither belongs in this list.
    for (const label of ["Borrow", "Activity", "Liquidate", "How it works"]) {
      await expect(sheet.getByRole("link", { name: new RegExp(label) })).toBeVisible();
    }
    await expect(sheet.getByRole("link", { name: /Operator/ })).toBeHidden();

    // Escape closes it. The sheet is a `<dialog>`, so this is the platform's
    // behaviour and not ours — worth pinning precisely because it is easy to
    // break by reaching for a div later.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("the primary action on a form is reachable without scrolling", async ({ page }) => {
    await page.goto("/stake");
    await expect(page.locator("h1")).toBeVisible();

    // Disconnected, so the wallet prompt is the primary action. Matched on
    // the full label, not /connect/: wagmi renders "Connecting…" first and
    // then replaces that node, so the looser pattern grabbed an element that
    // was detached by the time it was measured.
    const connect = page.getByRole("button", { name: /connect wallet/i }).first();
    await expect(connect).toBeVisible();
    const box = (await connect.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.y).toBeLessThan(page.viewportSize()!.height);
  });

  test("ledgers stack instead of scrolling sideways", async ({ page }) => {
    for (const route of ["/positions", "/activity", "/liquidate"]) {
      await page.goto(route);
      await expect(page.locator("h1")).toBeVisible();
      // The wide table is the desktop form and must be hidden here. Either
      // the page shows the stacked list, or it shows an empty/needs-wallet
      // state — but never a table someone has to drag.
      await expect(page.locator("table")).toBeHidden();
    }
  });
});

test.describe("routes", () => {
  test("the old markets URL still lands on the feed", async ({ page }) => {
    // The feed moved to `/` (GHO-62). Every link ever shared to `/markets`
    // has to keep working, including a cached page's own sidebar.
    await page.goto("/markets");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("h1")).toHaveText(/Markets/);
  });

  test("a shared round link is untouched", async ({ page }) => {
    // GHO-41's shareable unit. A redirect that swallowed these would break
    // every link anyone has posted.
    const response = await page.goto("/markets/0x0000000000000000000000000000000000000001/1");
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/markets\/0x0{39}1\/1$/);
  });
});

test.describe("category tabs (GHO-101)", () => {
  // The e2e chain serves one market, an ETH/USD price market. That is
  // exactly the case where the tab row must not be drawn: one kind of market
  // leaves nothing to choose between. The several-kinds case is a component
  // test (CategoryTabs.test.tsx).
  test("are not drawn when every market is the same kind", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /ETH/ }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("navigation", { name: "Categories" })).toHaveCount(0);
  });

  test("a link to an empty tab says so, and offers the way back", async ({ page }) => {
    await page.goto("/?c=stocks");
    await expect(page.getByText(/Nothing under Stocks right now/)).toBeVisible({ timeout: 20_000 });

    const tabs = page.getByRole("navigation", { name: "Categories" });
    await expect(tabs.getByRole("link", { name: /^Stocks/ })).toHaveAttribute("aria-current", "page");
    // The ETH market is not shown under Stocks...
    await expect(page.locator('a[href^="/markets/"]')).toHaveCount(0);

    // ...and one tap on All brings it back.
    await tabs.getByRole("link", { name: /^All/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('a[href^="/markets/"]').first()).toBeVisible();
  });

  test("an unknown category is All, not an empty page", async ({ page }) => {
    await page.goto("/?c=nonsense");
    await expect(page.locator('a[href^="/markets/"]').first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("desktop", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, "desktop layout only");

  test("keeps the sidebar and hides the tab bar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  });

  test("the sidebar fits a laptop window without scrolling (GHO-100)", async ({ page }) => {
    // 1366×768 is still the most common laptop screen; with the browser's
    // own bars that leaves about 650px. The nav used to need a scrollbar
    // here, because every item carried a note and every group a heading.
    await page.setViewportSize({ width: 1366, height: 650 });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();

    const { scroll, client, rows } = await nav.evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
      rows: el.querySelectorAll("a").length,
    }));
    expect(rows).toBeGreaterThan(5);
    expect(scroll).toBeLessThanOrEqual(client);

    // One line per item: a label that wraps is the bug in the screenshot
    // that started this ("Portfolio" running into its note).
    const heights = await nav.locator("a").evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    expect(new Set(heights.map(Math.round)).size).toBe(1);
  });

  test("the sidebar stays put while the page scrolls", async ({ page }) => {
    // The shell was `flex min-h-dvh`, and a flex child stretches to its
    // tallest sibling: on any page longer than the window the sidebar grew to
    // the page's height and scrolled away with it, taking the nav with it.
    // A short window makes any overflowing route show it.
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.goto("/how-it-works");
    await expect(page.locator("aside")).toBeVisible();

    const box = await page.evaluate(() => {
      const docHeight = document.documentElement.scrollHeight;
      window.scrollTo(0, docHeight);
      const r = document.querySelector("aside")!.getBoundingClientRect();
      return { docHeight, scrolled: window.scrollY, top: r.top, height: r.height };
    });

    // Guard the premise: a page that fits the window proves nothing.
    expect(box.scrolled).toBeGreaterThan(100);
    // Within half a pixel, not exactly 0: the page's height is fractional and
    // scroll positions are whole pixels, so a sticky element can sit a
    // quarter-pixel above the top at the very bottom of the page. The bug
    // this pins was -402.
    expect(Math.abs(box.top)).toBeLessThan(0.5);
    expect(box.height).toBe(600);
  });

  test("navigating keeps the same frame rather than rebuilding it", async ({ page }) => {
    // Each screen used to render its own shell, so every navigation tore the
    // sidebar down and built a new one. Mark the element, move, and check the
    // mark survived.
    await page.goto("/how-it-works");
    const aside = page.locator("aside");
    await expect(aside).toBeVisible();
    await aside.evaluate((el) => el.setAttribute("data-probe", "kept"));

    await aside.getByRole("link", { name: /^Deposit/ }).click();
    await expect(page).toHaveURL(/\/stake$/);
    await expect(page.getByRole("heading", { level: 1, name: "Deposit" })).toBeVisible();

    await expect(page.locator("aside")).toHaveAttribute("data-probe", "kept");
  });
});
