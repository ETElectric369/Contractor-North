import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPageBySlug } from "@/lib/public-pages";
import { CustomPageView, customPageMetadata } from "../../../page-view";
import { handleLinkBase } from "../../../site-base";

export const dynamic = "force-dynamic";

type Params = Promise<{ handle: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle, slug } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {};
  const page = await getPublicPageBySlug(org.id, slug);
  return page ? customPageMetadata(org, page) : {};
}

export default async function CustomPage({ params }: { params: Params }) {
  const { handle, slug } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  const base = await handleLinkBase(handle);
  const page = await getPublicPageBySlug(org.id, slug);
  if (!page) redirect(base || "/"); // unknown/unpublished page → the live homepage
  return <CustomPageView org={org} page={page} base={base} />;
}
