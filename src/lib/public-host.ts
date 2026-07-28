/**
 * WHICH HOST MAY SERVE WHICH ORG'S PUBLIC PAGES.
 *
 * The platform answers on many hostnames — each tenant's custom domain, each tenant's free
 * subdomain, the app host, and the deploy URL. Three public routes take the org from the URL
 * (`/site/<handle>`, `/estimate/<handle>`, `/inquire/<org-id>`) and, until now, none of them
 * compared that to the host the request actually arrived on. So every one of them served a
 * tenant's whole marketing presence on the OTHER tenant's domain:
 *
 *     GET https://etelectricity.com/estimate/tahoe-deck  -> 200, Tahoe Deck's configurator + pricing
 *     GET https://tahoedeck.com/inquire/<ET's org id>    -> 200, ET's phone, email and C-10 number
 *
 * The canonical tags were correct, so search-index consolidation held — but a canonical is a hint,
 * and it does nothing about a 200 serving one contractor's brand on another contractor's domain.
 *
 * THE RULE: a tenant page is served on that tenant's own hosts, or on an app host (where the
 * platform legitimately renders any org for preview and internal tools). Anywhere else: 404.
 *
 * This lives in one module because the previous version of this rule was three near-copies that
 * drifted — /site/ was fixed in middleware while /estimate and /inquire stayed open.
 */

const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();

/** Subdomains of SITES_DOMAIN that belong to the app or infra, never to an org site. */
export const RESERVED_SUBS: ReadonlySet<string> = new Set([
  "www", "app", "api", "admin", "mail", "staging", "dev", "preview",
]);

const EXTRA_APP_HOSTS = new Set(
  (process.env.APP_HOSTS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
);

/** Strip port and lowercase — every comparison here is on the bare hostname. */
export function normalizeHost(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().split(":")[0].replace(/\.$/, ""); // trailing dot = same host
}

/**
 * Is this host the APP (login, dashboard, previews) rather than an org's public marketing site?
 * Infra hosts — localhost, bare IPs, deploy URLs — serve the app so health checks and previews work.
 */
export function isAppHostname(rawHost: string | null | undefined): boolean {
  const host = normalizeHost(rawHost);
  if (!host || host === "localhost" || host === "127.0.0.1") return true;
  if (host.startsWith("[")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // bare IPv4
  if (host.endsWith(".vercel.app")) return true; // deploy + preview URLs
  if (host === SITES_DOMAIN || host === `www.${SITES_DOMAIN}`) return true;
  if (host === `app.${SITES_DOMAIN}`) return true; // the canonical app host, with or without APP_HOSTS
  return EXTRA_APP_HOSTS.has(host);
}

/**
 * A reserved subdomain that is NOT the app host — api/admin/staging/mail/dev/preview. These
 * resolve through the wildcard DNS record but name nothing: each was serving its own indexable
 * copy of the app landing page, advertising itself in its own sitemap, which contradicts the
 * invite-only lockdown that already 404s the apex.
 */
export function isDeadReservedHost(rawHost: string | null | undefined): boolean {
  const host = normalizeHost(rawHost);
  if (!host.endsWith(`.${SITES_DOMAIN}`)) return false;
  const sub = host.slice(0, host.length - SITES_DOMAIN.length - 1);
  if (!sub || sub.includes(".")) return false;
  return RESERVED_SUBS.has(sub) && sub !== "app";
}

/** The hosts an org's own public pages legitimately answer on: its custom domain (with or without
 *  www) and its free <handle> subdomain. */
export function orgOwnsHost(
  settings: { custom_domain?: string | null; public_handle?: string | null } | null | undefined,
  rawHost: string | null | undefined,
): boolean {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  const domain = normalizeHost((settings?.custom_domain ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (domain && (host === domain || host === `www.${domain}`)) return true;
  const handle = String(settings?.public_handle ?? "").trim().toLowerCase();
  if (handle && host === `${handle}.${SITES_DOMAIN}`) return true;
  return false;
}

/**
 * THE gate for an org-scoped public route. True when this host may render this org.
 *
 * A tenant's own host serves that tenant to ANYONE — that is the whole point of a public
 * marketing site and a public lead form.
 *
 * The APP host is different, and the first version of this function got it wrong by returning
 * true for any app host unconditionally. That made app.contractornorth.com an ENUMERABLE TENANT
 * DIRECTORY: guess a handle, get that customer's whole site, signed out.
 *     GET https://app.contractornorth.com/site/tahoe-deck   -> 200  <title>TAHOE DECK …
 *     GET https://app.contractornorth.com/site/et-electric  -> 200  <title>ET Electric …
 * Between two brothers that is a convenience. For a product sold to strangers it is a customer
 * list anyone can walk. The app host renders other tenants only for PREVIEW and internal
 * tooling, and both of those have a signed-in human behind them — so it now requires a session.
 *
 * `hasSession` must come from a VALIDATED session (supabase.auth.getUser()), never from the mere
 * presence of a cookie — an earlier guard here tested a cookie NAME and was defeated by
 * `curl -H 'Cookie: sb-x-auth-token=garbage'`.
 */
export function mayServeOrgOnHost(
  settings: { custom_domain?: string | null; public_handle?: string | null } | null | undefined,
  rawHost: string | null | undefined,
  hasSession = false,
): boolean {
  if (orgOwnsHost(settings, rawHost)) return true;
  return isAppHostname(rawHost) && hasSession;
}
