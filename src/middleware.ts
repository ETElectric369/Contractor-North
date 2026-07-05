import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// The platform's own domain. A subdomain of it is a free org site: <handle>.SITES_DOMAIN.
// Any OTHER host pointed at us is a custom domain, resolved by hostname in /site/by-domain.
// This is what makes onboarding hands-off: no code change to publish an org's site.
const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();
// Subdomains that belong to the app / infra, never an org site.
const RESERVED_SUBS = new Set(["www", "app", "api", "admin", "mail", "staging", "dev", "preview"]);
// Extra canonical app hostnames (comma-separated), for aliases beyond the defaults.
const EXTRA_APP_HOSTS = new Set(
  (process.env.APP_HOSTS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
);

/** Is this host the app itself (login/dashboard) rather than an org's public marketing site?
 *  Infra hosts (localhost, bare IPs, Vercel URLs) and the platform apex serve the app; only a
 *  real, non-app DOMAIN reaches the org-site resolver. */
function isAppHost(host: string): boolean {
  if (!host || host === "localhost" || host === "127.0.0.1") return true;
  if (host.startsWith("[")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // bare IPv4 (health checks, origin probes)
  if (host.endsWith(".vercel.app")) return true; // deploy + preview URLs
  if (host === SITES_DOMAIN || host === `www.${SITES_DOMAIN}`) return true;
  return EXTRA_APP_HOSTS.has(host);
}

export async function middleware(request: NextRequest) {
  const host = (request.headers.get("host") || "").toLowerCase().split(":")[0];

  // Only the ROOT of an org's public site is rewritten to /site content. Deeper paths
  // (/estimate, /inquire, /login, assets) and the app's own hosts flow through untouched.
  if (request.nextUrl.pathname === "/" && host && !isAppHost(host)) {
    const url = request.nextUrl.clone();
    if (host.endsWith(`.${SITES_DOMAIN}`)) {
      // Free subdomain: the subdomain IS the org handle — no DB lookup needed.
      const sub = host.slice(0, host.length - SITES_DOMAIN.length - 1);
      if (sub && !sub.includes(".") && !RESERVED_SUBS.has(sub)) {
        url.pathname = `/site/${sub}`;
        return NextResponse.rewrite(url);
      }
      // reserved or multi-level subdomain → fall through to the app
    } else {
      // Custom domain pointed at us → resolve the org by hostname inside the page.
      url.pathname = "/site/by-domain";
      return NextResponse.rewrite(url);
    }
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on everything except static assets and image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
