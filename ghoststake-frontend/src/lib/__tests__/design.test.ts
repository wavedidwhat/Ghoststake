import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A guard for the design rules in DESIGN.md (GHO-58).
 *
 * The violet accent and Geist survived for six weeks because nothing failed
 * when they were there. This is the cheap half of GHO-73: it cannot judge
 * whether a screen looks generated, but it can fail the build when the
 * specific tells we removed come back, or when a component starts inventing
 * its own colours instead of using a token.
 */

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");

function walk(dir: string, match: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, match);
    return match.test(entry) ? [path] : [];
  });
}

const components = walk(SRC, /\.tsx?$/).filter((p) => !p.includes("__tests__"));
const source = (path: string) => readFileSync(path, "utf8");

/**
 * Comments are where these names are supposed to appear — every rule here was
 * worth explaining next to the code that follows it. Only live code counts.
 */
const code = (path: string) =>
  source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("design tokens", () => {
  it("has no violet left anywhere", () => {
    // The whole GHO-12 palette, so a stray `#8b7cf6` in a one-off style
    // cannot creep back in.
    const violet = /#8b7cf6|#a594f9|8b7cf61f/i;
    const offenders = [...components, join(SRC, "app/globals.css")].filter((path) =>
      violet.test(code(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("does not load Geist, Inter, Space Grotesk or Satoshi", () => {
    const banned = /next\/font\/google|\bGeist\b|\bInter\b|Space[_ ]Grotesk|\bSatoshi\b/;
    const offenders = components.filter((path) => banned.test(code(path)));
    expect(offenders).toEqual([]);
  });

  it("serves the three Fontshare faces from local files", () => {
    const layout = source(join(SRC, "app/layout.tsx"));
    expect(layout).toContain("next/font/local");
    for (const family of ["Nippo", "Technor", "Tabular"]) {
      expect(layout).toContain(family);
    }
  });

  it("keeps the font licence beside the font files", () => {
    // The ITF FFL forbids redistribution and subsetting; the licence text
    // travelling with the files is how the next person finds that out.
    expect(source(join(SRC, "fonts/ITF-FFL-LICENSE.txt"))).toContain("ITF Free Font License");
  });

  it("has no hardcoded hex colours in components", () => {
    // Tokens live in globals.css. A hex in a component is how a palette
    // drifts, and it is invisible in review.
    const hex = /#[0-9a-f]{3,8}\b/i;
    // Two files render outside the CSS and so cannot read a token: an OG
    // image is a PNG built by Satori, and `lib/theme.ts` holds the two values
    // the browser and the OS read before any stylesheet (the status-bar tint
    // and the PWA splash). Everything else, the manifest included, imports
    // from there.
    const outsideCss = ["opengraph-image.tsx", "lib/theme.ts"];
    const offenders = components.filter(
      (path) => !outsideCss.some((f) => path.endsWith(f)) && hex.test(code(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("does not ship the Next.js scaffold assets", () => {
    const publicFiles = readdirSync(join(ROOT, "public"));
    for (const scaffold of ["next.svg", "vercel.svg", "globe.svg", "window.svg", "file.svg"]) {
      expect(publicFiles).not.toContain(scaffold);
    }
  });

  it("ships an icon, a maskable icon and a manifest", () => {
    const publicFiles = readdirSync(join(ROOT, "public"));
    expect(publicFiles).toContain("icon-192.png");
    expect(publicFiles).toContain("icon-512.png");
    expect(publicFiles).toContain("icon-maskable-512.png");
    expect(readdirSync(join(SRC, "app"))).toContain("icon.svg");
    expect(source(join(SRC, "app/manifest.ts"))).toContain("maskable");
  });

  it("keeps an arrow beside every answer", () => {
    // Colour alone must never carry the side (GHO-57 rule 2). Both surfaces
    // that name an answer render the glyph from our own icon set.
    for (const path of ["components/RoundCard.tsx", "components/MarketBlock.tsx"]) {
      expect(code(join(SRC, path))).toMatch(/SideArrow|ArrowUp|ArrowDown/);
    }
  });
});

describe("a market is a question (GHO-78)", () => {
  /**
   * The words that came back as a complaint: *"I can't see where the bets like
   * who would win the world cup are"*. Up and Down are the contract's enum and
   * belong in the contract; a person is answering Yes or No.
   *
   * Checked as rendered strings rather than identifiers, so `Side.Up` and
   * `upPool` — which are the chain's vocabulary and have to stay — do not trip
   * it.
   */
  it("says Yes and No in the copy, not Up and Down", () => {
    const offenders: string[] = [];
    for (const path of components.filter((p) => p.endsWith(".tsx"))) {
      const body = code(path);
      // A quoted or JSX-rendered "Up"/"Down" on its own.
      if (/(["'>]\s*)(Up|Down)(\s*[<"'])/.test(body)) offenders.push(path.replace(SRC, ""));
    }
    expect(offenders).toEqual([]);
  });

  it("never shows a payout multiple without the belief beside it", () => {
    // One number without the other reads as odds somebody set, rather than
    // the crowd's own position. Both surfaces that render a multiple render a
    // percentage in the same component.
    for (const path of ["components/RoundCard.tsx", "components/MarketsScreen.tsx"]) {
      const body = code(join(SRC, path));
      expect(body).toMatch(/×/);
      expect(body).toMatch(/%/);
    }
  });
});
