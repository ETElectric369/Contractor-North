import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Fraunces } from "next/font/google";
import { isPlatformApexHost } from "@/lib/platform-site";
import { OPERATOR_LINE, SUPPORT_EMAIL } from "./site-facts";

// Self-hosted at build time by next/font, so a visitor's browser never calls Google for it (the
// tenant sites load their fonts from Google at runtime; this page has no reason to).
const serif = Fraunces({ subsets: ["latin"], variable: "--font-north-serif", display: "swap" });

/**
 * Contractor North's own pages (home, /support, /privacy). Reached ONLY by middleware's apex
 * rewrite (lib/platform-site); the middleware also 404s /north-site by name on every host. This
 * host check is the second lock: if a rewrite ever pointed here from another host, the page still
 * refuses to render anywhere but contractornorth.com / www.
 */
export default async function NorthSiteLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  if (!isPlatformApexHost(h.get("host"))) notFound();

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
        <nav className="flex items-center gap-4 text-sm font-medium text-[#51607a] sm:gap-6">
          <a href="/support" className="hover:text-[#1a2b4a]">Support</a>
          <a href="/privacy" className="hover:text-[#1a2b4a]">Privacy</a>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-8">{children}</main>

      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 pt-12 text-[13px] leading-relaxed text-[#51607a] sm:px-8">
        <div className="border-t border-[#d9dde5] pt-5 sm:flex sm:items-start sm:justify-between sm:gap-8">
          <p className="max-w-md">{OPERATOR_LINE}</p>
          <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 sm:mt-0">
            <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-[#1a2b4a]">{SUPPORT_EMAIL}</a>
            <a href="/support" className="hover:text-[#1a2b4a]">Support</a>
            <a href="/privacy" className="hover:text-[#1a2b4a]">Privacy</a>
          </p>
        </div>
      </footer>
    </div>
  );
}
