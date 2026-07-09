import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByDomain } from "@/lib/public-org";
import { getPublicPageBySlug } from "@/lib/public-pages";
import { CustomPageView, customPageMetadata } from "../../../page-view";

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;

async function orgFromHost() {
  const host = (await headers()).get("host") ?? "";
  return getPublicOrgByDomain(host);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const org = await orgFromHost();
  if (!org) return {};
  const page = await getPublicPageBySlug(org.id, slug);
  return page ? customPageMetadata(org, page) : {};
}

export default async function CustomPageByDomain({ params }: { params: Params }) {
  const { slug } = await params;
  const org = await orgFromHost();
  if (!org) notFound();
  const page = await getPublicPageBySlug(org.id, slug);
  if (!page) redirect("/"); // unknown/unpublished page → the live homepage
  return <CustomPageView org={org} page={page} base="" />;
}
