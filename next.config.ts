import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lint is run separately in CI; don't fail production builds on lint.
  eslint: { ignoreDuringBuilds: true },
  // Pin every client to the deployment that served it. Alone this only stamps requests with
  // x-deployment-id; with Vercel Skew Protection switched on in the project settings, an old
  // tab keeps talking to ITS build instead of the new one — the "e[o] is not a function" /
  // "unexpected response" rows in the error log. Undefined locally, harmless.
  deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
  // The PDF engine's headless chromium must load from node_modules at runtime, not be
  // webpack-bundled (its brotli-packed binary breaks under bundling).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // The chromium package loads its brotli-packed binary + shared libs (libnss3 et al) from
  // bin/ with fs at runtime — the file tracer misses them, and the lambda then dies with
  // "libnss3.so: cannot open shared object file". Force the whole bin/ dir into the bundle.
  outputFileTracingIncludes: {
    "/api/pdf/**": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  experimental: {
    // Server Actions are stable in Next 15; keep body limit generous for
    // photo / sketch / document uploads handled through actions — incl. plan
    // PDFs sent to the estimator (server validates the PDF itself at ≤20 MB).
    serverActions: { bodySizeLimit: "22mb" },
  },
  images: {
    remotePatterns: [
      // Supabase Storage public URLs. Replace <project-ref> via env at runtime;
      // a permissive https pattern keeps local + preview deployments working.
      { protocol: "https", hostname: "**.supabase.co" },
    ],
  },
  async headers() {
    return [
      {
        // The service worker MUST always be revalidated. If sw.js is HTTP-cached, the
        // browser keeps re-using the old copy and never notices a new deploy — that's
        // how an installed PWA gets stranded on stale code (the appointment-bug saga).
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
