/**
 * THE PAGE A COUNT NAMES (0353). An app URL with every id taken out, so page_opens counts
 * "/jobs/[id]?tab=costs", never a job, a customer or a token. The same rule as bump_page_open,
 * which strips again server-side (a client is never trusted):
 *   - lower case; a path segment with a digit, or 25+ characters, is an id → "[id]";
 *   - of the query string only ?tab= survives (the job page's tabs); names and searches never do;
 *   - null for anything that isn't a plain app path (the counter then sends nothing).
 */
export function pagePattern(pathname: string | null | undefined, tab?: string | null): string | null {
  if (!pathname || pathname[0] !== "/" || pathname.length > 200) return null;
  const path = pathname
    .toLowerCase()
    .split("/")
    .map((s, i) => (i === 0 || !s ? s : /\d/.test(s) || s.length >= 25 ? "[id]" : s))
    .join("/");
  if (!/^\/[a-z0-9/_.[\]-]{0,200}$/.test(path)) return null;
  const t = typeof tab === "string" && /^[a-z0-9_-]{1,40}$/i.test(tab) ? `?tab=${tab.toLowerCase()}` : "";
  return path + t;
}
