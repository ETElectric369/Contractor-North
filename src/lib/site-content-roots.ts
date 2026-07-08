/**
 * The URL roots an org-site article can live under — the SINGLE source shared by the middleware
 * (which rewrites these paths into the article engine on org hosts) and saveSitePost (which must
 * refuse to save a post at a path that middleware won't route). Keeping them in lockstep prevents
 * the "post saved but its URL dead-ends at login/301-home while the sitemap advertises it" trap.
 *
 * "blog" = new posts (blog/<slug>). "blog-1-1" = Squarespace's blog collection prefix, so a
 * migrated Squarespace site's already-indexed post URLs (e.g. blog-1-1/redwood) keep working.
 * Adding another CMS's collection slug here (+ nothing else) extends support to that migration.
 */
export const CONTENT_ROOTS = ["blog", "blog-1-1"] as const;

/** Is `path` (no leading slash) a valid article path — under a known content root? */
export function isValidPostPath(path: string): boolean {
  const p = String(path || "").toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(p)) return false;
  // Must be root/<something> — a bare root ("blog") is the index, not a post.
  return CONTENT_ROOTS.some((root) => p.startsWith(`${root}/`) && p.length > root.length + 1);
}
