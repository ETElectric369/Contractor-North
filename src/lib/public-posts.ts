import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Public reads for the org-site articles (site_posts) — the content layer of the site platform.
 * Service client, published-only, always scoped to ONE org id resolved upstream by
 * getPublicOrgByHandle/ByDomain (never by caller input), so no cross-org read is expressible.
 * Posts are keyed by their full URL path minus the leading slash (e.g. "blog-1-1/redwood"), so
 * a migrated site's already-indexed URLs keep serving 200s with the same content.
 */
export type PublicPost = {
  id: string;
  path: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  body_html: string;
  published_at: string;
};

const SELECT = "id, path, title, description, cover_url, body_html, published_at";

export const getPublicPosts = cache(async (orgId: string): Promise<PublicPost[]> => {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_posts")
    .select("id, path, title, description, cover_url, published_at") // index list never needs bodies
    .eq("org_id", orgId)
    .eq("published", true)
    .order("published_at", { ascending: false })
    .limit(200);
  return ((data ?? []) as PublicPost[]).map((p) => ({ ...p, body_html: "" }));
});

export const getPublicPostByPath = cache(async (orgId: string, path: string): Promise<PublicPost | null> => {
  const clean = String(path || "").toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("site_posts")
    .select(SELECT)
    .eq("org_id", orgId)
    .eq("published", true)
    .eq("path", clean)
    .limit(1)
    .maybeSingle();
  return (data as PublicPost) ?? null;
});
