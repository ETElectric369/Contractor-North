import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Contractor North",
    short_name: "North",
    description: "AI-powered field service platform for contractors.",
    start_url: "/planner",
    scope: "/",
    display: "standalone",
    // PORTRAIT, AND IT STAYS PORTRAIT — a deliberate decision, not a leftover (2026-10-01).
    //
    // The App Store app lets the phone turn on the screens that warrant it and nowhere else
    // (lib/screens-that-turn.ts, one declared list). This key cannot do that job: a manifest is ONE
    // value for the WHOLE app, so it can only say "every screen" or "no screen". Both are wrong, and
    // only one is wrong in a safe direction:
    //   - "any" would let an INSTALLED web app rotate on every screen, including the tall lists that
    //     get worse sideways — and on iOS, where there is no Screen Orientation API to lock it back
    //     with, nothing could undo it. That is exactly what Erik asked us not to do.
    //   - "portrait" keeps the installed web app behaving as it does today. Nothing is lost that was
    //     ever there, and on iOS it is also the only honest answer.
    // An ordinary mobile browser TAB can't be locked either way and already turns on every screen;
    // the `turned:` rules in globals.css are what keep the top bar and the dock put when it does.
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
