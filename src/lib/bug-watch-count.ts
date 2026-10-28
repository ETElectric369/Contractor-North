import { reportError } from "@/lib/observe";

/**
 * BUG WATCH COUNTS ITS OWN (NY-list part, Wave 1). Bug reports leave Needs You this release (lane
 * 2), so the one count North's own team gets is on the door to them: "Bug Watch · N" in the avatar
 * menu. Since cn-v1136 the error sink is triaged on the same page, so the N is the OPEN reports plus
 * the NEW errors — one number for the one door, the sum of two exact head counts.
 *
 * The reports are counted by the Bugs page's rule — bug-list.tsx treats a missing status as open
 * (`r.status || "open"`), which action-items' `.eq("status", "open")` would miss — so the number on
 * the door is the number behind it. An error counts while it is NEW and is not a trace: a triaged
 * one is already in hand, a fixed or ignored one is closed, and a trace is a footprint, not work.
 * Badges count only what is OPEN (Erik's law).
 *
 * Read with the viewer's own client: bug_reports' policy lets a platform admin see every company's
 * reports (0176), and error_events' lets the same admin see every row (0399) — exactly the Bugs
 * page's two lists. The layout calls this only for a platform admin, so nobody else pays the round
 * trips. Either count failing is no number and a line in the ops sink — never a crash, never a false
 * zero, and never a half number that counts one list and not the other.
 */
export const OPEN_BUGS_FILTER = "status.is.null,status.eq.open";
/** The sink's open rule, as the two PostgREST filters the chain applies: status = new AND level <> trace. */
export const NEW_ERRORS_FILTERS = [
  ["status", "eq", "new"],
  ["level", "neq", "trace"],
] as const;

type CountResult = PromiseLike<{ count: number | null; error: unknown }>;
/**
 * The two chains this file asks for, and no more. The second goes through the builder's generic
 * `filter(column, operator, value)` door rather than `.eq().neq()`: the real client's eq and neq carry
 * ResolveFilterValue<Schema, Row, ColumnName> in their value type, and checking the layout's untyped
 * client against ANY shape that names them is "excessively deep and possibly infinite" (TS2589);
 * filter's plain overload is not. Same SQL, operators spelled out.
 */
type CountQuery = {
  or(filter: string): CountResult;
  filter(column: string, operator: string, value: string): { filter(column: string, operator: string, value: string): CountResult };
};
type CountClient = {
  from: (table: string) => { select: (cols: string, opts: { count: "exact"; head: true }) => CountQuery };
};

/** One exact head count's number, or a throw: a refusal, and a count that did not come back, are
 *  both failures of the sum — never a zero in its place. */
async function headCount(q: CountResult): Promise<number> {
  const { count, error } = await q;
  if (error) throw error;
  if (typeof count !== "number") throw new Error("the head count came back without a number");
  return count;
}

export async function countOpenBugs(supabase: CountClient): Promise<number | null> {
  try {
    const [reports, errors] = await Promise.all([
      headCount(supabase.from("bug_reports").select("id", { count: "exact", head: true }).or(OPEN_BUGS_FILTER)),
      headCount(
        supabase
          .from("error_events")
          .select("id", { count: "exact", head: true })
          .filter(...NEW_ERRORS_FILTERS[0])
          .filter(...NEW_ERRORS_FILTERS[1]),
      ),
    ]);
    return reports + errors;
  } catch (e) {
    reportError("app-layout:bug-count", e);
    return null;
  }
}
