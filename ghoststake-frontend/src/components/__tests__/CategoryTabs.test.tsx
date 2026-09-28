import { describe, expect, it } from "vitest";
import { renderWithMessages } from "@/test/intl";
import type { Category } from "@/lib/marketCategory";
import { CategoryTabs } from "../CategoryTabs";

/**
 * The tabs over the market list (GHO-101). Rendered to markup: the tabs are
 * links, so what matters is which exist, where they point, and which is
 * marked current. The e2e chain serves a single market, which is the case
 * where the row must not appear; the several-kinds case lives here.
 */

const render = (current: Category | undefined, counts: [Category, number][]) =>
  renderWithMessages(
    <CategoryTabs
      current={current}
      counts={new Map(counts)}
      total={counts.reduce((n, [, c]) => n + c, 0)}
    />,
  );

const tabs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe("CategoryTabs", () => {
  it("offers All plus each kind that has a market, in a fixed order", () => {
    const html = render(undefined, [
      ["stocks", 4],
      ["crypto", 2],
    ]);
    expect(tabs(html)).toEqual(["/", "/?c=crypto", "/?c=stocks"]);
    expect(html).not.toContain("Questions");
  });

  it("marks exactly one tab as current", () => {
    const html = render("stocks", [
      ["stocks", 4],
      ["crypto", 2],
    ]);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    // Found by the element, not by attribute order, which React chooses.
    const current = [...html.matchAll(/<a [^>]*>/g)].find((m) => m[0].includes('aria-current="page"'));
    expect(current?.[0]).toContain('href="/?c=stocks"');
  });

  it("draws nothing when every market is the same kind", () => {
    // A row with one real choice is a control that does nothing.
    expect(render(undefined, [["crypto", 3]])).toBe("");
  });

  it("keeps a tab a link asked for, even when it is empty", () => {
    // `/?c=questions` with no questions: the empty state below needs a tab
    // to belong to, and All must be there to get back.
    const html = render("questions", [["crypto", 3]]);
    expect(tabs(html)).toEqual(["/", "/?c=crypto", "/?c=questions"]);
  });

  it("shows how many markets each tab holds", () => {
    const html = render(undefined, [
      ["stocks", 4],
      ["crypto", 2],
    ]);
    expect(html).toMatch(/All<span[^>]*>6</);
    expect(html).toMatch(/Stocks<span[^>]*>4</);
  });
});
