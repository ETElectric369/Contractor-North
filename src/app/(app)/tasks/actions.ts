"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

export type TaskCategory = "sales" | "operations" | "office";

function revalidateTaskViews(category?: string | null, jobId?: string | null) {
  revalidatePath("/tasks");
  revalidatePath("/planner");
  if (category) revalidatePath(`/tasks/${category}`);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

export type CreateTaskResult = Result & {
  /** The row now representing this task — the EXISTING one on a duplicate hit. */
  id?: string;
  /** True when the create was collapsed onto an existing open task (nothing inserted). */
  duplicate?: boolean;
  /** Voice/toast read-back ("Already on the list: …") so the collapse is never silent. */
  speak?: string;
};

export async function createTask(input: {
  title: string;
  category: TaskCategory;
  job_id?: string | null;
  due_date?: string | null;
  priority?: number;
  assigned_to?: string | null;
  notes?: string | null;
  parent_id?: string | null;
  focus_date?: string | null;
  tags?: string[] | null;
}): Promise<CreateTaskResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Title is required." };

  // DUP-CHECK (the Nort "PUD follow-up (2nd check)" class): same trimmed title
  // (case-insensitive — ilike with wildcards escaped so it's an exact match, not a
  // pattern), still open, created in the last 48h, same org via RLS → hand back the
  // existing task instead of minting a twin. Every surface (Nort decompose, NewTaskBox,
  // capture review) funnels through here, so the backstop is server-side, not prompt-side.
  // Assignee + parent match NULL-SAFELY: crew assignment legitimately mints the same
  // title once PER PERSON, and a subtask may share a top-level task's title — only a
  // true twin collapses, never a hand-off or a child.
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  let dupQ = supabase
    .from("tasks")
    .select("id, title, created_at")
    .eq("status", "open")
    .gte("created_at", since)
    .ilike("title", title.replace(/[\\%_]/g, "\\$&"));
  dupQ = input.assigned_to ? dupQ.eq("assigned_to", input.assigned_to) : dupQ.is("assigned_to", null);
  dupQ = input.parent_id ? dupQ.eq("parent_id", input.parent_id) : dupQ.is("parent_id", null);
  // …and same JOB: a same-title task for a DIFFERENT job is real work, not a twin
  // ("inspection" on two jobs). Only same-job (or both jobless) collapses.
  dupQ = input.job_id ? dupQ.eq("job_id", input.job_id) : dupQ.is("job_id", null);
  const { data: dup } = await dupQ.limit(1).maybeSingle();
  if (dup) {
    const openedOn = new Date(dup.created_at as string).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return {
      ok: true,
      id: dup.id as string,
      duplicate: true,
      speak: `Already on the list: "${dup.title}" — open since ${openedOn}.`,
    };
  }

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      title,
      category: input.category,
      job_id: input.job_id || null,
      due_date: input.due_date || null,
      priority: input.priority ?? 0,
      assigned_to: input.assigned_to || null,
      notes: input.notes?.trim() || null,
      parent_id: input.parent_id || null,
      focus_date: input.focus_date || null,
      tags: tags.length ? tags : null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidateTaskViews(input.category, input.job_id);
  return { ok: true, id: created?.id as string | undefined };
}

export type ToggleTaskResult = Result & {
  /** Set when completing a parent with open subtasks and no cascade consent — the
   *  caller must confirm and re-call with cascade:true. Nothing was written. */
  needsCascade?: boolean;
  openChildren?: number;
};

export async function toggleTask(
  id: string,
  done: boolean,
  opts?: { category?: string | null; jobId?: string | null; cascade?: boolean },
): Promise<ToggleTaskResult> {
  const supabase = await createClient();

  // PARENT-CASCADE GUARD: children are nested everywhere (never counted, never
  // slots), so a done parent with open children would make half-done work invisible.
  // Completing a parent with open subtasks requires explicit cascade consent; with it,
  // the children complete in the same call. Never silent-strand.
  if (done) {
    const { data: openKids, error: kidsError } = await supabase
      .from("tasks")
      .select("id")
      .eq("parent_id", id)
      .eq("status", "open");
    if (kidsError) return { ok: false, error: kidsError.message };
    const openChildren = openKids?.length ?? 0;
    if (openChildren > 0) {
      if (!opts?.cascade) {
        return {
          ok: false,
          needsCascade: true,
          openChildren,
          error: `This task has ${openChildren} open subtask${openChildren === 1 ? "" : "s"} — complete them too?`,
        };
      }
      const { error: cascadeError } = await supabase
        .from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .in("id", openKids!.map((k) => k.id as string));
      if (cascadeError) return { ok: false, error: cascadeError.message };
    }
  }

  const { error } = await supabase
    .from("tasks")
    .update({
      status: done ? "done" : "open",
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateTaskViews(opts?.category, opts?.jobId);
  return { ok: true };
}

export async function updateTask(
  id: string,
  patch: {
    title?: string;
    category?: TaskCategory;
    job_id?: string | null;
    due_date?: string | null;
    priority?: number;
    assigned_to?: string | null;
    notes?: string | null;
    focus_date?: string | null;
    tags?: string[] | null;
  },
  opts?: { category?: string | null; jobId?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};
  if (patch.title !== undefined) clean.title = patch.title.trim();
  if (patch.category !== undefined) clean.category = patch.category;
  if (patch.job_id !== undefined) {
    // Persist a job link only if it's actually in the caller's org (the RLS-scoped
    // jobs read returns nothing for a foreign/crafted id) — never a cross-org id.
    let jobId: string | null = patch.job_id || null;
    if (jobId) {
      const { data: j } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
      jobId = j ? jobId : null;
    }
    clean.job_id = jobId;
  }
  if (patch.due_date !== undefined) clean.due_date = patch.due_date || null;
  if (patch.focus_date !== undefined) clean.focus_date = patch.focus_date || null;
  if (patch.priority !== undefined) clean.priority = patch.priority;
  if (patch.assigned_to !== undefined) {
    // Persist an assignee only if they're actually in the caller's org (the RLS-scoped
    // profiles read returns nothing for a foreign/crafted id) — never a cross-org id.
    let assignee: string | null = patch.assigned_to || null;
    if (assignee) {
      const { data: p } = await supabase.from("profiles").select("id").eq("id", assignee).maybeSingle();
      assignee = p ? assignee : null;
    }
    clean.assigned_to = assignee;
  }
  if (patch.notes !== undefined) clean.notes = patch.notes?.trim() || null;
  if (patch.tags !== undefined) {
    const tags = (patch.tags ?? []).map((t) => t.trim()).filter(Boolean);
    clean.tags = tags.length ? tags : null;
  }

  const { error } = await supabase.from("tasks").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateTaskViews(opts?.category, opts?.jobId);
  // If the task was re-linked to a different job, refresh that job's page too.
  const newJobId = clean.job_id as string | null | undefined;
  if (newJobId && newJobId !== opts?.jobId) revalidatePath(`/jobs/${newJobId}`);
  return { ok: true };
}

export async function deleteTask(
  id: string,
  opts?: { category?: string | null; jobId?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateTaskViews(opts?.category, opts?.jobId);
  return { ok: true };
}
