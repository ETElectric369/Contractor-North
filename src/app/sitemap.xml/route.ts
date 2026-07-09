import { headers } from "next/headers";
import { getPublicOrgByHandle, getPublicOrgByDomain } from "@/lib/public-org";
import { getPublicPosts } from "@/lib/public-posts";
import { getPublicPageSlugs } from "@/lib/public-pages";
import { orgPublicBaseUrl } from "@/lib/org-settings";

export const dynamic = "force-dynamic";

const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();

/** Resolve the org whose public site is served on this host — a free subdomain
 *  (<handle>.SITES_DOMAIN) or a custom domain. Returns null for the app's own hosts. */
async function orgForHost(host: string) {
  const h = host.split(":")[0].toLowerCase();
  if (!h || h === "localhost" || h === "127.0.0.1" || h.endsWith(".vercel.app")) return null;
  if (h === SITES_DOMAIN || h === `www.${SITES_DOMAIN}`) return null;
  if (h.endsWith(`.${SITES_DOMAIN}`)) {
    const sub = h.slice(0, h.length - SITES_DOMAIN.length - 1);
    return sub && !sub.includes(".") ? getPublicOrgByHandle(sub) : null;
  }
  return getPublicOrgByDomain(h);
}

/** Per-host sitemap: an org host lists that org's public pages; the app host lists just its root. */
export async function GET() {
  const host = (await headers()).get("host") || SITES_DOMAIN;
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const org = await orgForHost(host);

  // For an org, always advertise the CANONICAL base (the custom domain when set, else the free
  // subdomain) — never the request host — so the sitemap can't list non-canonical duplicates of the
  // pages' own rel=canonical (e.g. when the subdomain and a custom domain both serve the same site).
  const base = org ? orgPublicBaseUrl(org.settings) : `${proto}://${host}`;

  const urls: string[] = [`${base}/`];
  if (org) {
    const handle = org.settings.public_handle;
    if (handle && org.settings.estimating_mode === "catalog") urls.push(`${base}/estimate/${handle}`);
    // Articles — the index + every published post at its original path.
    const posts = await getPublicPosts(org.id);
    if (posts.length) {
      urls.push(`${base}/blog`);
      for (const p of posts) urls.push(`${base}/${p.path}`);
    }
    // Custom builder pages, each at its root-level /<slug>.
    for (const slug of await getPublicPageSlugs(org.id)) urls.push(`${base}/${slug}`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
