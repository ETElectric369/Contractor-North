import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createTask, toggleTask, updateTask, deleteTask } from "@/app/(app)/tasks/actions";
import { createClient } from "@/lib/supabase/server";
import type { ActionDef } from "../types";

// BULK TRIAGE (T2): one confirmed verb sweeps MANY open tasks ("push all follow-ups to
// Monday", "clear everything about ZZ TEST") instead of N single-task calls — the chat
// caps writes per turn, so per-task calls can never triage a real list. Filter fields
// AND together; at least one is REQUIRED (superRefine) so a bare call can't match the
// whole org's list, and the handler refuses > 100 matches as a second bound.
const BULK_FILTER_FIELDS = z.object({
  title_contains: z.string().trim().min(1).optional(),
  category: z.enum(["office", "operations", "sales"]).optional(),
  job_id: z.string().optional(),
  due_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  undated_only: z.boolean().optional(),
});
type BulkFilter = z.infer<typeof BULK_FILTER_FIELDS>;

const requireFilter = (v: BulkFilter, ctx: z.RefinementCtx) => {
  if (v.title_contains || v.category || v.job_id || v.due_before || v.undated_only) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["filter"],
    message: "Give at least one filter: title_contains, category, job_id, due_before, or undated_only.",
  });
};

/** The confirm read-back names the filter in PLAIN WORDS ("every open task with
 *  'ZZ TEST' in the title") — the user must hear WHAT they're about to sweep. */
function filterWords(f: BulkFilter): string {
  const parts: string[] = [];
  if (f.title_contains) parts.push(`with "${f.title_contains}" in the title`);
  if (f.category) parts.push(`in ${f.category}`);
  if (f.job_id) parts.push("linked to that job");
  if (f.due_before) parts.push(`due before ${f.due_before}`);
  if (f.undated_only) parts.push("with no due date");
  return `every open task ${parts.join(", ")}`;
}

/** Resolve the filter to matching OPEN task ids through the caller's RLS-scoped client
 *  (org-wide for staff — the registry gates both verbs auth:"staff"). Bounded: more
 *  than 100 matches → refuse with an error, never sweep. */
async function matchOpenTasks(f: BulkFilter): Promise<{ ids: string[] } | { error: string }> {
  const supabase = await createClient();
  let q = supabase.from("tasks").select("id").eq("status", "open");
  // Escape LIKE wildcards so a title with % / _ matches literally, not as a pattern.
  if (f.title_contains) q = q.ilike("title", `%${f.title_contains.replace(/[\\%_]/g, "\\$&")}%`);
  if (f.category) q = q.eq("category", f.category);
  if (f.job_id) q = q.eq("job_id", f.job_id);
  if (f.due_before) q = q.lt("due_date", f.due_before); // NULL due dates never match — undated_only is the explicit ask
  if (f.undated_only) q = q.is("due_date", null);
  const { data, error } = await q.limit(101);
  if (error) return { error: error.message };
  if ((data?.length ?? 0) > 100)
    return { error: "That filter matches more than 100 open tasks — narrow it (add a title word, category, or job)." };
  return { ids: (data ?? []).map((t) => t.id as string) };
}

function revalidateBulkViews(f: BulkFilter) {
  revalidatePath("/tasks");
  revalidatePath("/planner"); // task sweeps change My Day
  // Category pages: the touched one when filtered, all three when the sweep spans categories.
  for (const c of f.category ? [f.category] : ["office", "operations", "sales"]) revalidatePath(`/tasks/${c}`);
  if (f.job_id) revalidatePath(`/jobs/${f.job_id}`);
}

