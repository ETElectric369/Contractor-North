import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isReservedSlug } from "@/lib/site-reserved";

const PUBLIC_PATHS = [
  "/login",
  "/forgot",
  "/auth",
  "/q/",
  "/i/",
  "/c/",
  "/portal/",
  "/inquire",
  "/estimate/",
  "/intake/", // the public intake door (0185) — a customer has no account by definition
  "/site/",
  "/voice/", // authorized voice-donation portal — the invitee has no account (token-gated)
  "/pick/",
  "/api/places",
  "/api/weather", // same-origin Google proxy (server key) — safe read-only, rate-limited; usable on public pages
  "/api/geocode", // same-origin Google proxy (server key) — safe read-only, rate-limited
  "/api/pay",
  "/api/stripe",
  "/api/contracts",
  "/api/timeclock",
  "/api/automations",
  // Vercel Cron calls this with a Bearer CRON_SECRET and NO session cookie — without
  // this entry the middleware 401s it before requireCron ever runs (the two-way gcal
  // sync has been dead every 15 min since 0132). NARROW path on purpose: /api/google/
  // connect + /callback must stay session-gated so the OAuth grant binds to a real user.
  "/api/google/sync",
  "/api/inbound",
  "/api/site-chat",
  "/api/health",
  "/_next",
  "/favicon",
  "/robots.txt",
  "/sitemap.xml",
  // PWA assets must load without auth, or install/offline break.
  "/sw.js",
  "/manifest.webmanifest",
  "/offline",
  "/icon-",
  "/apple-touch-icon",
];

/**
 * Refreshes the Supabase auth session on every request and redirects
 * unauthenticated users to /login (except for public paths).
 */
export async function updateSession(request: NextRequest, onOrgSite = false) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // THE /site/ CROSS-TENANT BLOCK. /site/<handle> is the platform's INTERNAL namespace — the target
  // middleware rewrites into — and the route behind it resolves the org from the URL SEGMENT, never
  // from Host. Unblocked on a tenant domain it served each contractor's entire site on the other's:
  //     GET https://etelectricity.com/site/tahoe-deck  -> 200  <title>TAHOE DECK …
  //
  // It sits HERE, below getUser(), on purpose. The first version of this guard lived up in
  // middleware.ts and exempted "signed-in" requests by checking that a cookie NAMED sb-*-auth-token
  // existed. That was defeated in one line — `curl -H 'Cookie: sb-x-auth-token=garbage'` returned
  // 136 KB of the other tenant's site — because a cookie's NAME proves nothing. `user` here is a
  // validated session, so the same intent (let a real editor preview drafts on whatever host they
  // are signed in to; show everyone else nothing) now actually holds.
  //
  // Checked explicitly rather than by removing "/site/" from PUBLIC_PATHS, because the app host
  // must keep serving these routes signed-out for nothing — they are also the rewrite targets.
  // EVERY host, not just tenant hosts. Scoping this to `onOrgSite` left the app host serving the
  // whole /site/ tree — six route files, the largest public surface — to anyone signed out:
  //     GET https://app.contractornorth.com/site/tahoe-deck  -> 200  <title>TAHOE DECK …
  // Guess a handle, get that customer's site. /estimate and /inquire got the same treatment via
  // lib/serve-org; this is the equivalent for /site/, done here because it covers all six routes
  // at the one place they share instead of six places that can drift.
  //
  // Safe for the public pages: middleware REWRITES root-level tenant URLs into /site/**, and a
  // rewrite does not re-enter middleware — so tahoedeck.com/about never reaches this line.
  if (pathname.toLowerCase().startsWith("/site/") && !user) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (!user && !isPublic && pathname !== "/") {
    // An API route (fetched via fetch()) must get a clean 401 — NOT a 307 to /login, which
    // the browser would follow and hand the caller the login PAGE's HTML (e.g. the chat
    // would stream the login page back as "Claude's reply"). Only redirect real navigations.
    if (pathname.startsWith("/api/")) {
      return new NextResponse("Your session expired — please sign in again.", { status: 401 });
    }

    // SOFT-404 CLASS. This is the catch-all for everything middleware.ts didn't classify, and on
    // a CONTRACTOR'S MARKETING DOMAIN it was answering every dead deep link with a login screen:
    //     tahoedeck.com/foo/bar  ->  307  ->  /login?next=%2Ffoo%2Fbar   (a 200 page)
    //     etelectricity.com/.env ->  307  ->  /login?next=%2F.env
    // Reproduced with a Googlebot user-agent. Nothing leaks and /login is noindex + Disallow'd,
    // but no dead URL on either site could ever be DROPPED by Google, because none of them ever
    // answered 404 — and a person following a stale link landed on a login form.
    //
    // The fix has to keep one real behaviour: crew bookmark the company site and sign in from it,
    // so a genuine app route must still offer the login page. A reserved first segment IS an app
    // route (RESERVED_SLUGS is the same list that stops a builder page shadowing one). Anything
    // else on an org host is simply not a URL this site has — so say so.
    if (onOrgSite) {
      const first = pathname.split("/").filter(Boolean)[0] ?? "";
      if (!isReservedSlug(first)) {
        return new NextResponse("Not found", { status: 404 });
      }
    }

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}
