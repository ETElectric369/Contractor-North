import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByDomain } from "@/lib/public-org";
import { getPublicPosts, getPublicPostByPath } from "@/lib/public-posts";
import { ArticlePage, BlogIndex, articleMetadata, blogIndexMetadata } from "../../article-pages";
import {
  previewRequested,
  getDraftPostForPreview,
  draftPreviewMetadata,
  DraftPreviewBanner,
} from "../../draft-preview";

export const dynamic = "force-dynamic";

/**
 * Custom-domain content catch-all — middleware rewrites tahoedeck.com/blog-1-1/redwood here.
 * Same rendering as /site/[handle]/[...path]; the org resolves from the Host header and links
 * are root-relative (base "") because we are ON the org's own domain.
 */
type Params = Promise<{ path: string[] }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function orgFromHost() {
  const host = (await headers()).get("host") ?? "";
  return getPublicOrgByDomain(host);
}

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SearchParams }): Promise<Metadata> {
  const { path } = await params;
  const org = await orgFromHost();
  if (!org) return {};
  const pathStr = path.join("/").toLowerCase();
  if (pathStr === "blog") return blogIndexMetadata(org);
  const post = await getPublicPostByPath(org.id, pathStr);
  if (post) return articleMetadata(org, post);
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPostForPreview(org.id, pathStr);
    if (draft) return draftPreviewMetadata(articleMetadata(org, draft));
  }
  return {};
}

export default async function SiteContentByDomain({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { path } = await params;
  const org = await orgFromHost();
  if (!org) notFound();
  const pathStr = path.join("/").toLowerCase();
  if (pathStr === "blog") {
    const posts = await getPublicPosts(org.id);
    if (!posts.length) redirect("/"); // empty index → the live homepage (not a thin page)
    return <BlogIndex org={org} posts={posts} base="" />;
  }
  const post = await getPublicPostByPath(org.id, pathStr);
  if (post) return <ArticlePage org={org} post={post} base="" />;
  // Draft preview (?preview=1): the post's editor — org staff or a granted external
  // collaborator — sees the unpublished article at its real URL; everyone else falls through.
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPostForPreview(org.id, pathStr);
    if (draft) {
      return (
        <>
          <DraftPreviewBanner />
          <ArticlePage org={org} post={draft} base="" />
        </>
      );
    }
  }
  redirect("/"); // stale/unknown content URL → the live homepage (307, recoverable)
}
