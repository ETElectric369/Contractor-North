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
const WEATHER_CALLS_PER_DAY = 2000;

// Same-origin proxy for Google's Weather API. The browser hits this route; we call Google with
// the unrestricted server key — so it works on any domain, the key never ships to the browser,
// and we CACHE (weather doesn't change minute-to-minute) to cut cost + latency. Returns the raw
// Google shape so the widget's parsing is unchanged.
const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 10 * 60 * 1000; // 10 min

export async function GET(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (memRateLimited(`weather:${proxyClientIp(req.headers)}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  // The real fuse: shared across instances, survives restarts, fails CLOSED.
  if (await rateLimited("google-weather:day", WEATHER_CALLS_PER_DAY, 86400, { failClosed: true })) {
    return NextResponse.json({ error: "daily limit reached" }, { status: 429 });
  }
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "bad coordinates" }, { status: 400 });
  }
  const ck = `${lat.toFixed(2)},${lng.toFixed(2)}`; // ~1km bucket — plenty for a city temperature
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body);
  if (cache.size > 2000) cache.clear();

  const url =
    `https://weather.googleapis.com/v1/currentConditions:lookup?key=${GOOGLE_KEY}` +
    `&location.latitude=${lat}&location.longitude=${lng}&unitsSystem=IMPERIAL`;
  const res = await fetch(url, { headers: googleUrlHeaders() });
  const data = await res.json().catch(() => ({}));
  if (res.ok) cache.set(ck, { at: Date.now(), body: data });
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
