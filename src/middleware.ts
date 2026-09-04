import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { CONTENT_ROOTS } from "@/lib/site-content-roots";
import { pageSlugFromPath, isLegacyCmsPath, isReservedSlug, legacyAliasTarget } from "@/lib/site-reserved";
import { isDeadReservedHost } from "@/lib/public-host";
import { shellFromUserAgent } from "@/lib/native-shell";

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
  // Lowercased: pageSlugFromPath lowercases, so /About worked while /BLOG/<post> fell through to
  // the auth guard and 307'd to a login screen. Two spellings of the same URL must not get two
  // different answers, and CONTENT_ROOTS are all lowercase.
  const p = pathname.toLowerCase().replace(/\/+$/, "") || "/";
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
  // app.<domain> IS the app host with or without APP_HOSTS (public-host.ts already says so; this copy
  // silently depended on the env var, and the shell-root redirect below rides on it).
  if (host === `app.${SITES_DOMAIN}`) return true;
  return EXTRA_APP_HOSTS.has(host);
}

/* A `hasSession` cookie-presence check used to exempt "signed-in" requests from the /site/ block.
 * It was defeated in one line:
 *     curl -H 'Cookie: sb-x-auth-token=garbage' https://etelectricity.com/site/tahoe-deck
 *       -> 200, 136 KB, <title>TAHOE DECK …</title>
 * It tested that a cookie NAME existed and never validated it, so any scraper could send that
 * header and get the other tenant's entire site back. The law it broke is one this codebase
 * already knew: a control its subject can switch off isn't a control. /site/ is now app-host-only
 * with no exemption, and the editor's preview links are absolute to the app host instead.
 */

/** Old-CMS file URLs (/about.html, /index.php, /default.asp). pageSlugFromPath rejects anything
 *  with a dot as an asset, and the legacy-prefix rule only catches MULTI-segment paths — so these
 *  fell all the way through to the app's auth guard and 307'd to /login, putting a login screen on
 *  a contractor's marketing domain for a URL that is simply gone. Strip the extension so
 *  /about.html can land on the real /about; otherwise it's a stale bookmark → home. */
const LEGACY_FILE_EXT = /\.(html?|php|aspx?|jsp|cgi|cfm)$/i;

export async function middleware(request: NextRequest) {
  const host = (request.headers.get("host") || "").toLowerCase().split(":")[0];

  // LOCKDOWN (cn-v493): contractornorth.com itself is off the public web for now — the app
  // lives on the vercel.app URL, and each org's public site lives on its own subdomain/custom
  // domain. The apex/www attachments were detached from the Vercel project, but the
  // *.contractornorth.com wildcard still catches "www", so refuse it here too.
  if (host === SITES_DOMAIN || host === `www.${SITES_DOMAIN}`) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The lockdown 404s the apex and www — but the *.contractornorth.com wildcard also answers on
  // api/admin/staging/mail/dev/preview, and each of those was serving its own indexable copy of
  // the app landing page, with "Allow: /" robots and a sitemap advertising ITSELF:
  //     https://admin.contractornorth.com/sitemap.xml -> <loc>https://admin.contractornorth.com/</loc>
  // They are reserved precisely because they name no org, so they should answer like the apex.
  if (isDeadReservedHost(host)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const onOrgSite = host && !isAppHost(host);

  // TENANT-HOST LEAK (SEO audit, 2026-07-27): /site/<handle> is the app's INTERNAL namespace — the
  // target middleware rewrites into. It was never blocked on a tenant's own domain, and the route
  // resolves the org from the URL SEGMENT, not from Host. So every org's whole site answered 200 on
  // every other org's domain:
  //     GET https://etelectricity.com/site/tahoe-deck  -> 200, <title>TAHOE DECK …
  //     GET https://tahoedeck.com/site/et-electric     -> 200, <title>ET Electric …
  // plus two extra copies of the host's OWN site (/site/<own-handle> and /site/by-domain).
  //
  // The canonical tags were right the whole time, which is why nothing collapsed — but a canonical
  // is a hint, and it does nothing about a 200 or about Chris's phone number answering on Erik's
  // domain. The public URLs of a tenant site are the ROOT-level ones; /site/* only ever needs to be
  // reachable on the app host.
  //
  // A rewrite does not re-enter middleware, so none of this touches the rewrites just below that
  // TARGET these same routes — the real public pages never reach it.
  //
  // The BLOCK ITSELF now lives in updateSession (lib/supabase/middleware.ts), after getUser(), so
  // it tests a VALIDATED session instead of the presence of a cookie name. See the note above
  // `LEGACY_FILE_EXT`. That placement also keeps draft preview working for a real editor on
  // whichever host they happen to be signed in to.

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

  // Legacy sitemap/index aliases (/sitemap_index.xml, /wp-sitemap.xml, /sitemap, /index, /rss).
  // Every one of these was reaching the auth guard and answering with a login page — including the
  // Yoast sitemap URL, which is about the most-crawled legacy path there is. Send them to the real
  // resource instead. Runs BEFORE the file-extension rule so .xml aliases win.
  if (onOrgSite) {
    const alias = legacyAliasTarget(request.nextUrl.pathname);
    if (alias) {
      const url = request.nextUrl.clone();
      url.pathname = alias;
      url.search = "";
      return NextResponse.redirect(url, 301);
    }
  }

  // Single-segment old-CMS FILE URLs (/about.html, /index.php). See LEGACY_FILE_EXT above: these
  // used to reach the auth guard and 307 to /login. If the bare name matches a real page slug we
  // send them there (/about.html -> /about); otherwise home, matching the legacy-slug policy. 301
  // because a file extension is not a shape this site will ever serve.
  if (onOrgSite) {
    const p = request.nextUrl.pathname.replace(/\/+$/, "");
    if (LEGACY_FILE_EXT.test(p) && !p.slice(1).includes("/")) {
      const bare = p.replace(LEGACY_FILE_EXT, "");
      const slug = pageSlugFromPath(bare);
      const url = request.nextUrl.clone();
      url.pathname = slug ? `/${slug}` : "/";
      url.search = "";
      return NextResponse.redirect(url, 301);
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

  // NATIVE SHELL ROOT (Phase 0, 2026-09-04): the iOS/Android shell opens at "/" of the app host
  // (capacitor.config.ts server.url), which is the MARKETING landing — "Get Started Free", pricing,
  // signup. A native app must never show that (Apple 4.2 / 3.1.1, and it's invite-only anyway):
  // send the shell into the app. The auth guard turns a signed-out visit into /login as usual.
  if (request.nextUrl.pathname === "/" && !onOrgSite && shellFromUserAgent(request.headers.get("user-agent")).native) {
    const url = request.nextUrl.clone();
    url.pathname = "/planner";
    url.search = "";
    return NextResponse.redirect(url, 307);
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

  return updateSession(request, !!onOrgSite);
}

export const config = {
  matcher: [
    // Run on everything except static assets and image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
