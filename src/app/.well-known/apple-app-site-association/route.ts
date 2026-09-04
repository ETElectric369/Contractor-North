import { NextResponse } from "next/server";

/**
 * APPLE APP SITE ASSOCIATION — the site's half of "this app and this site belong together".
 * iOS Password AutoFill will only offer to SAVE or FILL a web password inside an app's WKWebView
 * when the app declares `webcredentials:<host>` (ios/App/App/App.entitlements) AND the host serves
 * this file naming the app. Erik's first TestFlight login (2026-09-04): "couldn't save the password
 * to autofill" — this is why. No universal links yet (applinks would change how invite links open;
 * that is a deliberate later step).
 *
 * Rules: served at exactly /.well-known/apple-app-site-association on the app host, HTTPS, no
 * redirect, Content-Type application/json, no extension. Apple's CDN fetches it, not the phone.
 */
const TEAM_ID = "VZBM9D6U78";
const BUNDLE_ID = "com.contractornorth.app";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    { webcredentials: { apps: [`${TEAM_ID}.${BUNDLE_ID}`] } },
    { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } },
  );
}
