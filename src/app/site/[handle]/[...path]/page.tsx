import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPosts, getPublicPostByPath } from "@/lib/public-posts";
import { ArticlePage, BlogIndex, articleMetadata, blogIndexMetadata } from "../../article-pages";
import { getSiteNav } from "../../site-chrome";
import { handleLinkBase } from "../../site-base";
import {
  previewRequested,
  getDraftPostForPreview,
  draftPreviewMetadata,
  DraftPreviewBanner,
} from "../../draft-preview";

export const dynamic = "force-dynamic";

/**
 * Org-site content catch-all: /site/<handle>/blog is the article index; any deeper path is a
 * post looked up by its FULL original path (e.g. "blog-1-1/redwood") — how a migrated site's
 * already-indexed URLs keep serving 200s. Middleware rewrites the org's own hosts here; an
 * unknown/unpublished content path TEMPORARILY redirects home (307, not 308 — so unpublishing or
 * a pre-crawl of a not-yet-created URL doesn't signal a permanent move and bleed rankings).
 * Exception: ?preview=1 lets the post's own editor (staff/granted collaborator) see a draft.
 */
type Params = Promise<{ handle: string; path: string[] }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SearchParams }): Promise<Metadata> {
  const { handle, path } = await params;
  const org = await getPublicOrgByHandle(handle);
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

export default async function SiteContent({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { handle, path } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  const base = await handleLinkBase(handle);
  // The shared chrome's nav (Articles + builder-page links) — cache()d reads, no extra queries
  // beyond what the header needs.
  const nav = await getSiteNav(org.id, base);
  const pathStr = path.join("/").toLowerCase();
  if (pathStr === "blog") {
    const posts = await getPublicPosts(org.id);
    if (!posts.length) redirect(base || "/"); // empty index → the live homepage (not a thin page)
    return <BlogIndex org={org} posts={posts} base={base} nav={nav} />;
  }
  const post = await getPublicPostByPath(org.id, pathStr);
  if (post) return <ArticlePage org={org} post={post} base={base} nav={nav} />;
  // Draft preview (?preview=1): the post's editor — org staff or a granted external
  // collaborator — sees the unpublished article at its real URL; everyone else falls through.
  if (await previewRequested(searchParams)) {
    const draft = await getDraftPostForPreview(org.id, pathStr);
    if (draft) {
      return (
        <>
          <DraftPreviewBanner />
          <ArticlePage org={org} post={draft} base={base} nav={nav} />
        </>
      );
    }
  }
  redirect(base || "/"); // stale/unknown content URL → the live homepage (307, recoverable)
}
