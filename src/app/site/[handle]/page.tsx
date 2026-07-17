import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPosts } from "@/lib/public-posts";
import { getNavPages } from "@/lib/public-pages";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import { OrgSite, orgSiteMetadata } from "../org-site";
import { handleLinkBase } from "../site-base";

export const dynamic = "force-dynamic";

/** An org's public homepage at /site/<handle> — the direct link + free-subdomain entry point.
 *  (A custom domain reaches the same OrgSite via ../by-domain.) */
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {};
  // Canonical = the org's one public base (custom domain when set, else the free subdomain) — the
  // same URL the sitemap advertises — so app-host /site/<handle> and the subdomain don't compete.
  return { ...orgSiteMetadata(org), alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/` } };
}

export default async function SiteHome({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  // The Articles nav link appears only when the org has published posts.
  const base = await handleLinkBase(handle);
  const [posts, navPages] = await Promise.all([getPublicPosts(org.id), getNavPages(org.id)]);
  const articlesHref = posts.length ? `${base}/blog` : null;
  // On the org's own host base is "" → root /<slug> (the public URL); on the app-host preview base is
  // /site/<handle> → the internal /p/<slug> route (root slugs are an org-host-only middleware rewrite).
  const pageLinks = navPages.map((p) => ({ href: base ? `${base}/p/${p.slug}` : `/${p.slug}`, label: p.nav_label }));
  return <OrgSite org={org} articlesHref={articlesHref} pageLinks={pageLinks} />;
}
