import { type NextRequest, NextResponse } from "next/server";

// Server-side proxy for Google Places (New). Keeps the request same-origin so
// the address autocomplete works on ANY domain (custom domains, reseller
// domains) without each needing to be whitelisted on the referrer-restricted
// Maps key — we send an allowed Referer header from the server instead.
const KEY =
  process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";
const REFERER = process.env.PLACES_PROXY_REFERER || "https://contractor-north.vercel.app/";

// Autocomplete: POST { input }
export async function POST(req: NextRequest) {
  if (!KEY) return NextResponse.json({ suggestions: [] });
  const body = await req.json().catch(() => ({}));
  const input = String(body?.input ?? "").trim();
  if (input.length < 3) return NextResponse.json({ suggestions: [] });

  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      Referer: REFERER,
    },
    body: JSON.stringify({ input, includedRegionCodes: ["us"] }),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}

// Place details: GET ?placeId=...
export async function GET(req: NextRequest) {
  if (!KEY) return NextResponse.json({});
  const placeId = req.nextUrl.searchParams.get("placeId");
  if (!placeId) return NextResponse.json({}, { status: 400 });

  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    {
      headers: {
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "formattedAddress,addressComponents",
        Referer: REFERER,
      },
    },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
