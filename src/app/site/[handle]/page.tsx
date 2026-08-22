import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { applySiteDoc, extractSiteDoc } from "@/lib/site-doc";
import { OrgSite, orgSiteMetadata } from "../org-site";
import { getSiteNav } from "../site-chrome";
import { handleLinkBase } from "../site-base";
import { canEditSiteLive, DraftPreviewBanner, canPreviewSiteDrafts, draftPreviewMetadata, getDraftSiteVersionForPreview, previewRequested } from "../draft-preview";
import { LiveEditor } from "../live-editor";

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
  const sp = await searchParams;
  const liveEdit = !!draft && sp?.edit === "1" && (await canEditSiteLive(org.id));
  // "View live" inside the desktop app swallows target=_blank and strands the owner on the
  // site with no way back (Erik: "i got this with no way out"). Anyone authorized to preview
  // drafts gets a small fixed escape chip on the APP-HOST view; the public (and the custom
  // domain, which uses the by-domain route) never sees it.
  // Chip gates: never inside the studio's own preview iframe (?preview=1 — clicking it there
  // would nest the whole app in the 75vh pane), and only on the APP HOST (base !== "" — the
  // free-subdomain public homepage is not an app surface).
  const showBackChip = !liveEdit && base !== "" && !(await previewRequested(searchParams)) && (await canPreviewSiteDrafts(org.id));
  return (
    <>
      {showBackChip && (
        <a
          href="/site-studio"
          className="fixed bottom-4 left-4 z-50 rounded-full bg-slate-900/90 px-3.5 py-2 text-sm font-semibold text-white shadow-lg backdrop-blur hover:bg-slate-800"
        >
          ← Back to North
        </a>
      )}
      {draft && !liveEdit && <DraftPreviewBanner />}
      {/* The on-page editor: only inside an AUTHORIZED draft preview (draft is null for anyone
          who fails the internal gate), and the save action re-checks staff + draft anyway. */}
      {liveEdit && (
        <LiveEditor
          versionId={draft.id}
          initial={{
            splash_headline_size: effOrg.settings.splash_headline_size,
            hero_align: effOrg.settings.hero_align,
            hero_style: effOrg.settings.hero_style,
            site_font: effOrg.settings.site_font,
            brand_font: effOrg.settings.brand_font,
            hero_dx: effOrg.settings.hero_dx,
            hero_dy: effOrg.settings.hero_dy,
            hero_w: effOrg.settings.hero_w,
            hero_scale: effOrg.settings.hero_scale,
            splash_headline_color: effOrg.settings.splash_headline_color,
            splash_tagline_color: effOrg.settings.splash_tagline_color,
            service_area_color: effOrg.settings.service_area_color,
            spread_area_scale: effOrg.settings.spread_area_scale,
            spread_head_scale: effOrg.settings.spread_head_scale,
            spread_tag_scale: effOrg.settings.spread_tag_scale,
            spread_area_dx: effOrg.settings.spread_area_dx,
            spread_area_dy: effOrg.settings.spread_area_dy,
            spread_head_dx: effOrg.settings.spread_head_dx,
            spread_head_dy: effOrg.settings.spread_head_dy,
            spread_head_w: effOrg.settings.spread_head_w,
            spread_tag_dx: effOrg.settings.spread_tag_dx,
            spread_tag_dy: effOrg.settings.spread_tag_dy,
            spread_tag_w: effOrg.settings.spread_tag_w,
          }}
        />
      )}
      <OrgSite org={effOrg} articlesHref={nav.articlesHref} pageLinks={nav.pageLinks} appHost={base !== ""} />
    </>
  );
}
