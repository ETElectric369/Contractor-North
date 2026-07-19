import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import { OrgSite, orgSiteMetadata } from "../org-site";
import { getSiteNav } from "../site-chrome";
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
  // Articles link (only when posts exist) + builder-page links, in the shape this host needs:
  // base "" → root /<slug> (the public URL); app-host base → the internal /p/<slug> route.
  const base = await handleLinkBase(handle);
  const nav = await getSiteNav(org.id, base);
  return <OrgSite org={org} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} />;
}
