import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  applicationName: "Contractor North",
  title: "Contractor North",
  description:
    "AI-powered field service platform for electrical contractors — CRM, quoting, scheduling, work orders, and timeclock.",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "North" },
  icons: { apple: "/apple-touch-icon.png" },
  other: {
    // Next 15's `appleWebApp.capable` now emits only the modern `mobile-web-app-capable`.
    // OLDER iOS still needs the legacy `apple-mobile-web-app-capable` to launch an
    // installed PWA standalone — without it, the home-screen app opens inside Safari
    // with the browser controls (what Brian's older iPhone showed).
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b57c4",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Resize the layout when the on-screen keyboard opens so 100dvh + sticky footers
  // stay above it (complements the visualViewport cap in Modal). Chrome/Android +
  // newer iOS; harmless where unsupported.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="font-sans antialiased">
        {children}
        <PwaRegister />
        {/* Core Web Vitals (LCP/CLS/INP) — Pro Speed Insights. Ranks the public marketing
            sites for local SEO and surfaces slow routes now that Sentry perf tracing is gone. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
