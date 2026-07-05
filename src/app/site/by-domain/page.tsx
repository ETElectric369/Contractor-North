import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicOrgByDomain } from "@/lib/public-org";
import { OrgSite, orgSiteMetadata } from "../org-site";

export const dynamic = "force-dynamic";

/**
 * The custom-domain entry point. Middleware rewrites the ROOT of any custom domain pointed at us
 * to /site/by-domain (transparently — the customer's address bar keeps the custom domain). Here
 * we read the Host header and resolve the org by its settings.custom_domain, then render the same
 * OrgSite. Adding a new org's domain is now a data change (set custom_domain + point DNS), no code.
 */
async function orgFromHost() {
  const host = (await headers()).get("host") ?? "";
  return getPublicOrgByDomain(host);
}

export async function generateMetadata(): Promise<Metadata> {
  const org = await orgFromHost();
  return org ? orgSiteMetadata(org) : {};
}

export default async function SiteByDomain() {
  const org = await orgFromHost();
  if (!org) notFound();
  return <OrgSite org={org} />;
}
