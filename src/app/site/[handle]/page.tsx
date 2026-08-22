import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { applySiteDoc, extractSiteDoc } from "@/lib/site-doc";
import { OrgSite, orgSiteMetadata } from "../org-site";
import { getSiteNav } from "../site-chrome";
import { handleLinkBase } from "../site-base";
import { DraftPreviewBanner, draftPreviewMetadata, getDraftSiteVersionForPreview, previewRequested } from "../draft-preview";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** An org's public homepage at /site/<handle> — the direct link + free-subdomain entry point.
 *  (A custom domain reaches the same OrgSite via ../by-domain.) */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {};
  // A preview request never advertises a canonical and never indexes — same law as page/post
  // drafts. (Applies on the preview PARAM alone, authorized or not: the safe direction.)
  if (await previewRequested(searchParams)) return draftPreviewMetadata(orgSiteMetadata(org));
  // Canonical = the org's one public base (custom domain when set, else the free subdomain) — the
  // same URL the sitemap advertises — so app-host /site/<handle> and the subdomain don't compete.
  return { ...orgSiteMetadata(org), alternates: { canonical: `${orgPublicBaseUrl(org.settings)}/` } };
}

export default async function SiteHome({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: SearchParams;
}) {
  const { handle } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  // Design-studio preview: ?preview=1&sv=<version> overlays a draft site document onto the live
  // settings for THIS render only — authorized previewers see the redesign at its real URL, the
  // public sees the live site byte-identically, preview param or not.
  const draft = await getDraftSiteVersionForPreview(org.id, searchParams);
  // Overlay, then back through the sanitize-on-read merge — PublicOrg.settings is the MERGED
  // OrgSettings shape, and the doc must ride the same healing every stored settings value does.
  const effOrg = draft
    ? { ...org, settings: getOrgSettings(applySiteDoc(org.settings, extractSiteDoc(draft.doc))) }
    : org;
  // Articles link (only when posts exist) + builder-page links, in the shape this host needs:
  // base "" → root /<slug> (the public URL); app-host base → the internal /p/<slug> route.
  const base = await handleLinkBase(handle);
  const nav = await getSiteNav(org.id, base);
  return (
    <>
      {draft && <DraftPreviewBanner />}
      <OrgSite org={effOrg} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} />
    </>
  );
}
