import Link from "next/link";

import { CATEGORIES, type Category } from "@/lib/marketCategory";

/**
 * All · Crypto · Stocks · Questions, over the list (GHO-101).
 *
 * The row every comparable market has: Polymarket, Kalshi, Limitless and
 * Myriad all put their categories here. Links, not buttons: the tab is in the
 * URL, so a shared "look at the stocks" link opens on the stocks, and back
 * goes back. `scroll={false}` because switching a filter should not jump the
 * page to the top.
 *
 * Only categories that have a market get a tab, and the row is not drawn at
 * all when there is only one kind: a tab that leads to nothing is a dead end
 * that looks like an option. The one exception is the tab a link asked for,
 * which stays so the empty state below has a tab to belong to.
 */
export function CategoryTabs({
  current,
  counts,
  total,
}: {
  current: Category | undefined;
  counts: Map<Category, number>;
  total: number;
}) {
  const shown = CATEGORIES.filter((c) => (counts.get(c.value) ?? 0) > 0 || c.value === current);
  if (shown.length < 2 && !current) return null;

  const tabs = [
    { href: "/", label: "All", count: total, on: current === undefined },
    ...shown.map((c) => ({
      href: `/?c=${c.value}`,
      label: c.label,
      count: counts.get(c.value) ?? 0,
      on: current === c.value,
    })),
  ];

  return (
    <nav aria-label="Categories" className="-mt-1 border-b border-border">
      <ul className="flex gap-5 overflow-x-auto">
        {tabs.map((tab) => (
          <li key={tab.href} className="shrink-0">
            <Link
              href={tab.href}
              scroll={false}
              aria-current={tab.on ? "page" : undefined}
              // The current tab is marked by weight and an underline as well
              // as colour. Ink, not brand: red is the wordmark's and the
              // countdown's, and a red underline would read as an alert.
              className={`-mb-px flex min-h-11 items-center gap-1.5 border-b-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none ${
                tab.on
                  ? "border-ink font-medium text-ink"
                  : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {tab.label}
              <span className="tabular text-xs text-ink-faint">{tab.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
