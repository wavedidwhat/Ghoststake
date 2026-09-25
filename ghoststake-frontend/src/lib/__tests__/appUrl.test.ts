import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The share card's origin (GHO-90).
 *
 * The deployed site served `og:image="http://localhost:3000/opengraph-image"`,
 * so every unfurl fetched from the *reader's* machine and came back blank.
 * Nothing on the site looked wrong, because the only surface that reads this
 * is rendered by somebody else's crawler.
 */
describe("NEXT_PUBLIC_APP_URL", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("is reported as missing when unset, without breaking the app", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const { appUrlMissing, env, envProblems } = await import("../env");

    // The build refuses on this flag. The app does not: localhost is correct
    // for `next dev`, and a blank preview is not worth an error screen over a
    // site that otherwise works.
    expect(appUrlMissing).toBe(true);
    expect(env.appUrl).toBe("http://localhost:3000");
    expect(envProblems.map((p) => p.variable)).not.toContain("NEXT_PUBLIC_APP_URL");
  });

  it("accepts the deployed origin and reports nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://ghoststake.dev.wavedidwhat.com");
    const { appUrlMissing, env, envProblems } = await import("../env");

    expect(appUrlMissing).toBe(false);
    expect(env.appUrl).toBe("https://ghoststake.dev.wavedidwhat.com");
    expect(envProblems).toEqual([]);
  });

  it("refuses a value that is not an absolute URL", async () => {
    // `new URL(env.appUrl)` in the root layout throws on this, which is a
    // blank 500 on every page — a worse failure than a bad preview, and the
    // reason this one *is* a recorded problem.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "ghoststake.dev.wavedidwhat.com");
    const { envProblems } = await import("../env");

    expect(envProblems).toEqual([
      expect.objectContaining({
        variable: "NEXT_PUBLIC_APP_URL",
        reason: expect.stringMatching(/absolute URL/),
      }),
    ]);
  });

  it("refuses a scheme no crawler will follow", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "mailto:someone@example.com");
    const { envProblems } = await import("../env");

    expect(envProblems.map((p) => p.variable)).toEqual(["NEXT_PUBLIC_APP_URL"]);
  });

  it("is passed to the image the same way the deployment builds it", async () => {
    // The regression itself: the variable was absent from the Dockerfile and
    // from docker-compose.yml, so the deployed bundle had the localhost
    // default inlined. A unit test cannot see a Dockerfile, so this asserts
    // the two files that carry it still do.
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
    const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");

    expect(dockerfile).toContain("ARG NEXT_PUBLIC_APP_URL");
    expect(dockerfile).toContain("ENV NEXT_PUBLIC_APP_URL=");
    expect(compose).toMatch(/NEXT_PUBLIC_APP_URL:\s*\$\{NEXT_PUBLIC_APP_URL:-https:\/\//);
  });
});
