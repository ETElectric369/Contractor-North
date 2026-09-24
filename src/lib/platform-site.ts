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
 * "NOT POSTED YET" (Erik, 2026-09-24: "get it ready but don't post it yet"): the SWITCH below
 * keeps these pages dark. It is off unless PLATFORM_SITE_POSTED is exactly "1". Detaching domains
 * is NOT enough on its own: the bare apex is detached from the Vercel project (the invite-only
 * lockdown, 2026-07-13), but the *.contractornorth.com wildcard still routes www to this
 * deployment (live 2026-09-24: www answers with this middleware's own "Not found"). So with the
 * switch off, the apex and www 404 every path exactly as they did before these pages existed.
 *
 * Posting = (1) the support mailbox receives mail (north-site/site-facts.ts), (2) set
 * PLATFORM_SITE_POSTED=1 in the Vercel project and redeploy, (3) attach the bare apex. www starts
 * answering at step 2, because it is already attached through the wildcard.
 * Local preview: run the dev server with PLATFORM_SITE_POSTED=1 and send Host: contractornorth.com.
 */

const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();

/** THE POSTING SWITCH. Read per call (not at module load) so a test can flip it; in production
 *  it is fixed per deploy. Off = the apex and www stay the lockdown 404 for every path. */
export function platformSitePosted(): boolean {
  return process.env.PLATFORM_SITE_POSTED === "1";
}

/** The internal route namespace (src/app/north-site). Never a public URL. */
export const PLATFORM_SITE_ROOT = "/north-site";

/** Public path on the apex → internal route. Exactly three pages; anything else on the apex 404s. */
const PAGES: ReadonlyMap<string, string> = new Map([
  ["/", PLATFORM_SITE_ROOT],
  ["/support", `${PLATFORM_SITE_ROOT}/support`],
  ["/privacy", `${PLATFORM_SITE_ROOT}/privacy`],
]);

/** robots.txt on the apex once posted. The apex has exactly three pages, all public, and no
 *  sitemap; the app's own robots route is never reached there (every other path 404s). */
export const PLATFORM_ROBOTS_TXT = "User-agent: *\nAllow: /\n";

/** Is this the platform's own apex (or its www)? The ONLY hosts that may render the platform pages,
 *  and only once platformSitePosted() is on. */
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
