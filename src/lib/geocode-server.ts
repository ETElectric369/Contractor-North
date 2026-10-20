import { rateLimited } from "@/lib/rate-limit";
import { GOOGLE_KEY, googleUrlHeaders } from "@/lib/google-server";

/**
 * GOOGLE GEOCODING, BOTH WAYS, BEHIND ONE CACHE AND ONE FUSE.
 *
 * Forward (an address → where it is) is what /api/geocode always did for the weather widget's
 * shop-city lookup. Reverse (where the phone is → an address) is new: the Inspector's Use My
 * Location (Erik, 2026-10-13, in front of a client with no address on the visit: "a use my
 * location button right there would have been gold"). And the app shell asks forward once per
 * company so every address box can be BIASED to the company's own ground (lib/place-bias) — the
 * Catbird visit took a Georgia street because the autocomplete ranked the whole country.
 *
 * The fuse is the same hard daily ceiling the routes carry (Erik, after attaching a card to Google
 * Cloud: "i cant figure out what its going to charge me"): DB-backed, shared across instances,
 * fails CLOSED. Cached hard — an address does not move; Google's terms allow 30 days, this keeps
 * a week in the shared data cache and a day in memory. A miss ("not found") is remembered for an
 * hour so a typo cannot spend a call per keystroke; a FAILURE (timeout, network) is not remembered
 * at all, so the next ask tries again. 2.5 s and the shell paints without the bias rather than
 * waiting on Google for a page that is not about Google.
 */
export const GEOCODE_CALLS_PER_DAY = 2000;
/** Reverse has its OWN fuse: the ?latlng= door is a signed-in door, but a loop on it must never
 *  take the weather and the shell's bias down for the day with it. */
export const REVERSE_CALLS_PER_DAY = 1000;
const SHARED_TTL_SECONDS = 7 * 24 * 60 * 60;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
/** A failure or an exhausted fuse is remembered briefly, so a Google brownout costs one 2.5 s wait
 *  per minute per instance, not one per shell render. */
const FAIL_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

export type GeoParts = { line1: string; city: string; state: string; zip: string };
export type GeoPlace = { lat: number; lng: number; formatted: string } & GeoParts;
export type GeocodeResult =
  | { status: "ok"; place: GeoPlace }
  | { status: "unconfigured" | "limited" | "notfound" | "failed" };

type Component = { long_name?: string; short_name?: string; types?: string[] };
type GeocodeRow = {
  formatted_address?: string;
  types?: string[];
  geometry?: { location?: { lat?: unknown; lng?: unknown } };
  address_components?: Component[];
};

/** Google Geocoding `address_components` → the four parts the app stores beside a line (0177).
 *  Pure; the Places (New) response names the same fields longText/shortText and has its own
 *  reader in address-autocomplete.tsx. */
