import { type NextRequest, NextResponse } from "next/server";
import { GOOGLE_KEY, googleUrlHeaders, memRateLimited, proxyClientIp } from "@/lib/google-server";

export const runtime = "nodejs";

// Same-origin proxy for Google Geocoding — turn an address/city string into lat/lng, server-side
// with the unrestricted server key (so it works on any domain, key never exposed). Cached hard:
// an address doesn't move. Used by the weather widget's shop-city lookup, and available to any
// caller that needs coordinates without loading the whole Maps JS bundle.
const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day

export async function GET(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (memRateLimited(`geocode:${proxyClientIp(req.headers)}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const address = (req.nextUrl.searchParams.get("address") || "").trim();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const ck = address.toLowerCase();
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body);
  if (cache.size > 5000) cache.clear();

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`,
    { headers: googleUrlHeaders() },
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
