import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";
import { BackLinkTracker } from "@/components/back-link";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  applicationName: "Contractor North",
  title: "Contractor North",
  description:
    "AI-powered field service platform for contractors — CRM, quoting, scheduling, work orders, and timeclock.",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "North" },
  icons: { icon: "/favicon.ico", apple: "/apple-touch-icon.png" }, // explicit rel=icon — SERP/browser favicon pickup was unreliable without it
  other: {
    // Next 15's `appleWebApp.capable` now emits only the modern `mobile-web-app-capable`.
    // OLDER iOS still needs the legacy `apple-mobile-web-app-capable` to launch an
    // installed PWA standalone — without it, the home-screen app opens inside Safari
    // with the browser controls (what Brian's older iPhone showed).
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  // The installed app paints its WINDOW TITLE BAR with this (Erik's screenshot: a thick
  // out-of-place blue stripe over the sea-glass top bar, "this keeps happening"). White
  // matches the topbar's rgba(255,255,255,.8)-on-white so the chrome disappears into the app.
  themeColor: "#ffffff",
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
        {/* SELF-HEAL AN UNSTYLED PAINT: a hard refresh racing a deploy can land HTML whose hashed
            CSS just vanished (Erik: option-shift-R showed the raw page). One guarded reload
            fetches matching HTML+CSS; the guard stops loops if styles are genuinely broken. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'window.addEventListener("load",function(){try{if(document.styleSheets.length===0&&!sessionStorage.getItem("cn-css-heal")){sessionStorage.setItem("cn-css-heal","1");location.reload();}else if(document.styleSheets.length>0){sessionStorage.removeItem("cn-css-heal");}}catch(e){}});',
          }}
        />
        
        {children}
        <PwaRegister />
        {/* Watches client-side route changes so <BackLink> knows real in-app
            history exists (root layout = never unmounts, covers /print too). */}
        <BackLinkTracker />
        {/* Core Web Vitals (LCP/CLS/INP) — Pro Speed Insights. Ranks the public marketing
            sites for local SEO and surfaces slow routes. */}
        <SpeedInsights />
      </body>
    </html>
  );
}
