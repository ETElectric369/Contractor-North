import { headers } from "next/headers";
import { getPublicOrgByDomain, getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPosts } from "@/lib/public-posts";

export const dynamic = "force-dynamic";

/**
 * Per-org RSS feed, served at /blog/rss.xml (and /feed, /rss.xml) on every org site —
 * middleware rewrites those paths here with the org resolved from the Host header (or
 * ?handle= for subdomain sites). Squarespace ships ?format=rss automatically; this closes
 * that gap (SEO wave 2026-07-24) — syndication readers, aggregators, and some crawlers use
 * the feed for discovery. Bare-bones RSS 2.0 on purpose: title/link/description/pubDate.
 */
const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(req: Request) {
  const host = ((await headers()).get("host") || "").toLowerCase().split(":")[0];
  const handle = new URL(req.url).searchParams.get("handle");
  const org = handle ? await getPublicOrgByHandle(handle) : await getPublicOrgByDomain(host);
  if (!org) return new Response("Not found", { status: 404 });

  const base = `https://${host}`;
  const posts = await getPublicPosts(org.id);
  const items = posts
    .slice(0, 50)
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${base}/${esc(p.path)}</link>
      <guid isPermaLink="true">${base}/${esc(p.path)}</guid>
      ${p.description ? `<description>${esc(p.description)}</description>` : ""}
      ${p.published_at ? `<pubDate>${new Date(p.published_at).toUTCString()}</pubDate>` : ""}
    </item>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(org.name)} — Articles</title>
    <link>${base}/blog</link>
    <description>Guides and articles from ${esc(org.name)}.</description>
${items}
  </channel>
</rss>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=900" },
  });
}
