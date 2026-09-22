import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { configProblems } from "./src/lib/config";
import { STATIC_SECURITY_HEADERS } from "./src/lib/csp";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a minimal server.js and only the traced
  // node_modules, so the runtime image doesn't need an install step.
  output: "standalone",

  // Advertising the framework and version helps nobody but a scanner.
  poweredByHeader: false,

  // The CSP is per request and lives in src/proxy.ts; these never change.
  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }];
  },
};

/**
 * A production build refuses to finish with a variable it cannot use (GHO-85).
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so the build is the
 * earliest and cheapest place a bad one can be caught — earlier than any page
 * a user could see. It already refused, but by accident: `env.ts` threw at
 * module scope, and Next happens to evaluate route modules while collecting
 * page configuration. Once those modules stopped throwing (so `next dev` and
 * anything that slips past the build can render the problem by name), the
 * refusal had to be stated here or it would have silently gone away.
 *
 * Every problem at once, rather than the first a module happened to evaluate.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD && configProblems.length > 0) {
    const list = configProblems.map((p) => `  ${p.variable}=${JSON.stringify(p.value)} ${p.reason}`);
    throw new Error(`Refusing to build with unusable configuration:\n${list.join("\n")}`);
  }
  return nextConfig;
}
