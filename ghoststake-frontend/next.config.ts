import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a minimal server.js and only the traced
  // node_modules, so the runtime image doesn't need an install step.
  output: "standalone",
};

export default nextConfig;
