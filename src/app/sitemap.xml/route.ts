import { headers } from "next/headers";
import { getPublicOrgByHandle, getPublicOrgByDomain } from "@/lib/public-org";
import { createServiceClient } from "@/lib/supabase/server";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import { lastmodDate, newestLastmod, urlEntry } from "./lastmod";

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

  const entries: string[] = [];
  if (org) {
    // Published rows queried here directly (not via getPublicPosts/getPublicPageSlugs) because
    // <lastmod> needs updated_at, which the render-path helpers don't carry. Same filters, order,
    // and caps as those helpers, so the URL list itself is unchanged.
    const supabase = createServiceClient();
    const [postsRes, pagesRes] = await Promise.all([
      supabase
        .from("site_posts")
        .select("path, updated_at")
        .eq("org_id", org.id)
        .eq("published", true)
        .order("published_at", { ascending: false })
        .limit(200),
      supabase
        .from("site_pages")
        .select("slug, updated_at")
        .eq("org_id", org.id)
        .eq("published", true)
        .order("nav_order", { ascending: true })
        .limit(500),
    ]);
    const posts = (postsRes.data ?? []) as { path: string; updated_at: string | null }[];
    const pages = (pagesRes.data ?? []) as { slug: string; updated_at: string | null }[];

    // The homepage changes whenever any content does — its lastmod is the newest of the lot.
    entries.push(urlEntry(`${base}/`, newestLastmod([...posts, ...pages].map((r) => r.updated_at))));
    const handle = org.settings.public_handle;
    if (handle && org.settings.estimating_mode === "catalog") entries.push(urlEntry(`${base}/estimate/${handle}`));
    // Articles — the index + every published post at its original path.
    if (posts.length) {
      entries.push(urlEntry(`${base}/blog`, newestLastmod(posts.map((p) => p.updated_at))));
      for (const p of posts) entries.push(urlEntry(`${base}/${p.path}`, lastmodDate(p.updated_at)));
    }
    // Custom builder pages, each at its root-level /<slug>.
    for (const p of pages) entries.push(urlEntry(`${base}/${p.slug}`, lastmodDate(p.updated_at)));
  } else {
    entries.push(urlEntry(`${base}/`));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
