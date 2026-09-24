import { normalizeHost } from "@/lib/public-host";

/**
 * CONTRACTOR NORTH'S OWN PUBLIC PAGES — the home page, /support and /privacy on the APEX host
 * (contractornorth.com and www.contractornorth.com) and nowhere else.
 *
 * Why the apex only: every other host already means something. app.contractornorth.com is the
 * app (its "/" is the app landing, and the native shell opens there), <handle>.contractornorth.com
 * is a tenant's site, and a tenant's custom domain is the tenant's. A /privacy or /support on any
 * of those would either shadow a tenant's own page or put the platform's words on a contractor's
 * domain. So the routes live in an INTERNAL namespace (/north-site) that middleware only rewrites
 * into from the apex, and that namespace 404s when asked for by name on any host.
 *
 * "NOT POSTED YET" (Erik, 2026-09-24: "get it ready but don't post it yet"): the apex and www are
 * DETACHED from the Vercel project (the invite-only lockdown, 2026-07-13), so no request for them
 * reaches this code in production. Posting = reattaching those two domains. Nothing in this file
 * needs to change when that happens.
 */

const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();

/** The internal route namespace (src/app/north-site). Never a public URL. */
export const PLATFORM_SITE_ROOT = "/north-site";

/** Public path on the apex → internal route. Exactly three pages; anything else on the apex 404s. */
const PAGES: ReadonlyMap<string, string> = new Map([
  ["/", PLATFORM_SITE_ROOT],
  ["/support", `${PLATFORM_SITE_ROOT}/support`],
  ["/privacy", `${PLATFORM_SITE_ROOT}/privacy`],
]);

/** Is this the platform's own apex (or its www)? The ONLY hosts that may render the platform pages. */
export function isPlatformApexHost(rawHost: string | null | undefined): boolean {
  const host = normalizeHost(rawHost);
  return host === SITES_DOMAIN || host === `www.${SITES_DOMAIN}`;
}

/** The internal route a public apex path renders, or null when the apex has no such page.
 *  Case and a trailing slash are tolerated: /Privacy/ and /privacy are one URL. */
export function platformSiteRewrite(pathname: string): string | null {
  const p = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return PAGES.get(p) ?? null;
}

/** A request that names the internal namespace directly (/north-site, /north-site/privacy …).
 *  It is reachable only through the apex rewrite, which does not re-enter middleware, so a
 *  direct request for it is refused on every host. */
export function isPlatformSiteInternalPath(pathname: string): boolean {
  const p = pathname.toLowerCase().replace(/\/+$/, "");
  return p === PLATFORM_SITE_ROOT || p.startsWith(`${PLATFORM_SITE_ROOT}/`);
}
