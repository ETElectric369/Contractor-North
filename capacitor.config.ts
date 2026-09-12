import type { CapacitorConfig } from "@capacitor/cli";

/**
 * THE NATIVE SHELL (docs/native-app-plan.md, Phase 0). A thin iOS/Android app whose WebView loads
 * the HOSTED app — every deploy of the web app flows straight into the shell, so the product keeps
 * shipping while the shell is built around it. Native plugins (contacts, push, camera, share)
 * bridge in later; nothing here rewrites the app.
 *
 * `appendUserAgent` is how the web side knows it is inside the shell (src/lib/native-shell.ts):
 * Add-to-Home-Screen coaching, web-push UI and the SaaS checkout (Apple 3.1.1) hide on native.
 */
const config: CapacitorConfig = {
  appId: "com.contractornorth.app",
  appName: "North",
  webDir: "public/native-shell", // a placeholder page; the real UI is server.url
  server: {
    url: "https://app.contractornorth.com",
    allowNavigation: ["app.contractornorth.com", "*.contractornorth.com", "*.supabase.co", "js.stripe.com", "checkout.stripe.com", "billing.stripe.com"],
  },
  ios: {
    contentInset: "never",
    appendUserAgent: "CNShell/1 (iOS)",
    // The WebView's own paint — what shows at launch before the first page paints and in the
    // band a rubber-band drag exposes. The launch screen is systemBackground (white) and the app
    // ground is --background #f8fafc (globals.css); the old near-black here was a black flash
    // between them and a black stripe on every overscroll. Same ground = no flash, no stripe.
    backgroundColor: "#f8fafc",
    // WKWebView's long-press "peek" renders a preview of the tapped link (an app page, inside a
    // native app) with Open-in-Safari options. A tab-less shell has no use for it, and it stole
    // the long press from every dock tile and list row.
    allowsLinkPreview: false,
  },
  android: {
    appendUserAgent: "CNShell/1 (Android)",
    backgroundColor: "#f8fafc",
  },
};

export default config;
