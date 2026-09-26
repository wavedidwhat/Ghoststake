import { describe, expect, it } from "vitest";
import { NAV_LINKS, TAB_LINKS, isCurrent, moreSections, sidebarLinks } from "../nav";

describe("the tab bar", () => {
  it("has four destinations, because five plus More is the ceiling at 390px", () => {
    // 390 ÷ 5 = 78px per target. A fifth destination makes six targets at
    // 65px, which still passes 44px but leaves no room for the label — and
    // Nippo sets wide. This is the constraint, written down.
    expect(TAB_LINKS).toHaveLength(4);
  });

  it("leads with markets and never lists an admin console", () => {
    expect(TAB_LINKS[0].href).toBe("/");
    expect(TAB_LINKS.some((link) => link.operatorOnly)).toBe(false);
  });

  it("gives every tab a label short enough to set", () => {
    // "POSITIO…" shipped once. The rule is a name chosen on purpose rather
    // than a truncation, so nothing in the bar is longer than "Markets".
    for (const link of TAB_LINKS) {
      expect((link.short ?? link.label).length).toBeLessThanOrEqual(8);
    }
  });
});

describe("what More holds", () => {
  it("covers everything the tab bar leaves out", () => {
    const reachable = new Set([
      ...TAB_LINKS.map((l) => l.href),
      ...moreSections(true)
        .flatMap((s) => s.items)
        .map((l) => l.href),
    ]);
    for (const link of NAV_LINKS) {
      expect(reachable.has(link.href)).toBe(true);
    }
  });

  it("hides the operator console from everyone else", () => {
    const hrefs = (isOperator: boolean) =>
      moreSections(isOperator)
        .flatMap((s) => s.items)
        .map((l) => l.href);

    expect(hrefs(false)).not.toContain("/operator");
    expect(hrefs(true)).toContain("/operator");
  });

  it("hides it from the sidebar on the same rule", () => {
    // Two navs disagreeing about what an admin can see is exactly the bug
    // that putting the list in one file was meant to prevent.
    const sidebar = (isOperator: boolean) => {
      const { main, pinned } = sidebarLinks(isOperator);
      return [...main, ...pinned].map((l) => l.href);
    };

    expect(sidebar(false)).not.toContain("/operator");
    expect(sidebar(true)).toContain("/operator");
  });

  it("never leaves an empty section heading behind", () => {
    for (const section of moreSections(false)) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});

describe("the sidebar (GHO-100)", () => {
  it("lists every destination exactly once, pinned or not", () => {
    const { main, pinned } = sidebarLinks(true);
    const hrefs = [...main, ...pinned].map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.sort()).toEqual(NAV_LINKS.map((l) => l.href).sort());
  });

  it("pins the way in for someone new, and leads with markets", () => {
    const { main, pinned } = sidebarLinks(false);
    expect(pinned.map((l) => l.href)).toEqual(["/how-it-works"]);
    expect(main[0].href).toBe("/");
  });

  it("carries no second line of text beside a destination", () => {
    // The notes ("what you have riding") are what made the sidebar scroll
    // and wrapped "Portfolio" into its own description.
    for (const link of NAV_LINKS) expect(link).not.toHaveProperty("note");
  });
});

describe("isCurrent", () => {
  it("marks Markets while reading a market or a round", () => {
    // A tab bar with nothing selected while you stare at a market reads as
    // "you are lost" rather than as "this is a subpage". Round URLs are the
    // shareable unit (GHO-41), so they are the common case.
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/markets/0xabc", "/")).toBe(true);
    expect(isCurrent("/markets/0xabc/3", "/")).toBe(true);
  });

  it("does not mark Markets on every other page", () => {
    // `/` is a prefix of everything, which is why this is not a prefix match.
    for (const path of ["/portfolio", "/stake", "/lend", "/operator"]) {
      expect(isCurrent(path, "/")).toBe(false);
    }
  });

  it("marks a section from its own subpages", () => {
    expect(isCurrent("/portfolio", "/portfolio")).toBe(true);
    expect(isCurrent("/stake/anything", "/stake")).toBe(true);
    expect(isCurrent("/stakeholder", "/stake")).toBe(false);
  });
});
