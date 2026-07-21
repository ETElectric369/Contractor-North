// Server-side Google Maps access — THE key to multi-tenant.
//
// The browser must never call Google directly for DATA (weather, places, geocoding): a
// browser-exposed key has to be HTTP-referrer restricted, and a referrer allowlist can't
// scale to hundreds of customer/reseller custom domains. Instead the browser calls OUR
// same-origin proxy routes, and those routes call Google with the SERVER key below — which
// has NO referrer restriction, so it works from every tenant domain with ZERO per-domain
// Google Console config. The only thing that stays a browser key is the interactive map
// (Maps JS), which only ever runs on our single app domain.
//
// Fallback: during rollout (before GOOGLE_MAPS_SERVER_KEY is set) we fall back to the old
// browser key + a spoofed allowed Referer header, since a referrer-restricted key otherwise
// rejects a server-to-server call outright.

const SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || "";
const FALLBACK_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "";

/** The key our proxy routes call Google with — the unrestricted server key when set. */
export const GOOGLE_KEY = SERVER_KEY || FALLBACK_KEY;

/** Only the referrer-restricted FALLBACK key needs a spoofed allowed Referer; the server key does not. */
const SPOOF_REFERER = SERVER_KEY ? "" : process.env.PLACES_PROXY_REFERER || "https://contractor-north.vercel.app/";

/** Headers for the header-key Google APIs (Places New): X-Goog-Api-Key (+ spoofed Referer on fallback). */
export function googleKeyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "X-Goog-Api-Key": GOOGLE_KEY, ...extra };
  if (SPOOF_REFERER) h.Referer = SPOOF_REFERER;
  return h;
}

/** Headers for the URL-key Google APIs (Weather, Geocoding — key goes in ?key=): spoofed Referer on fallback. */
export function googleUrlHeaders(): Record<string, string> {
  return SPOOF_REFERER ? { Referer: SPOOF_REFERER } : {};
}

// ── Lightweight in-memory throttle ──────────────────────────────────────────
// Public proxy routes must not let anyone burn our paid Google quota. A DB round-trip per
// autocomplete keystroke would be too heavy on this hot path, so this is a per-instance
// fixed window — cheap, and combined with the client debounce + a quota cap on the key it's
// adequate abuse protection (the Google quota cap is the real backstop).
const buckets = new Map<string, { count: number; resetAt: number }>();
export function memRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 5000) buckets.clear(); // unbounded-growth guard (cold-start-cheap)
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

/** Best-effort client IP for throttling (never trusted for auth). */
export function proxyClientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for") || "").split(",")[0].trim() || headers.get("x-real-ip") || "unknown";
}
