import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByDomain } from "@/lib/public-org";
import { getPublicPageBySlug } from "@/lib/public-pages";
import { CustomPageView, customPageMetadata } from "../../../page-view";
import { getSiteNav } from "../../../site-chrome";
import {
  previewRequested,
  getDraftPageForPreview,
  draftPreviewMetadata,
  DraftPreviewBanner,
} from "../../../draft-preview";

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function orgFromHost() {
  const host = (await headers()).get("host") ?? "";
  return getPublicOrgByDomain(host);
}

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SearchParams }): Promise<Metadata> {
  const { slug } = await params;
  const org = await orgFromHost();
  if (!org) return {};
  const page = await getPublicPageBySlug(org.id, slug);
  if (page) return customPageMetadata(org, page);
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPageForPreview(org.id, slug);
    if (draft) return draftPreviewMetadata(customPageMetadata(org, draft));
  }
  return {};
}

export default async function CustomPageByDomain({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { slug } = await params;
  const org = await orgFromHost();
  if (!org) notFound();
  // The shared chrome's nav (Articles + builder-page links), root-relative on the org's own domain.
  const nav = await getSiteNav(org.id, "");
  const page = await getPublicPageBySlug(org.id, slug);
  if (page) return <CustomPageView org={org} page={page} base="" nav={nav} />;
  // Draft preview (?preview=1): the page's editor — org staff or a granted external
  // collaborator — sees the unpublished page at its real URL; everyone else falls through.
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPageForPreview(org.id, slug);
    if (draft) {
      return (
        <>
          <DraftPreviewBanner />
          <CustomPageView org={org} page={draft} base="" nav={nav} />
        </>
      );
    }
  }
  redirect("/"); // unknown/unpublished page → the live homepage
}
