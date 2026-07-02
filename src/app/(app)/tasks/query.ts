import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";

const TASK_SELECT =
  "id, title, category, status, priority, due_date, focus_date, job_id, assigned_to, parent_id, tags, jobs(job_number, name), assignee:assigned_to(full_name)";

/** Done tasks stay bounded by default — history is a tap away, not a page weight. */
export const DONE_LIMIT = 30;

/**
 * One fetch for both /tasks pages: open tasks due-first (nulls last) so the
 * time sections read top-down, plus a bounded slice of recently completed
 * ones (all of them behind ?done=all). "Today" is the business's local day.
 */
export async function getTasksPageData(
  category: string | null,
  showAllDone: boolean,
  opts?: { mine?: boolean; noOffice?: boolean },
) {
  const supabase = await createClient();

  // ?mine=1 — My Day's tech door ("Everything else · N →") filters to the
  // caller's own assigned tasks so the door's number matches the page it opens.
  let mineId: string | null = null;
  if (opts?.mine) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    mineId = user?.id ?? null;
  }

  let openQ = supabase
    .from("tasks")
    .select(TASK_SELECT)
    .neq("status", "done")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("priority", { ascending: false });
  if (category) openQ = openQ.eq("category", category);
  if (mineId) openQ = openQ.eq("assigned_to", mineId);
  // ?else=1 — the staff "Everything else" door counts NON-office tasks, so the
  // page it opens must exclude office too (else the door number never matches).
  if (opts?.noOffice) openQ = openQ.neq("category", "office");

  let doneQ = supabase
    .from("tasks")
    .select(TASK_SELECT, { count: "exact" })
    .eq("status", "done")
    .order("completed_at", { ascending: false, nullsFirst: false });
  if (category) doneQ = doneQ.eq("category", category);
  if (mineId) doneQ = doneQ.eq("assigned_to", mineId);
  if (opts?.noOffice) doneQ = doneQ.neq("category", "office");
  if (!showAllDone) doneQ = doneQ.limit(DONE_LIMIT);

  const [{ data: orgRow }, openR, doneR, { data: jobs }, { data: people }] =
    await Promise.all([
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
      openQ,
      doneQ,
      supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    ]);

  // The ?mine cut filters by assignee — which drops the UNASSIGNED subtasks of a
  // tech's own tasks, leaving childless parents + a cascade confirm about invisible
  // items. Re-fetch children of the fetched top-level tasks with no assignee filter
  // and merge (deduped) so nesting renders whole.
  let extraKids: any[] = [];
  if (mineId) {
    const fetched = [...(openR.data ?? []), ...(doneR.data ?? [])] as any[];
    const seen = new Set(fetched.map((t) => t.id));
    const parentIds = fetched.filter((t) => !t.parent_id).map((t) => t.id);
    if (parentIds.length) {
      const { data: kids } = await supabase.from("tasks").select(TASK_SELECT).in("parent_id", parentIds);
      extraKids = (kids ?? []).filter((k: any) => !seen.has(k.id));
    }
  }

  const tz = getOrgSettings((orgRow as any)?.settings).timezone || "America/Los_Angeles";

  return {
    todayStr: todayStrInTz(tz),
    tasks: [...(openR.data ?? []), ...(doneR.data ?? []), ...extraKids],
    doneTotal: doneR.count ?? doneR.data?.length ?? 0,
    jobs: jobs ?? [],
    people: people ?? [],
  };
}
