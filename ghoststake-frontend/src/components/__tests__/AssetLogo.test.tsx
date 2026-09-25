import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetLogo, hasLogo } from "../AssetLogo";

/**
 * Every asset the Robinhood deployment lists has a real mark (GHO-97), and
 * anything else gets its ticker rather than somebody else's logo.
 */
describe("AssetLogo", () => {
  it("has a logo for every listed stock and the stablecoin", () => {
    for (const s of ["TSLA", "AMZN", "AMD", "PLTR", "NFLX", "mUSDC", "USDC", "ETH"]) {
      expect(hasLogo(s), s).toBe(true);
    }
  });

  it("draws a brand mark as an svg path, not a letter", () => {
    const html = renderToStaticMarkup(<AssetLogo symbol="AMZN" />);
    expect(html).toContain("<path");
    expect(html).toContain("var(--color-logo-amazon)");
  });

  it("falls back to the ticker for an unknown symbol", () => {
    expect(hasLogo("XYZQ")).toBe(false);
    const html = renderToStaticMarkup(<AssetLogo symbol="xyzq" />);
    expect(html).not.toContain("<svg");
    expect(html).toContain("XYZQ");
  });
});
