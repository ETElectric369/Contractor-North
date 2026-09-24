import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Fraunces } from "next/font/google";
import { isPlatformApexHost, platformSitePosted } from "@/lib/platform-site";
import { OPERATOR_LINE, SUPPORT_EMAIL } from "./site-facts";

// Self-hosted at build time by next/font, so a visitor's browser never calls Google for it (the
// tenant sites load their fonts from Google at runtime; this page has no reason to).
const serif = Fraunces({ subsets: ["latin"], variable: "--font-north-serif", display: "swap" });

// These pages render inside the app's root layout, which marks every page as a home-screen web app
// (apple-mobile-web-app-capable). On the apex that would save a standalone "North" that opens a
// marketing page, so turn it off here. PwaRegister skips the apex on its own (the apex has no
// /sw.js). The root's file-convention manifest link cannot be dropped per segment (checked: a
// `manifest: null` here still renders it); the apex 404s /manifest.webmanifest, which is exactly
// what keeps the apex from being installable.
export const metadata: Metadata = {
  appleWebApp: { capable: false },
  other: { "apple-mobile-web-app-capable": "no" },
};

// A 44px tap target that looks like plain text: the hit area grows, the type does not.
const NAV_LINK = "inline-flex min-h-11 items-center px-1 hover:text-[#1a2b4a]";

/**
 * Contractor North's own pages (home, /support, /privacy). Reached ONLY by middleware's apex
 * rewrite (lib/platform-site); the middleware also 404s /north-site by name on every host. This
 * host check and the posting switch are the second lock: if a rewrite ever pointed here from
 * another host, or before Erik says post, the page still refuses to render.
 */
export default async function NorthSiteLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  if (!platformSitePosted() || !isPlatformApexHost(h.get("host"))) notFound();

  return (
    <div
      className={`${serif.variable} flex min-h-dvh flex-col bg-[#f7f6f2] text-[#1a2b4a]`}
      style={{ colorScheme: "light" }}
    >
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 pt-5 sm:px-8 sm:pt-8">
        {/* Plain links on purpose: "/" here is the APEX home (a middleware rewrite), not the app's
            "/" route the lint rule sees, and three static pages gain nothing from client routing. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="flex items-center gap-2.5" aria-label="Contractor North home">
          {/* THE mark (cn-brand-identity): Erik's white rose on black, the same file as the app icon.
              A 36px static PNG already sized for it; the image optimizer has nothing to add. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt="" width={36} height={36} className="h-9 w-9 rounded-[10px]" />
          <span className="font-[family-name:var(--font-north-serif)] text-[17px] font-semibold tracking-tight">
            Contractor North
          </span>
        </a>
        <nav className="flex items-center gap-2 text-sm font-medium text-[#51607a] sm:gap-4">
          <a href="/support" className={NAV_LINK}>Support</a>
          <a href="/privacy" className={NAV_LINK}>Privacy</a>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-8">{children}</main>

      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 pt-12 text-[13px] leading-relaxed text-[#51607a] sm:px-8">
        <div className="border-t border-[#d9dde5] pt-5 sm:flex sm:items-start sm:justify-between sm:gap-8">
          <p className="max-w-md">{OPERATOR_LINE}</p>
          <p className="-ml-1 mt-2 flex flex-wrap gap-x-3 gap-y-0 sm:-mt-3">
            <a href={`mailto:${SUPPORT_EMAIL}`} className={NAV_LINK}>{SUPPORT_EMAIL}</a>
            <a href="/support" className={NAV_LINK}>Support</a>
            <a href="/privacy" className={NAV_LINK}>Privacy</a>
          </p>
        </div>
      </footer>
    </div>
  );
}