export function partsFromComponents(comps: Component[] | null | undefined): GeoParts {
  const get = (type: string, short = false) => {
    const c = (comps ?? []).find((x) => (x.types ?? []).includes(type));
    return (short ? c?.short_name : c?.long_name) ?? "";
  };
  return {
    line1: `${get("street_number")} ${get("route")}`.trim(),
    city: get("locality") || get("postal_town") || get("sublocality_level_1") || get("administrative_area_level_3"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
  };
}

/** THE ROW A REVERSE LOOKUP TAKES. Google answers a point with several rows, most specific first,
 *  and on open ground the first can be a plus code ("8FWH+2V Tahoe City") or a bare road. Only a
 *  street address (a number on a street) or a premise is an address a job can carry; a road, a
 *  neighbourhood or a plus code is "not found", and the person types the number. Pure. */
export function pickReverse(rows: GeocodeRow[] | null | undefined): GeocodeRow | null {
  const list = (rows ?? []).filter((r) => r && typeof r === "object");
  const has = (r: GeocodeRow, t: string) => (r.types ?? []).includes(t);
  return list.find((r) => has(r, "street_address") || has(r, "subpremise")) ?? list.find((r) => has(r, "premise")) ?? null;
}

function placeFrom(row: GeocodeRow | null): GeoPlace | null {
  const loc = row?.geometry?.location;
  if (!row || !loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
  return { lat: loc.lat, lng: loc.lng, formatted: String(row.formatted_address ?? ""), ...partsFromComponents(row.address_components) };
}

const cache = new Map<string, { at: number; result: GeocodeResult }>();
const ttlFor = (r: GeocodeResult) => (r.status === "ok" ? HIT_TTL_MS : r.status === "notfound" ? MISS_TTL_MS : FAIL_TTL_MS);

async function lookup(opts: {
  key: string;
  query: string;
  fuse: { key: string; limit: number };
  /** Forward answers go in the shared data cache for a week (an address does not move). A reverse
   *  answer is a worker's exact position and stays in this instance's memory only. */
  shared: boolean;
  pick: (rows: GeocodeRow[]) => GeocodeRow | null;
}): Promise<GeocodeResult> {
  if (!GOOGLE_KEY) return { status: "unconfigured" };
  const hit = cache.get(opts.key);
  if (hit && Date.now() - hit.at < ttlFor(hit.result)) return hit.result;
  if (cache.size > 5000) cache.clear();
  // The real fuse: shared across instances, survives restarts, fails CLOSED.
  let result: GeocodeResult;
  if (await rateLimited(opts.fuse.key, opts.fuse.limit, 86400, { failClosed: true })) {
    result = { status: "limited" };
  } else {
    try {
      const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${opts.query}&key=${GOOGLE_KEY}`, {
        headers: googleUrlHeaders(),
        ...(opts.shared ? { next: { revalidate: SHARED_TTL_SECONDS } } : { cache: "no-store" as const }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { results?: GeocodeRow[]; status?: string };
      // Google says no with an HTTP 200: REQUEST_DENIED, OVER_QUERY_LIMIT, INVALID_REQUEST. Those
      // are failures (remembered a minute, then tried again), never "not found" (remembered an hour).
      if (!res.ok || (data.status !== "OK" && data.status !== "ZERO_RESULTS")) result = { status: "failed" };
      else {
        const place = placeFrom(opts.pick(Array.isArray(data.results) ? data.results : []));
        result = place ? { status: "ok", place } : { status: "notfound" };
      }
    } catch {
      result = { status: "failed" };
    }
  }
  cache.set(opts.key, { at: Date.now(), result });
  return result;
}

/** An address → where it is (+ its parts). Empty → not found, no call. */
export function geocodeAddress(address: string): Promise<GeocodeResult> {
  const a = address.trim();
  if (!a) return Promise.resolve({ status: "notfound" });
  return lookup({
    key: `a:${a.toLowerCase()}`,
    query: `address=${encodeURIComponent(a)}`,
    fuse: { key: "google-geocode:day", limit: GEOCODE_CALLS_PER_DAY },
    shared: true,
    pick: (rows) => rows[0] ?? null,
  });
}

/** Where the phone is → the address there (+ its parts). */
export function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return Promise.resolve({ status: "notfound" });
  }
  // Five decimals is a metre: the same spot asked twice is one call, and the URL never carries
  // more of a person's position than the answer needs.
  const at = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  return lookup({
    key: `r:${at}`,
    query: `latlng=${at}`,
    fuse: { key: "google-geocode-reverse:day", limit: REVERSE_CALLS_PER_DAY },
    shared: false,
    pick: pickReverse,
  });
}

/** The company's own address as one line, or "" when the record has none. Pure. */
export function orgAddressLine(org: { address_line1?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null | undefined): string {
  if (!org) return "";
  const street = (org.address_line1 ?? "").trim();
  if (!street) return ""; // a city alone would bias every box to a town centre; a street is a place
  const tail = [org.city, org.state, org.zip].map((p) => (p ?? "").trim()).filter(Boolean).join(", ");
  return tail ? `${street}, ${tail}` : street;
}

/** WHERE THE COMPANY IS, for biasing address boxes (lib/place-bias). Never throws, never waits past
 *  the fetch timeout: the shell paints without a bias before it waits on Google. */
export async function orgPlaceBias(org: Parameters<typeof orgAddressLine>[0]): Promise<{ lat: number; lng: number } | null> {
  const line = orgAddressLine(org);
  if (!line) return null;
  try {
    const r = await geocodeAddress(line);
    return r.status === "ok" ? { lat: r.place.lat, lng: r.place.lng } : null;
  } catch {
    return null;
  }
}
