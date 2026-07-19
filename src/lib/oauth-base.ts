import "server-only";

/**
 * Which base URL the OAuth redirect URIs (Google Calendar + QuickBooks) are built on.
 *
 * The Supabase session cookie AND the oauth_state CSRF cookie are HOST-ONLY (no Domain
 * attribute — see supabase/server.ts and oauth-state.ts), so the provider MUST send the
 * user back to the same host the connect started on. A callback landing on any other
 * host finds no state cookie and no session and dead-ends in ?gcal=denied/?qbo=denied —
 * exactly what happened after the app.contractornorth.com cutover while
 * OAUTH_REDIRECT_BASE stayed pinned to contractor-north.vercel.app.
 *
 * Rule: when the request arrives on an APP host (where a session can exist), use the
 * request's own origin so the round-trip stays on the host that holds the cookies.
 * OAUTH_REDIRECT_BASE (else NEXT_PUBLIC_SITE_URL) remains the explicit fallback for
 * any other host. The connect route and the callback route derive the same value —
 * required, because the token exchange must repeat the exact redirect_uri authorized.
 *
 * ⚠ Provider consoles: EVERY base this can return must have its callback registered,
 * or the provider rejects the flow with redirect_uri_mismatch:
 *   Google Cloud console (OAuth client):  <base>/api/google/callback
 *   Intuit developer portal:              <base>/api/quickbooks/callback
 * for BOTH https://contractor-north.vercel.app and https://app.contractornorth.com.
 */

const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();
// Mirrors middleware.ts: subdomains of SITES_DOMAIN that serve the app, never an org site.
const RESERVED_SUBS = new Set(["www", "app", "api", "admin", "mail", "staging", "dev", "preview"]);
const EXTRA_APP_HOSTS = new Set(
  (process.env.APP_HOSTS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
);

/** Same classification middleware.ts uses (plus its RESERVED_SUBS carve-out, which is how
 *  app.contractornorth.com serves the app): infra hosts + the platform domain = the app. */
function isAppHost(host: string): boolean {
  if (!host || host === "localhost" || host === "127.0.0.1") return true;
  if (host.startsWith("[")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // bare IPv4
  if (host.endsWith(".vercel.app")) return true; // deploy + preview URLs
  if (host === SITES_DOMAIN || host === `www.${SITES_DOMAIN}`) return true;
  if (host.endsWith(`.${SITES_DOMAIN}`)) {
    const sub = host.slice(0, host.length - SITES_DOMAIN.length - 1);
    if (sub && !sub.includes(".") && RESERVED_SUBS.has(sub)) return true; // app.contractornorth.com et al.
  }
  return EXTRA_APP_HOSTS.has(host);
}

/** The redirect base for THIS request: its own origin on an app host, else the env pin. */
export function oauthRedirectBase(req: Request): string {
  const url = new URL(req.url);
  if (isAppHost(url.hostname.toLowerCase())) return url.origin;
  return (
    process.env.OAUTH_REDIRECT_BASE ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://contractor-north.vercel.app"
  );
}
