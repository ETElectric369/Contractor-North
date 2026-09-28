import { reportError } from "@/lib/observe";

/**
 * BUG WATCH COUNTS ITS OWN (NY-list part, Wave 1). Bug reports leave Needs You this release (lane
 * 2), so the one count North's own team gets is on the door to them: "Bug Watch · 31" in the avatar
 * menu. It counts what the Bugs page calls open, by the Bugs page's rule — bug-list.tsx treats a
 * missing status as open (`r.status || "open"`), which action-items' `.eq("status", "open")` would
 * miss — so the number on the door is the number behind it.
 *
 * Read with the viewer's own client: bug_reports' policy lets a platform admin see every company's
 * reports (0176), which is exactly the Bugs page's list. The layout calls this only for a platform
 * admin, so nobody else pays the round trip. A failed count is no number and a line in the ops
 * sink, never a crash and never a false zero.
 */
export const OPEN_BUGS_FILTER = "status.is.null,status.eq.open";

type CountResult = PromiseLike<{ count: number | null; error: unknown }>;
type CountClient = {
  from: (table: string) => { select: (cols: string, opts: { count: "exact"; head: true }) => { or: (filter: string) => CountResult } };
};

export async function countOpenBugs(supabase: CountClient): Promise<number | null> {
  try {
    const { count, error } = await supabase.from("bug_reports").select("id", { count: "exact", head: true }).or(OPEN_BUGS_FILTER);
    if (error) throw error;
    return typeof count === "number" ? count : null;
  } catch (e) {
    reportError("app-layout:bug-count", e);
    return null;
  }
}
