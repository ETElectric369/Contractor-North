import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// A vanity domain whose root should serve a public inquiry splash instead of
// the app homepage. Configurable via env; defaults to ET Electric.
const SPLASH_DOMAIN = (process.env.SPLASH_DOMAIN || "etelectric369.com").toLowerCase();
const SPLASH_ORG_ID =
  process.env.SPLASH_ORG_ID || "60195593-2e18-4230-bc8e-7a32d36d038d";

export async function middleware(request: NextRequest) {
  const host = (request.headers.get("host") || "").toLowerCase().split(":")[0];
  const isSplashHost = host === SPLASH_DOMAIN || host === `www.${SPLASH_DOMAIN}`;

  // On the vanity domain, the homepage shows the lead-capture splash.
  if (isSplashHost && request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = `/inquire/${SPLASH_ORG_ID}`;
    return NextResponse.rewrite(url);
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    // Run on everything except static assets and image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
