import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { OrgSite, orgSiteMetadata } from "../org-site";

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
  return <OrgSite org={org} />;
}
