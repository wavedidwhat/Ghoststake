import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Misconfigured } from "../Misconfigured";

/**
 * The screen a misconfigured deployment shows instead of itself (GHO-85).
 * Rendered to markup rather than in a browser: proving it in Playwright would
 * need a second production build with a broken variable baked in.
 */
describe("Misconfigured", () => {
  it("names each variable and the value it was built with", () => {
    const html = renderToStaticMarkup(
      <Misconfigured
        problems={[
          { variable: "NEXT_PUBLIC_VAULT_ADDRESS", value: "0xabc", reason: "is not a 20-byte hex address" },
          { variable: "NEXT_PUBLIC_CHAIN_ID", value: "sepolia", reason: "is not a positive integer chain id" },
        ]}
      />,
    );
    expect(html).toContain("This deployment is misconfigured");
    expect(html).toContain("NEXT_PUBLIC_VAULT_ADDRESS");
    expect(html).toContain("&quot;0xabc&quot;");
    expect(html).toContain("NEXT_PUBLIC_CHAIN_ID");
    expect(html).toContain("&quot;sepolia&quot;");
  });
});
