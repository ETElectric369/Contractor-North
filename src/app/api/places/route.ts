import { type NextRequest, NextResponse } from "next/server";
import { GOOGLE_KEY, googleKeyHeaders, memRateLimited, proxyClientIp } from "@/lib/google-server";

export const runtime = "nodejs";

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
  const body = await req.json().catch(() => ({}));
  const input = String(body?.input ?? "").trim();
  const sessionToken = typeof body?.sessionToken === "string" && body.sessionToken ? body.sessionToken : undefined;
  if (input.length < 3) return NextResponse.json({ suggestions: [] });

  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: googleKeyHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ input, includedRegionCodes: ["us"], ...(sessionToken ? { sessionToken } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}

// Place details: GET ?placeId=...&sessionToken=...
export async function GET(req: NextRequest) {
  if (!GOOGLE_KEY) return NextResponse.json({});
  const placeId = req.nextUrl.searchParams.get("placeId");
  if (!placeId) return NextResponse.json({}, { status: 400 });
  const sessionToken = req.nextUrl.searchParams.get("sessionToken") || "";

  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set("sessionToken", sessionToken);
  const res = await fetch(url, {
    headers: googleKeyHeaders({ "X-Goog-FieldMask": "formattedAddress,addressComponents" }),
  });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : res.status });
}
