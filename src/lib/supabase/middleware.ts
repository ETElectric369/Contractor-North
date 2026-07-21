import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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
export async function updateSession(request: NextRequest) {
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

  if (!user && !isPublic && pathname !== "/") {
    // An API route (fetched via fetch()) must get a clean 401 — NOT a 307 to /login, which
    // the browser would follow and hand the caller the login PAGE's HTML (e.g. the chat
    // would stream the login page back as "Claude's reply"). Only redirect real navigations.
    if (pathname.startsWith("/api/")) {
      return new NextResponse("Your session expired — please sign in again.", { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}
