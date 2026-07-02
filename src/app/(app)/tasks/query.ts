import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";

const TASK_SELECT =
  "id, title, category, status, priority, due_date, job_id, assigned_to, parent_id, tags, jobs(job_number, name), assignee:assigned_to(full_name)";

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
) {
  const supabase = await createClient();

  let openQ = supabase
    .from("tasks")
    .select(TASK_SELECT)
    .neq("status", "done")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("priority", { ascending: false });
  if (category) openQ = openQ.eq("category", category);

  let doneQ = supabase
    .from("tasks")
    .select(TASK_SELECT, { count: "exact" })
    .eq("status", "done")
    .order("completed_at", { ascending: false, nullsFirst: false });
  if (category) doneQ = doneQ.eq("category", category);
  if (!showAllDone) doneQ = doneQ.limit(DONE_LIMIT);

  const [{ data: orgRow }, openR, doneR, { data: jobs }, { data: people }] =
    await Promise.all([
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
      openQ,
      doneQ,
      supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    ]);

  const tz = getOrgSettings((orgRow as any)?.settings).timezone || "America/Los_Angeles";

  return {
    todayStr: todayStrInTz(tz),
    tasks: [...(openR.data ?? []), ...(doneR.data ?? [])],
    doneTotal: doneR.count ?? doneR.data?.length ?? 0,
    jobs: jobs ?? [],
    people: people ?? [],
  };
}
