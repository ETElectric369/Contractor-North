import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Vanity domains whose ROOT should serve a public page instead of the app homepage.
// Each org can point its own domain at North; the root rewrites to that org's public
// surface (an inquiry splash, or the deck estimate configurator). Env-overridable.
const SPLASH_DOMAIN = (process.env.SPLASH_DOMAIN || "etelectric369.com").toLowerCase();
const SPLASH_ORG_ID =
  process.env.SPLASH_ORG_ID || "60195593-2e18-4230-bc8e-7a32d36d038d";
const DECK_DOMAIN = (process.env.DECK_DOMAIN || "tahoedeck.com").toLowerCase();
const DECK_HANDLE = process.env.DECK_HANDLE || "tahoe-deck";

const VANITY_ROOTS: { domain: string; rewriteTo: string }[] = [
  { domain: SPLASH_DOMAIN, rewriteTo: `/inquire/${SPLASH_ORG_ID}` },
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
