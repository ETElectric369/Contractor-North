import { type NextRequest, NextResponse } from "next/server";
import { GOOGLE_KEY, memRateLimited, proxyClientIp } from "@/lib/google-server";
import { geocodeAddress, reverseGeocode, type GeocodeResult } from "@/lib/geocode-server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Same-origin proxy for Google Geocoding, both ways, with the unrestricted server key (so it works
// on any domain, key never exposed). The cache, the hard daily ceiling and the words about why it
// is a fuse rather than a quota live in lib/geocode-server.
//
//   GET ?address=…      an address → lat/lng (+ its parts). The weather widget's shop-city lookup.
//   GET ?latlng=lat,lng where the phone is → the address there. The Inspector's Use My Location —
//                       a SIGNED-IN door (the route itself is public for the weather on the
//                       marketing site), on its own daily fuse.
//
// The per-IP guard below is politeness (in-process, per instance); the DB-backed daily fuse behind
// geocodeAddress/reverseGeocode is the thing that stands between a loop and the card on file.
const LATLNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function answer(r: GeocodeResult) {
  if (r.status === "ok") return NextResponse.json(r.place);
  if (r.status === "unconfigured") return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (r.status === "limited") return NextResponse.json({ error: "daily limit reached" }, { status: 429 });
  if (r.status === "failed") return NextResponse.json({ error: "lookup failed" }, { status: 502 });
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function GET(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (memRateLimited(`geocode:${proxyClientIp(req.headers)}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const latlng = (req.nextUrl.searchParams.get("latlng") || "").trim();
  if (latlng) {
    const m = LATLNG.exec(latlng);
    const lat = m ? Number(m[1]) : NaN;
    const lng = m ? Number(m[2]) : NaN;
    if (!m || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return NextResponse.json({ error: "latlng must be lat,lng" }, { status: 400 });
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
    return answer(await reverseGeocode(lat, lng));
  }
  const address = (req.nextUrl.searchParams.get("address") || "").trim();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
  return answer(await geocodeAddress(address));
}
