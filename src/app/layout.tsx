import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
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
      </body>
    </html>
  );
}
