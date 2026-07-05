import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/** Per-host robots.txt. Every org site (subdomain or custom domain) gets one that allows its
 *  public marketing pages, blocks the app internals + API, and points crawlers at that host's
 *  sitemap. Served for the app's own host too. */
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
Disallow: /invoices
Disallow: /crm
Disallow: /team
Disallow: /schedule
Disallow: /onboarding

Sitemap: ${proto}://${host}/sitemap.xml
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
