import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPublicOrgByDomain } from "@/lib/public-org";
import { getPublicPosts, getPublicPostByPath } from "@/lib/public-posts";
import { ArticlePage, BlogIndex, articleMetadata, blogIndexMetadata } from "../../article-pages";

export const dynamic = "force-dynamic";

/**
 * Custom-domain content catch-all — middleware rewrites tahoedeck.com/blog-1-1/redwood here.
 * Same rendering as /site/[handle]/[...path]; the org resolves from the Host header and links
 * are root-relative (base "") because we are ON the org's own domain.
 */
type Params = Promise<{ path: string[] }>;

async function orgFromHost() {
  const host = (await headers()).get("host") ?? "";
  return getPublicOrgByDomain(host);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { path } = await params;
  const org = await orgFromHost();
  if (!org) return {};
  const pathStr = path.join("/").toLowerCase();
  if (pathStr === "blog") return blogIndexMetadata(org);
  const post = await getPublicPostByPath(org.id, pathStr);
  return post ? articleMetadata(org, post) : {};
}

export default async function SiteContentByDomain({ params }: { params: Params }) {
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
  if (!post) redirect("/"); // stale/unknown content URL → the live homepage (307, recoverable)
  return <ArticlePage org={org} post={post} base="" />;
}
