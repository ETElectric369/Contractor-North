import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPageBySlug } from "@/lib/public-pages";
import { CustomPageView, customPageMetadata } from "../../../page-view";
import { getSiteNav } from "../../../site-chrome";
import { handleLinkBase } from "../../../site-base";
import {
  previewRequested,
  getDraftPageForPreview,
  draftPreviewMetadata,
  DraftPreviewBanner,
} from "../../../draft-preview";

export const dynamic = "force-dynamic";

type Params = Promise<{ handle: string; slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SearchParams }): Promise<Metadata> {
  const { handle, slug } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {};
  const page = await getPublicPageBySlug(org.id, slug);
  if (page) return customPageMetadata(org, page);
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPageForPreview(org.id, slug);
    if (draft) return draftPreviewMetadata(customPageMetadata(org, draft));
  }
  return {};
}

export default async function CustomPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { handle, slug } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  const base = await handleLinkBase(handle);
  // The shared chrome's nav (Articles + builder-page links) — cache()d reads shared with the header.
  const nav = await getSiteNav(org.id, base);
  const page = await getPublicPageBySlug(org.id, slug);
  if (page) return <CustomPageView org={org} page={page} base={base} nav={nav} />;
  // Draft preview (?preview=1): the page's editor — org staff or a granted external
  // collaborator — sees the unpublished page at its real URL; everyone else falls through.
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPageForPreview(org.id, slug);
    if (draft) {
      return (
        <>
          <DraftPreviewBanner />
          <CustomPageView org={org} page={draft} base={base} nav={nav} />
        </>
      );
    }
  }
  redirect(base || "/"); // unknown/unpublished page → the live homepage
}
