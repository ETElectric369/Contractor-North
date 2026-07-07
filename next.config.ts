import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lint is run separately in CI; don't fail production builds on lint.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Server Actions are stable in Next 15; keep body limit generous for
    // photo / sketch / document uploads handled through actions.
    serverActions: { bodySizeLimit: "10mb" },
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
