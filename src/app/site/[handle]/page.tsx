import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPosts } from "@/lib/public-posts";
import { OrgSite, orgSiteMetadata } from "../org-site";
import { handleLinkBase } from "../site-base";

export const dynamic = "force-dynamic";

/** An org's public homepage at /site/<handle> — the direct link + free-subdomain entry point.
 *  (A custom domain reaches the same OrgSite via ../by-domain.) */
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  return org ? orgSiteMetadata(org) : {};
}

export default async function SiteHome({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  // The Articles nav link appears only when the org has published posts.
  const posts = await getPublicPosts(org.id);
  const articlesHref = posts.length ? `${await handleLinkBase(handle)}/blog` : null;
  return <OrgSite org={org} articlesHref={articlesHref} />;
}
