import { type NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/rate-limit";
import { GOOGLE_KEY, googleKeyHeaders, memRateLimited, proxyClientIp } from "@/lib/google-server";

export const runtime = "nodejs";

/**
 * A HARD DAILY CEILING ON BILLED GOOGLE CALLS (Erik, after attaching a card to Google Cloud:
 * "i cant figure out what its going to charge me").
 *
 * This proxy is deliberately PUBLIC — the marketing site's contact form and the estimate
 * configurator need address autocomplete before anyone signs in. Its only guard was
 * memRateLimited, which is per-IP AND in-process: on serverless it resets every cold start and
 * two instances never see each other's counts. That is a politeness guard, not a cost ceiling.
 *
 * The DB-backed limiter is shared across instances and survives restarts, so a per-day cap is a
 * real number. failClosed: if the limiter itself breaks we STOP calling Google — an outage of
 * our own rate limiter must never become an unbounded bill.
 *
 * Session tokens already fold a whole autocomplete session + its details fetch into ONE billed
 * unit, so this ceiling is in sessions, not keystrokes. Far above real use, far below anything
 * that matters on a bill: a fuse, not a quota.
 */
const PLACES_CALLS_PER_DAY = 5000;
/** The bias circle's radius, in metres — Google's maximum for one. */
const BIAS_RADIUS_M = 50_000;

// Same-origin proxy for Google Places (New). The browser calls THIS route; we call Google with
// the unrestricted SERVER key (see google-server.ts) — so address autocomplete works on EVERY
// tenant domain (custom domains, reseller domains) with ZERO per-domain Google Console config.
// A `sessionToken` threads the keystrokes + the final details fetch into ONE billed Places
// session (much cheaper than per-keystroke billing) — the client generates it and resets it
// after a selection.

// Autocomplete: POST { input, sessionToken? }
export async function POST(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({ suggestions: [] });
  if (memRateLimited(`places:${proxyClientIp(req.headers)}`, 100, 60_000)) {
    return NextResponse.json({ suggestions: [] }, { status: 429 });
  }
  // The real fuse: shared across instances, survives restarts, fails CLOSED.
  if (await rateLimited("google-places:day", PLACES_CALLS_PER_DAY, 86400, { failClosed: true })) {
    return NextResponse.json({ suggestions: [] }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const input = String(body?.input ?? "").trim();
  const sessionToken = typeof body?.sessionToken === "string" && body.sessionToken ? body.sessionToken : undefined;
  if (input.length < 3) return NextResponse.json({ suggestions: [] });
  // WHERE TO LOOK FIRST. Without a bias Google ranks the whole country: on 2026-10-13, in front of
  // a client in Tahoe City, "4127 Egret" came back as a Georgia street (state GA, zip 30014 landed
  // on the visit). The client sends the phone's last fix, else the company's own ground
  // (lib/place-bias); a bias is a preference, never a fence — the right address anywhere still
  // wins when typed in full. 50 km is Google's ceiling for a circle, and Truckee to Tahoe City is 25.
  const lat: unknown = body?.bias?.lat;
  const lng: unknown = body?.bias?.lng;
  const biased =
    typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const here = { latitude: lat as number, longitude: lng as number };

  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: googleKeyHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      input,
      includedRegionCodes: ["us"],
      ...(biased ? { locationBias: { circle: { center: here, radius: BIAS_RADIUS_M } }, origin: here } : {}),
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}

// Place details: GET ?placeId=...&sessionToken=...
export async function GET(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({});
  // Same per-IP bucket as POST: this proxy spends a server key with no referrer
  // restriction, so an unguarded GET is a billable open relay. A real autocomplete
  // session makes ~1 details call per selection.
  if (memRateLimited(`places:${proxyClientIp(req.headers)}`, 100, 60_000)) {
    return NextResponse.json({}, { status: 429 });
  }
  if (await rateLimited("google-places:day", PLACES_CALLS_PER_DAY, 86400, { failClosed: true })) {
    return NextResponse.json({}, { status: 429 });
  }
  const placeId = req.nextUrl.searchParams.get("placeId");
  if (!placeId) return NextResponse.json({}, { status: 400 });
  const sessionToken = req.nextUrl.searchParams.get("sessionToken") || "";

  // DELIBERATELY NOT CACHED, unlike /geocode and /weather, and for a reason that inverts the
  // usual one: the session token is what makes the whole autocomplete session FREE, and a session
  // is only closed by its Details call actually reaching Google. Serving a cached Details
  // response would leave every session open, and Google would bill those autocomplete keystrokes
  // per request instead of per session — a cache here would COST money, not save it.
  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  const res = await fetch(url, {
    headers: googleKeyHeaders({ "X-Goog-FieldMask": "formattedAddress,addressComponents" }),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
