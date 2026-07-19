import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicOrgByDomain } from "@/lib/public-org";
import { orgPublicBaseUrl } from "@/lib/org-settings";
import { OrgSite, orgSiteMetadata } from "../org-site";
import { getSiteNav } from "../site-chrome";

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
  if (!org) return {};
  // Canonical = the org's one public base (custom domain when set, else the free subdomain) — the
  // same URL the sitemap advertises — so www/apex variants of the domain don't compete.
  return { ...orgSiteMetadata(org), alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/` } };
}

export default async function SiteByDomain() {
  const org = await orgFromHost();
  if (!org) notFound();
  // On the org's own domain, article + page links live at the root (/blog, /<slug>).
  const nav = await getSiteNav(org.id, "");
  return <OrgSite org={org} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} />;
}