// Seeded so the dispatch.ts inbox switchboard can migrate onto the registry next.
export const taskActions: Record<string, ActionDef> = {
  "task.create": {
    name: "task.create",
    group: "task",
    label: "Add task",
    description:
      "Create a task with a title and category (office | operations | sales). Optionally capture whatever else was given: due_date (YYYY-MM-DD), job_id (resolve with list_jobs), assigned_to (a profile id), notes.",
    // Fragment-first: createTask already takes all of these — the old 2-field schema
    // silently DROPPED a spoken due date / job / assignee / note.
    input: z.object({
      title: z.string().min(1),
      category: z.enum(["office", "operations", "sales"]).default("operations"),
      due_date: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
      assigned_to: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "any",
    effect: "write",
    handler: (i) =>
      createTask({
        title: i.title,
        category: i.category,
        due_date: i.due_date ?? null,
        job_id: i.job_id ?? null,
        assigned_to: i.assigned_to ?? null,
        notes: i.notes ?? null,
      }),
  },
  "task.complete": {
    name: "task.complete",
    group: "task",
    label: "Mark task done",
    description: "Mark a task done (set done=false to reopen it).",
    input: z.object({ id: z.string(), done: z.boolean().default(true) }),
    auth: "any",
    effect: "write",
    handler: (i) => toggleTask(i.id, i.done),
  },
  "task.setDue": {
    name: "task.setDue",
    group: "task",
    label: "Reschedule task",
    description: "Set or clear a task's due date (YYYY-MM-DD, or null to clear).",
    input: z.object({ id: z.string(), due_date: z.string().nullable() }),
    auth: "any",
    effect: "write",
    handler: (i) => updateTask(i.id, { due_date: i.due_date }),
  },
  "task.assign": {
    name: "task.assign",
    group: "task",
    label: "Assign task",
    description: "Assign a task to a person (profile id), or null to unassign.",
    input: z.object({ id: z.string(), assigned_to: z.string().nullable() }),
    auth: "any",
    effect: "write",
    handler: (i) => updateTask(i.id, { assigned_to: i.assigned_to }),
  },
  "task.delete": {
    name: "task.delete",
    group: "task",
    label: "Delete task",
    description: "Delete a task.",
    input: z.object({ id: z.string() }),
    auth: "any",
    effect: "write",
    confirm: "destructive",
    handler: (i) => deleteTask(i.id),
  },
  "task.bulkComplete": {
    name: "task.bulkComplete",
    group: "task",
    label: "Complete tasks in bulk",
    description:
      "Complete MANY open tasks in one shot by filter — 'clear everything about ZZ TEST', 'mark all the Henderson-job tasks done'. Pass at least one filter: title_contains (word/phrase in the title), category (office | operations | sales), job_id (resolve with list_jobs), due_before (YYYY-MM-DD), undated_only (true = only tasks with no due date). Filters AND together. It proposes a confirm naming the filter and refuses over 100 matches. For ONE known task use task.complete.",
    input: BULK_FILTER_FIELDS.superRefine(requireFilter),
    auth: "staff", // an org-wide sweep is an office move, not tech self-service
    effect: "write",
    confirm: "destructive", // tier-2: propose → the user hears the filter → explicit yes
    describe: (i) => `Complete ${filterWords(i)} — say yes to confirm.`,
    handler: async (i) => {
      const m = await matchOpenTasks(i);
      if ("error" in m) return { ok: false, error: m.error };
      if (!m.ids.length) return { ok: true, data: { affected: 0 }, speak: "No open tasks match that." };
      const supabase = await createClient();
      const { error } = await supabase
        .from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .in("id", m.ids);
      if (error) return { ok: false, error: error.message };
      revalidateBulkViews(i);
      return {
        ok: true,
        data: { affected: m.ids.length },
        speak: `Cleared ${m.ids.length} task${m.ids.length === 1 ? "" : "s"}.`,
      };
    },
  },
  "task.bulkReschedule": {
    name: "task.bulkReschedule",
    group: "task",
    label: "Reschedule tasks in bulk",
    description:
      "Move MANY open tasks to ONE new due date — 'push all follow-ups to Monday', 'move everything overdue to Friday'. new_due (YYYY-MM-DD) is required, plus at least one filter: title_contains, category (office | operations | sales), job_id (resolve with list_jobs), due_before (YYYY-MM-DD — overdue = due before today), undated_only (true = only tasks with no due date). Filters AND together. It proposes a confirm naming the filter and refuses over 100 matches. For ONE known task use task.setDue.",
    input: BULK_FILTER_FIELDS.extend({
      new_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    }).superRefine(requireFilter),
    auth: "staff",
    effect: "write",
    confirm: "destructive", // tier-2: propose → the user hears the filter + date → explicit yes
    describe: (i) => `Move ${filterWords(i)} to ${i.new_due} — say yes to confirm.`,
    handler: async (i) => {
      const m = await matchOpenTasks(i);
      if ("error" in m) return { ok: false, error: m.error };
      if (!m.ids.length) return { ok: true, data: { affected: 0 }, speak: "No open tasks match that." };
      const supabase = await createClient();
      const { error } = await supabase.from("tasks").update({ due_date: i.new_due }).in("id", m.ids);
      if (error) return { ok: false, error: error.message };
      revalidateBulkViews(i);
      return {
        ok: true,
        data: { affected: m.ids.length },
        speak: `Moved ${m.ids.length} task${m.ids.length === 1 ? "" : "s"} to ${i.new_due}.`,
      };
    },
  },
};
