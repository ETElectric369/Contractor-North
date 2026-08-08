import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/** Per-host robots.txt. Every org site (subdomain or custom domain) gets one that points crawlers
 *  at that host's sitemap. Served for the app's own host too.
 *
 *  ── DISALLOW AND NOINDEX ARE NOT THE SAME TOOL, AND USING BOTH BREAKS ONE OF THEM ──
 *
 *  Erik forwarded a Search Console warning on 2026-08-06: "Blocked by robots.txt" on
 *  etelectricity.com. The only blocked link on his homepage was /login — which already serves
 *  `noindex, nofollow, noarchive, nocache`. Belt AND braces, and the braces cut the belt:
 *
 *    Disallow  = "never FETCH this."  A blocked URL can still be INDEXED url-only from an inbound
 *                link, and because the crawler never fetches it, it never sees the noindex that
 *                would have removed it properly. Blocking is how a page gets stuck in the index
 *                with no snippet — the opposite of what it was reached for.
 *    noindex   = "fetch it, then drop it."  This is the one that actually removes a page, and it
 *                REQUIRES the crawl to work.
 *
 *  So the split is now by INTENT, not by caution:
 *    - Disallow ONLY what must never be fetched at all: /api/ (not HTML — it can't carry a
 *      noindex) and the token portals (/i/ /q/ /c/ /portal/ /pick/ /voice/), which are SECRET
 *      URLs handed to one customer. A crawler fetching one of those is itself the problem.
 *    - Everything else that must stay out of the index carries NO_INDEX (@/lib/no-index) and is
 *      left crawlable, so the directive can actually be read and obeyed. Verified live: /login,
 *      /jobs, /settings, /print, /offline and /inquire all serve it today.
 *
 *  The old list also blocked /site/ — the internal rewrite target for an org's homepage. Those
 *  pages carry a rel=canonical to the org's public base, which is the right instrument for a
 *  duplicate; blocking it just hid the canonical from the only party that reads it. */
export async function GET() {
  const host = (await headers()).get("host") || "contractornorth.com";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const body = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /i/
Disallow: /q/
Disallow: /c/
Disallow: /portal/
Disallow: /pick/
Disallow: /voice/

Sitemap: ${proto}://${host}/sitemap.xml
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
