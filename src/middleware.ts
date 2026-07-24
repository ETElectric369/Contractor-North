import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { CONTENT_ROOTS } from "@/lib/site-content-roots";
import { pageSlugFromPath, isLegacyCmsPath } from "@/lib/site-reserved";

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

// Legacy CMS paths (Squarespace/Wix/WordPress defaults): the shared list + check now live in
// lib/site-reserved (isLegacyCmsPath) because the PAGE RESOLVER needs the same test — a
// single-segment legacy slug reaches the resolver first, and on a miss it must 301 home
// rather than 404 a stale bookmark. Multi-segment prefixes still 301 here in middleware.

// Org-site article routes rewritten into the /site catch-all: articles at /blog, /blog/*, and
// legacy /blog-1-1/* (Squarespace's prefix, served at their original URLs, roots shared via
// CONTENT_ROOTS). The catch-all does the DB lookup and redirects home on a miss, so middleware
// stays DB-free. Custom builder PAGES are handled separately (root-level slugs, see pageSlugFromPath).
function isContentPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
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

  // LOCKDOWN (cn-v493): contractornorth.com itself is off the public web for now — the app
  // lives on the vercel.app URL, and each org's public site lives on its own subdomain/custom
  // domain. The apex/www attachments were detached from the Vercel project, but the
  // *.contractornorth.com wildcard still catches "www", so refuse it here too.
  if (host === SITES_DOMAIN || host === `www.${SITES_DOMAIN}`) {
    return new NextResponse("Not found", { status: 404 });
  }

  const onOrgSite = host && !isAppHost(host);

  // RSS (SEO wave 2026-07-24): /blog/rss.xml (+ the common /feed and /rss.xml spellings) on an
  // org host serve the per-org feed. Must run BEFORE the content rewrite — "blog/rss.xml" would
  // otherwise fall into the article catch-all and 404.
  if (onOrgSite && ["/blog/rss.xml", "/rss.xml", "/feed"].includes(request.nextUrl.pathname.replace(/\/+$/, ""))) {
    const url = request.nextUrl.clone();
    url.pathname = "/site-rss";
    if (host.endsWith(`.${SITES_DOMAIN}`)) {
      const sub = host.slice(0, host.length - SITES_DOMAIN.length - 1);
      if (sub && !sub.includes(".") && !RESERVED_SUBS.has(sub)) url.searchParams.set("handle", sub);
    }
    return NextResponse.rewrite(url);
  }

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

  // Back-compat: the builder briefly served pages at /p/<slug> (cn-v461); the canonical URL is now
  // the root-level /<slug> that matches a migrated site's original index. 301 the old form across.
  if (onOrgSite) {
    const m = request.nextUrl.pathname.match(/^\/p\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (m) {
      const url = request.nextUrl.clone();
      url.pathname = `/${m[1].toLowerCase()}`;
      url.search = "";
      return NextResponse.redirect(url, 301);
    }
  }

  // Custom builder PAGES at ROOT-level slugs (e.g. /about, /portfolio, /contact) — so a migrated
  // site's already-indexed page URLs serve 200s in North's style. A single non-reserved segment is
  // rewritten into the page route, which renders the page if it exists or, on a miss, 307s home
  // (temporary — because a root slug is RECOVERABLE: the owner can build that page tomorrow, so we
  // must not permanently poison it, matching the article-miss policy). pageSlugFromPath excludes the
  // root, multi-segment paths, dotted assets, and every reserved app/content route.
  if (onOrgSite) {
    const slug = pageSlugFromPath(request.nextUrl.pathname);
    if (slug) {
      const url = request.nextUrl.clone();
      if (host.endsWith(`.${SITES_DOMAIN}`)) {
        const sub = host.slice(0, host.length - SITES_DOMAIN.length - 1);
        if (sub && !sub.includes(".") && !RESERVED_SUBS.has(sub)) {
          url.pathname = `/site/${sub}/p/${slug}`;
          return NextResponse.rewrite(url);
        }
      } else {
        url.pathname = `/site/by-domain/p/${slug}`;
        return NextResponse.rewrite(url);
      }
    }
  }

  // On a pointed org domain, 301 remaining old-CMS URLs (multi-segment legacy prefixes like
  // /shop/*, /gallery/*) to the homepage so a migrated site's stale links never 404. Single-segment
  // paths were already handled above by the page resolver. Only on non-app hosts, app routes untouched.
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
