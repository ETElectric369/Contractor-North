import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/** Per-host robots.txt. Every org site (subdomain or custom domain) gets one that allows its
 *  public marketing pages, blocks the app internals + API + every customer-document URL, and
 *  points crawlers at that host's sitemap. Served for the app's own host too.
 *
 *  THIS IS THE WEAKER HALF of the noindex pair: a Disallow'd URL can still be indexed URL-only
 *  from an inbound link, and a crawler that never fetches the page never sees its noindex tag.
 *  The authoritative directive is the per-page `robots` metadata (@/lib/no-index). Keep BOTH,
 *  and keep this list in sync with the routes that use NO_INDEX. */
export async function GET() {
  const host = (await headers()).get("host") || "contractornorth.com";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const body = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /dashboard
Disallow: /planner
Disallow: /settings
Disallow: /jobs
Disallow: /quotes
Disallow: /billing
Disallow: /payments
Disallow: /crm
Disallow: /team
Disallow: /schedule
Disallow: /leads
Disallow: /onboarding
Disallow: /login
Disallow: /i/
Disallow: /q/
Disallow: /c/
Disallow: /portal/
Disallow: /pick/
Disallow: /voice/
Disallow: /print/

Sitemap: ${proto}://${host}/sitemap.xml
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
