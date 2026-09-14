import type { NextConfig } from "next";
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

export default nextConfig;
