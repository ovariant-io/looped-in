import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for a slim Docker image
  output: "standalone",
  // Cache Components (PPR) is DISABLED for the AWS/SST deployment: OpenNext does not yet
  // support PPR resume (https://opennext.js.org), so it serves only the static shell and
  // never streams the dynamic <Suspense> continuation — the browser then throws
  // "Connection closed" and dynamic UI (e.g. the Clerk auth nav) never renders. Routes run
  // as standard dynamic SSR instead. No code uses `use cache` yet, so this is behavior-neutral
  // beyond losing the static-shell optimization. Re-enable if the frontend moves to Vercel
  // (native PPR) or once OpenNext ships PPR support.
  cacheComponents: false,
};

export default nextConfig;
