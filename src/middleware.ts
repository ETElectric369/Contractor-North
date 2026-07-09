import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { CONTENT_ROOTS } from "@/lib/site-content-roots";

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

// Legacy CMS paths (Squarespace/Wix/WordPress defaults + Tahoe Deck's old Squarespace slugs).
// When an org moves its domain to North, its old deep URLs (/about, /portfolio) have no
// equivalent route here — North's public site is a single page with #anchors — so they'd
// 404. We 301 them to the homepage instead: bookmarks, business cards, and Google's old index
// entries all land on the live site (which carries the portfolio + instant-estimate CTA) rather
// than a dead end. Only ever runs on a NON-app host, so it can't touch the app's own routes.
// NOTE: blog paths are NOT here — they route to the articles engine below, which serves a
// migrated site's posts at their ORIGINAL URLs (and itself 301s home when no post matches).
const LEGACY_EXACT = new Set([
  "/about", "/about-us", "/portfolio", "/gallery", "/services", "/our-work",
  "/projects", "/contact", "/contact-us", "/home", "/store", "/shop",
  "/testimonials", "/reviews", "/faq",
]);
const LEGACY_PREFIX = ["/shop/", "/store/", "/products", "/product/", "/gallery/", "/portfolio/", "/services/"];
function isLegacyCmsPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/"; // tolerate a trailing slash
  if (LEGACY_EXACT.has(p)) return true;
  return LEGACY_PREFIX.some((pre) => pathname.startsWith(pre));
}

// Org-site content routes rewritten into the /site catch-alls: articles at /blog, /blog/*, and
// legacy /blog-1-1/* (Squarespace's prefix, served at their original URLs, roots shared via
// CONTENT_ROOTS); and custom builder pages at /p/<slug>. Both catch-alls do the DB lookup and
// redirect home on a miss, so middleware stays DB-free.
function isContentPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (/^\/p\/[a-z0-9]/i.test(p)) return true; // custom builder page: /p/<slug>
  return CONTENT_ROOTS.some((root) => p === `/${root}` || p.startsWith(`/${root}/`));
}

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

  const onOrgSite = host && !isAppHost(host);

  // Articles engine: on an org host, /blog* paths rewrite into the site content catch-all —
  // the index at /blog, posts at their ORIGINAL paths (incl. Squarespace's /blog-1-1/<slug>).
  // The catch-all page does the post lookup (middleware stays DB-free) and 301s home itself
  // when nothing matches, preserving the old stale-link behavior.
  if (onOrgSite && isContentPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    const p = url.pathname.replace(/\/+$/, "");
    const content = p === "/blog-1-1" ? "/blog" : p; // the old collection index = our index
    if (host.endsWith(`.${SITES_DOMAIN}`)) {
      const sub = host.slice(0, host.length - SITES_DOMAIN.length - 1);
      if (sub && !sub.includes(".") && !RESERVED_SUBS.has(sub)) {
        url.pathname = `/site/${sub}${content}`;
        return NextResponse.rewrite(url);
      }
    } else {
      url.pathname = `/site/by-domain${content}`;
      return NextResponse.rewrite(url);
    }
  }

  // On a pointed org domain, 301 old-CMS URLs to the homepage so a migrated site's stale links
  // never 404. Runs before the root rewrite; only on non-app hosts, so app routes are untouched.
  if (onOrgSite && request.nextUrl.pathname !== "/" && isLegacyCmsPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url, 301);
  }

  // Only the ROOT of an org's public site is rewritten to /site content. Deeper paths
  // (/estimate, /inquire, /login, assets) and the app's own hosts flow through untouched.
  if (request.nextUrl.pathname === "/" && onOrgSite) {
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
