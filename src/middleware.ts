import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Vanity domains whose ROOT serves an org's Contractor-North-hosted homepage instead of the
// app homepage. Each org points its own domain at North; the root rewrites to /site/<handle>.
// Env-overridable so new orgs can be added without a code change once the editor UI exists.
const SPLASH_DOMAIN = (process.env.SPLASH_DOMAIN || "etelectric369.com").toLowerCase();
const SPLASH_HANDLE = process.env.SPLASH_HANDLE || "et-electric";
const DECK_DOMAIN = (process.env.DECK_DOMAIN || "tahoedeck.com").toLowerCase();
const DECK_HANDLE = process.env.DECK_HANDLE || "tahoe-deck";

const VANITY_ROOTS: { domain: string; rewriteTo: string }[] = [
  { domain: SPLASH_DOMAIN, rewriteTo: `/site/${SPLASH_HANDLE}` },
  { domain: DECK_DOMAIN, rewriteTo: `/site/${DECK_HANDLE}` },
];

export async function middleware(request: NextRequest) {
  const host = (request.headers.get("host") || "").toLowerCase().split(":")[0];

  // On a vanity domain, the homepage IS that org's public page.
  if (request.nextUrl.pathname === "/") {
    const match = VANITY_ROOTS.find((v) => v.domain && (host === v.domain || host === `www.${v.domain}`));
    if (match) {
      const url = request.nextUrl.clone();
      url.pathname = match.rewriteTo;
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
