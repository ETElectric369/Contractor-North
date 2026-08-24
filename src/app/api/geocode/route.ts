import { type NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/rate-limit";
import { GOOGLE_KEY, googleUrlHeaders, memRateLimited, proxyClientIp } from "@/lib/google-server";

export const runtime = "nodejs";

/**
 * A HARD DAILY CEILING ON BILLED GOOGLE CALLS (Erik, after attaching a card to Google Cloud:
 * "i cant figure out what its going to charge me").
 *
 * These three proxies are deliberately PUBLIC — the marketing site's contact form and the
 * estimate configurator need address autocomplete before anyone signs in. Their only guard was
 * memRateLimited, which is per-IP AND in-process: on serverless it resets every cold start and
 * two instances never see each other's counts. That is a politeness guard, not a cost ceiling,
 * and politeness is not what stands between a stranger with a loop and a card on file.
 *
 * The DB-backed limiter is shared across every instance and survives restarts, so a global
 * per-day cap is a real number. failClosed: if the limiter itself is broken we STOP calling
 * Google — an outage of our own rate limiter must never become an unbounded bill.
 *
 * These numbers are far above real use (three orgs, a handful of staff, a marketing site) and
 * far below anything that would matter on a bill. They are a fuse, not a quota.
 */
const GEOCODE_CALLS_PER_DAY = 2000;

// Same-origin proxy for Google Geocoding — turn an address/city string into lat/lng, server-side
// with the unrestricted server key (so it works on any domain, key never exposed). Cached hard:
// an address doesn't move. Used by the weather widget's shop-city lookup, and available to any
// caller that needs coordinates without loading the whole Maps JS bundle.
const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day

/** L2, shared across instances and deploys — see the long note in api/weather, which has the
 *  same per-instance miss problem for the same reason. A WEEK here rather than thirty minutes,
 *  because an address's coordinates are not a reading that goes stale: 1000 Reno Ave is where it
 *  was last Tuesday. Google's terms permit caching geocoded lat/lng for up to 30 days, so seven
 *  is well inside them. */
const SHARED_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function GET(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (memRateLimited(`geocode:${proxyClientIp(req.headers)}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  // The real fuse: shared across instances, survives restarts, fails CLOSED.
  if (await rateLimited("google-geocode:day", GEOCODE_CALLS_PER_DAY, 86400, { failClosed: true })) {
    return NextResponse.json({ error: "daily limit reached" }, { status: 429 });
  }
  const address = (req.nextUrl.searchParams.get("address") || "").trim();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const ck = address.toLowerCase();
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body);
  if (cache.size > 5000) cache.clear();

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`,
    { headers: googleUrlHeaders(), next: { revalidate: SHARED_TTL_SECONDS } },
  );
  const data = await res.json().catch(() => ({}) as Record<string, unknown>);
  const loc = (data as any)?.results?.[0]?.geometry?.location;
  if (loc && typeof loc.lat === "number") {
    const body = { lat: loc.lat, lng: loc.lng, formatted: (data as any).results[0].formatted_address };
    cache.set(ck, { at: Date.now(), body });
    return NextResponse.json(body);
  }
  return NextResponse.json({ error: (data as any)?.status || "not found" }, { status: 404 });
}
