import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Contractor North",
    short_name: "North",
    description: "AI-powered field service platform for contractors.",
    start_url: "/planner",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // The launch splash paints this behind the icon — the icon's own black ground, so the
    // tile doesn't sit on a white flash.
    background_color: "#0b0f12",
    theme_color: "#0b57c4",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The "any" icons are the transparent dome (Erik's call); maskable must stay OPAQUE —
      // Android circle-crops it onto its own ground, so it keeps the dark panel + safe margin.
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
