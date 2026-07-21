import { type NextRequest, NextResponse } from "next/server";
import { GOOGLE_KEY, googleUrlHeaders, memRateLimited, proxyClientIp } from "@/lib/google-server";

export const runtime = "nodejs";

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
