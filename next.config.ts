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
      {
        // CLICKJACKING (audit v921): nothing anywhere set X-Frame-Options or frame-ancestors, so
        // any page could be framed — including /q/<token>, where one click approves and signs an
        // estimate. 'self' rather than 'none' because site-studio previews /site/<handle> in a
        // same-origin iframe. Referrer-Policy keeps token URLs out of third-party Referer headers.
        // /intake is deliberately EXCLUDED — its embed snippet lives in an iframe on the org's
        // own website (Justin's Wix), so it gets its own, framable, header set below.
        source: "/((?!intake/).*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(self), microphone=(self)" },
        ],
      },
      {
        // The intake door is MEANT to be embedded on the tenant's own site, whatever domain that
        // is, so it carries no frame restriction — only the headers that cost it nothing.
        source: "/intake/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
