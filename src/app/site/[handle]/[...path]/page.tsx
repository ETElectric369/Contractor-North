import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByHandle } from "@/lib/public-org";
import { getPublicPosts, getPublicPostByPath } from "@/lib/public-posts";
import { ArticlePage, BlogIndex, articleMetadata, blogIndexMetadata } from "../../article-pages";
import { handleLinkBase } from "../../site-base";

export const dynamic = "force-dynamic";

/**
 * Org-site content catch-all: /site/<handle>/blog is the article index; any deeper path is a
 * post looked up by its FULL original path (e.g. "blog-1-1/redwood") — how a migrated site's
 * already-indexed URLs keep serving 200s. Middleware rewrites the org's own hosts here; an
 * unknown/unpublished content path TEMPORARILY redirects home (307, not 308 — so unpublishing or
 * a pre-crawl of a not-yet-created URL doesn't signal a permanent move and bleed rankings).
 */
type Params = Promise<{ handle: string; path: string[] }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { handle, path } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) return {};
  const pathStr = path.join("/").toLowerCase();
  if (pathStr === "blog") return blogIndexMetadata(org);
  const post = await getPublicPostByPath(org.id, pathStr);
  return post ? articleMetadata(org, post) : {};
}

export default async function SiteContent({ params }: { params: Params }) {
  const { handle, path } = await params;
  const org = await getPublicOrgByHandle(handle);
  if (!org) notFound();
  const base = await handleLinkBase(handle);
  const pathStr = path.join("/").toLowerCase();
  if (pathStr === "blog") {
    const posts = await getPublicPosts(org.id);
    if (!posts.length) redirect(base || "/"); // empty index → the live homepage (not a thin page)
    return <BlogIndex org={org} posts={posts} base={base} />;
  }
  const post = await getPublicPostByPath(org.id, pathStr);
  if (!post) redirect(base || "/"); // stale/unknown content URL → the live homepage (307, recoverable)
  return <ArticlePage org={org} post={post} base={base} />;
}
