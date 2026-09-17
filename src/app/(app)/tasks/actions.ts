"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

/** Free-form since migration 0136 (was the fixed "sales" | "operations" | "office").
 *  Stored as-typed (trimmed); null = uncategorized. The legacy 'office' value keeps
 *  its My-Day meaning (Office door split, six-rank flagged-undated exclusion). */
export type TaskCategory = string;

function revalidateTaskViews(category?: string | null, jobId?: string | null) {
  revalidatePath("/tasks");
  revalidatePath("/planner");
  if (category) revalidatePath(`/tasks/${category}`);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

/**
 * THE SILENT-WRITE LAW, applied to every task write. PostgREST answers a zero-row UPDATE or
 * DELETE with a clean 204: no error, no rows. That is what RLS looks like when the row isn't
 * yours to touch, and what a stale id looks like when the row is already gone, and until now
 * every write below read it as success: the job's Tasks tab toasted "Task deleted" over a task
 * that was still there (Erik, 2026-09-16, "Can't delete tasks"). So each write now ends in
 * .select("id") and, on zero rows, this second read says which of the two it was: a row we can
 * still see but couldn't write is a permission answer; a row we can't see is gone. (Under the
 * tasks policies read and write are the same org test, so "can't see" is the honest reading.)
 */
async function zeroRowsReason(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  verb: "change" | "delete",
): Promise<string> {
  const { data } = await supabase.from("tasks").select("id").eq("id", id).maybeSingle();
  return data
    ? `You don't have permission to ${verb} that task.`
    : "Couldn't find that task. It may already be deleted. Refresh the page to see the current list.";
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
  /** Optional free-form category; blank/undefined stores null ("No category"). */
  category?: string | null;
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
  // Explicit key on purpose: blank → null (uncategorized), never the DB's
  // 'operations' default — that default exists only for paths omitting the column.
  const category = input.category?.trim() || null;
  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      title,
      category,
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
  if (error) return { ok: false, error: dbError(error) };
  revalidateTaskViews(category, input.job_id);
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
    if (kidsError) return { ok: false, error: dbError(kidsError) };
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
      const kidIds = openKids!.map((k) => k.id as string);
      const { data: cascaded, error: cascadeError } = await supabase
        .from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .in("id", kidIds)
        .select("id");
      if (cascadeError) return { ok: false, error: dbError(cascadeError) };
      if ((cascaded?.length ?? 0) < kidIds.length) {
        // Some children flipped and some didn't: show what did land, then say so.
        const missed = kidIds.length - (cascaded?.length ?? 0);
        revalidateTaskViews(opts?.category, opts?.jobId);
        return {
          ok: false,
          error: `Couldn't complete ${missed} of the ${kidIds.length} subtask${kidIds.length === 1 ? "" : "s"}. Refresh the page and try again.`,
        };
      }
    }
  }

  const { data: flipped, error } = await supabase
    .from("tasks")
    .update({
      status: done ? "done" : "open",
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!flipped?.length) return { ok: false, error: await zeroRowsReason(supabase, id, "change") };
  revalidateTaskViews(opts?.category, opts?.jobId);
  return { ok: true };
}

export async function updateTask(
  id: string,
  patch: {
    title?: string;
    /** Free-form category; blank/null clears to uncategorized. */
    category?: string | null;
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
  if (patch.category !== undefined) clean.category = patch.category?.trim() || null;
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

  const { data: changed, error } = await supabase.from("tasks").update(clean).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!changed?.length) return { ok: false, error: await zeroRowsReason(supabase, id, "change") };
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
  // A zero-row delete used to come back ok and the tab said "Task deleted" over a task that
  // was still there; see zeroRowsReason. Children go with the parent (parent_id cascades).
  const { data: gone, error } = await supabase.from("tasks").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: await zeroRowsReason(supabase, id, "delete") };
  revalidateTaskViews(opts?.category, opts?.jobId);
  return { ok: true };
}
