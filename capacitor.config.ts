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
    backgroundColor: "#0b0f12",
  },
  android: {
    appendUserAgent: "CNShell/1 (Android)",
    backgroundColor: "#0b0f12",
  },
};

export default config;
