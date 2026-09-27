import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { listActiveTechs } from "@/lib/schedule-options";
import { todayStrInTz } from "@/lib/tz";
import { isStaffRole } from "@/lib/actions/perms";

const TASK_SELECT =
  "id, title, category, status, priority, due_date, focus_date, job_id, assigned_to, created_by, parent_id, tags, assignee:assigned_to(full_name)";

/** Done tasks stay bounded by default — history is a tap away, not a page weight. */
export const DONE_LIMIT = 30;

/**
 * THE REMINDERS PAGE'S ONE FETCH (0358). A Reminder is a task with NO job, and it is private: the
 * viewer sees the ones they made and the ones made for them (plus, for the office, a legacy one with
 * neither, so it can still be cleared) — exactly 0358's tasks_read, said here too so the page is
 * private on a database without it. Job tasks never come here: they are the job's list.
 *
 * Open reminders due-first (nulls last) so the time sections read top-down, plus a bounded slice of
 * recently completed ones (all of them behind ?done=all). "Today" is the business's local day.
 */
export async function getTasksPageData(showAllDone: boolean) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const uid = user?.id ?? "";
  const { data: me } = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
  const staff = isStaffRole((me as { role?: string } | null)?.role ?? "");
  const mine = `created_by.eq.${uid},assigned_to.eq.${uid}${staff ? ",and(created_by.is.null,assigned_to.is.null)" : ""}`;

  const openQ = supabase
    .from("tasks")
    .select(TASK_SELECT)
    .is("job_id", null)
    .or(mine)
    .neq("status", "done")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("priority", { ascending: false });

  let doneQ = supabase
    .from("tasks")
    .select(TASK_SELECT, { count: "exact" })
    .is("job_id", null)
    .or(mine)
    .eq("status", "done")
    .order("completed_at", { ascending: false, nullsFirst: false });
  if (!showAllDone) doneQ = doneQ.limit(DONE_LIMIT);

  // A REMINDER'S STEPS FOLLOW IT (0358's task_parent_is_mine): a step the other person on the
  // Reminder added is theirs to see too, so the steps are read beside the page's Reminders and kept
  // only under one this page shows (on a database without 0358 the read is company-wide; the cut
  // below keeps the page private all the same).
  const stepsQ = supabase
    .from("tasks")
    .select(TASK_SELECT)
    .is("job_id", null)
    .not("parent_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1000);

  const [{ data: orgRow }, openR, doneR, stepsR, { data: people }, { data: catRows }] = await Promise.all([
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    openQ,
    doneQ,
    stepsQ,
    listActiveTechs(supabase),
    // The viewer's OWN reminder vocabulary (free-form since 0136) — feeds the edit autocomplete and
    // the by-category pills. Recent-first slice, deduped below; no invented taxonomy.
    supabase
      .from("tasks")
      .select("category")
      .is("job_id", null)
      .or(mine)
      .not("category", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  const tz = getOrgSettings((orgRow as any)?.settings).timezone || "America/Los_Angeles";

  // Dedupe case-insensitively but keep the casing actually typed (first hit wins = most recent).
  const seen = new Map<string, string>();
  for (const r of (catRows ?? []) as { category: string | null }[]) {
    const raw = (r.category ?? "").trim();
    if (raw && !seen.has(raw.toLowerCase())) seen.set(raw.toLowerCase(), raw);
  }
  const categories = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));

  const mineRows = [...(openR.data ?? []), ...(doneR.data ?? [])];
  const shown = new Set(mineRows.map((t) => t.id as string));
  const steps = (stepsR.data ?? []).filter(
    (s) => !shown.has(s.id as string) && !!s.parent_id && shown.has(s.parent_id as string),
  );

  return {
    todayStr: todayStrInTz(tz),
    /** Who is looking: only a Reminder's maker hands it to someone else (0358's tasks_update). */
    viewerId: uid || null,
    tasks: [...mineRows, ...steps],
    doneTotal: doneR.count ?? doneR.data?.length ?? 0,
    people: people ?? [],
    categories,
  };
}
