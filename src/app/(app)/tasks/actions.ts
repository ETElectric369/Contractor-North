"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { isMissingColumn } from "@/lib/job-tasks";

export type Result = { ok: boolean; error?: string };

/** Free-form since migration 0136 (was the fixed "sales" | "operations" | "office").
 *  Stored as-typed (trimmed); null = uncategorized. The legacy 'office' value keeps
 *  its My-Day meaning (Office door split, six-rank flagged-undated exclusion). */
export type TaskCategory = string;

// The Reminders page (/tasks), My Day, and the job whose list changed. (The /tasks/<category> pages
// are gone: /tasks is the one Reminders page now, 0358.)
function revalidateTaskViews(_category?: string | null, jobId?: string | null) {
  revalidatePath("/tasks");
  revalidatePath("/planner");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

/** A JOB'S TASK BELONGS TO THE JOB (Erik, 2026-09-26: "a crew leader can assign them verbally").
 *  Said, never silently dropped, wherever a name meets a job. */
const JOB_TASK_HAS_NO_ASSIGNEE =
  "A job's task belongs to the job, not one person: the crew lead hands it out. Leave the name off, or make it a Reminder for them with no job.";

/** 0358's delete rule, in words, for the tap that crossed it. */
const TASK_DELETE_RULE = "Only the office or whoever added this task can delete it. You can still check it off.";

/** A storage path a task may carry: a company folder first ({org}/…), nothing climbing out. The
 *  database checks it is THIS company's folder (0358's task_photo_path_ok); this checks the shape. */
function photoPathShapeOk(p: string): boolean {
  return /^[0-9a-f-]{36}\/[^/]/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p);
}
const PHOTO_NOT_OURS = "That photo isn't in this company's job files, so it can't go on the task.";

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
  if (data) return verb === "delete" ? TASK_DELETE_RULE : "You don't have permission to change that task.";
  return "Couldn't find that task. It may already be deleted. Refresh the page to see the current list.";
}

export type CreateTaskResult = Result & {
  /** The row now representing this task — the EXISTING one on a duplicate hit. */
  id?: string;
  /** True when the create was collapsed onto an existing open task (nothing inserted). */
  duplicate?: boolean;
  /** Voice/toast read-back ("Already on the list: …") so the collapse is never silent. */
  speak?: string;
  /** The task saved but its photo couldn't be put on it (a database without 0358): the photo is on
   *  the job's Photos tab, and the caller says so. */
  photoSkipped?: boolean;
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
  /** A job task made from a photo: the photo's storage path (documents bucket, this company's). */
  photo_path?: string | null;
}): Promise<CreateTaskResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Title is required." };
  if (input.job_id && input.assigned_to) return { ok: false, error: JOB_TASK_HAS_NO_ASSIGNEE };
  const photoPath = input.photo_path?.trim() || null;
  if (photoPath && !input.job_id) return { ok: false, error: "A photo goes on a job's task. Pick the job first." };
  if (photoPath && !photoPathShapeOk(photoPath)) return { ok: false, error: PHOTO_NOT_OURS };

  // A JOB TASK NAMES ONE OF THIS COMPANY'S JOBS. 0358 makes the database say it too; this says it on
  // a database without 0358, where the policy only checked the company (the RLS-scoped jobs read
  // returns nothing for another company's id or a stray one).
  if (input.job_id) {
    const { data: j } = await supabase.from("jobs").select("id").eq("id", input.job_id).maybeSingle();
    if (!j) return { ok: false, error: "That job isn't available. Refresh and pick it again." };
  }
  // A STEP LIVES WHERE ITS TASK LIVES: a step of a job's task is on that job (so the crew sees it),
  // a step of a Reminder is private with it. Unless the caller named the job itself.
  let jobId: string | null = input.job_id || null;
  if (input.parent_id && !jobId) {
    const { data: parent } = await supabase.from("tasks").select("job_id").eq("id", input.parent_id).maybeSingle();
    if (!parent) return { ok: false, error: "Couldn't find the task this step goes under. Refresh and try again." };
    jobId = (parent.job_id as string | null) ?? null;
  }

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
  dupQ = jobId ? dupQ.eq("job_id", jobId) : dupQ.is("job_id", null);
  // A REMINDER ONLY COLLAPSES ONTO ONE THE CALLER CAN SEE (0358: private to its maker and its
  // person). 0358's read says it; this says it on a database without 0358, where the read was
  // company-wide and a teammate's same-title Reminder answered "Already on the list" and saved nothing.
  if (!jobId) dupQ = dupQ.or(`created_by.eq.${user.id},assigned_to.eq.${user.id}`);
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
  // created_by is the server's since 0358 (stamp_task_who stamps auth.uid()); sent anyway so a
  // database without 0358 records the same person.
  const row: Record<string, unknown> = {
    title,
    category,
    job_id: jobId,
    due_date: input.due_date || null,
    priority: input.priority ?? 0,
    assigned_to: input.assigned_to || null,
    notes: input.notes?.trim() || null,
    parent_id: input.parent_id || null,
    focus_date: input.focus_date || null,
    tags: tags.length ? tags : null,
    created_by: user.id,
  };
  if (photoPath) row.photo_path = photoPath;
  let { data: created, error } = await supabase.from("tasks").insert(row).select("id").single();
  // BEFORE 0358 there is no photo column: the task still saves, without the photo, and the caller
  // says the photo is on the job's Photos tab. Never a lost task over a missing column.
  let photoSkipped = false;
  if (error && photoPath && isMissingColumn(error)) {
    delete row.photo_path;
    ({ data: created, error } = await supabase.from("tasks").insert(row).select("id").single());
    photoSkipped = !error;
  }
  if (error) return { ok: false, error: dbError(error) };
  revalidateTaskViews(category, jobId);
  return { ok: true, id: created?.id as string | undefined, ...(photoSkipped ? { photoSkipped } : {}) };
}

export type ToggleTaskResult = Result & {
  /** Set when completing a parent with open subtasks and no cascade consent — the
   *  caller must confirm and re-call with cascade:true. Nothing was written. */
  needsCascade?: boolean;
  openChildren?: number;
  /** A cascaded check-off: the steps THIS call closed with the task — exactly the ones it flipped
   *  from open, never one that was already done. Its Undo hands them back as reopenSteps. */
  closedSteps?: string[];
  /** An Undo's reopenSteps: how many came back open, and how many are still checked off (this
   *  caller couldn't reopen them). A step deleted or reopened meanwhile counts in neither. */
  reopenedSteps?: number;
  stepsStillDone?: number;
};

/** Of these tasks, how many are still in this status: a short write's second read (the silent-write
 *  law: fewer rows back is either "not ours to change" or "already so"). A failed read counts every
 *  one, so a shortfall is said rather than guessed away. */
async function countStill(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
  status: "open" | "done",
): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await supabase.from("tasks").select("id").in("id", ids).eq("status", status);
  return error ? ids.length : (data?.length ?? 0);
}

export async function toggleTask(
  id: string,
  done: boolean,
  opts?: {
    category?: string | null;
    jobId?: string | null;
    cascade?: boolean;
    /** Undo of a cascaded check-off (done:false): the closedSteps it answered with. Reopened with the
     *  task, and only while they are still this task's steps and still done. */
    reopenSteps?: string[];
  },
): Promise<ToggleTaskResult> {
  const supabase = await createClient();
  let closedSteps: string[] = [];

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
        // Only the ones still open: the rows back are exactly the steps this check-off closed, so
        // its Undo reopens those and never one a teammate checked off in the same moment.
        .eq("status", "open")
        .select("id");
      if (cascadeError) return { ok: false, error: dbError(cascadeError) };
      closedSteps = (cascaded ?? []).map((k) => k.id as string);
      if (closedSteps.length < kidIds.length) {
        // Short. A step someone else checked off meanwhile is done either way; one still open is one
        // this call couldn't close: show what did land, then say so.
        const missed = await countStill(supabase, kidIds.filter((k) => !closedSteps.includes(k)), "open");
        if (missed > 0) {
          revalidateTaskViews(opts?.category, opts?.jobId);
          return {
            ok: false,
            error: `Couldn't complete ${missed} of the ${kidIds.length} subtask${kidIds.length === 1 ? "" : "s"}. Refresh the page and try again.`,
          };
        }
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

  // UNDO OF A CASCADED CHECK-OFF: the task is open again, so now exactly the steps its check-off
  // closed (handed back from closedSteps), only while they are still this task's and still done.
  // After the task, never before: open steps under a done task are the half-done work the cascade
  // guard above exists to prevent.
  const back = done ? [] : [...new Set(opts?.reopenSteps ?? [])];
  let reopened: Pick<ToggleTaskResult, "reopenedSteps" | "stepsStillDone"> = {};
  if (back.length) {
    const { data: again, error: againError } = await supabase
      .from("tasks")
      .update({ status: "open", completed_at: null })
      .in("id", back)
      .eq("parent_id", id)
      .eq("status", "done")
      .select("id");
    const got = againError ? [] : (again ?? []).map((k) => k.id as string);
    reopened = { reopenedSteps: got.length, stepsStillDone: await countStill(supabase, back.filter((k) => !got.includes(k)), "done") };
  }

  revalidateTaskViews(opts?.category, opts?.jobId);
  return { ok: true, ...(closedSteps.length ? { closedSteps } : {}), ...reopened };
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
  if (patch.assigned_to) {
    // A job's task has no assignee (0358): refused in words, never stored beside the job.
    const { data: cur } = await supabase.from("tasks").select("job_id").eq("id", id).maybeSingle();
    const landsOnJob = patch.job_id !== undefined ? !!clean.job_id : !!cur?.job_id;
    if (landsOnJob) return { ok: false, error: JOB_TASK_HAS_NO_ASSIGNEE };
  }
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  // THE DELETE RULE (Erik, 2026-09-26): a job's task is deleted by the office or whoever added it; a
  // tech checks an office task off, never deletes it. 0358's tasks_delete policy is the boundary;
  // this says it first, and holds on a database without 0358.
  const { data: row } = await supabase.from("tasks").select("id, job_id, created_by").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: await zeroRowsReason(supabase, id, "delete") };
  if (row.job_id && row.created_by !== user.id) {
    const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (!isStaffRole((me as { role?: string } | null)?.role ?? "")) return { ok: false, error: TASK_DELETE_RULE };
  }
  // A zero-row delete used to come back ok and the tab said "Task deleted" over a task that
  // was still there; see zeroRowsReason. Children go with the parent (parent_id cascades).
  const { data: gone, error } = await supabase.from("tasks").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: await zeroRowsReason(supabase, id, "delete") };
  revalidateTaskViews(opts?.category, opts?.jobId);
  return { ok: true };
}

/**
 * THE PHOTO OF THE FINISHED WORK (optional and quiet: Erik wanted photos that BECOME tasks; a done
 * photo is never required). The file is already a job photo (uploadJobPhotos); this puts its path on
 * the checked-off task. Only on a done task, and reopening one clears it (0358). Before 0358 there is
 * no such column, and the sentence says the photo is on the Photos tab.
 */
export async function setTaskDonePhoto(id: string, path: string, opts?: { jobId?: string | null }): Promise<Result> {
  const supabase = await createClient();
  const p = String(path ?? "").trim();
  if (!p || !photoPathShapeOk(p)) return { ok: false, error: PHOTO_NOT_OURS };
  const { data: hit, error } = await supabase
    .from("tasks")
    .update({ done_photo_path: p })
    .eq("id", id)
    .eq("status", "done")
    .select("id");
  if (error) {
    if (isMissingColumn(error)) {
      return { ok: false, error: "The photo is on the job's Photos tab. Photos on tasks start after the next database update." };
    }
    return { ok: false, error: dbError(error) };
  }
  if (!hit?.length) {
    const { data: t } = await supabase.from("tasks").select("status").eq("id", id).maybeSingle();
    if (!t) return { ok: false, error: "Couldn't find that task. It may already be deleted. Refresh the page to see the current list." };
    return {
      ok: false,
      error:
        t.status !== "done"
          ? "That task isn't checked off any more, so the photo stays on the Photos tab."
          : "You don't have permission to change that task.",
    };
  }
  revalidateTaskViews(null, opts?.jobId);
  return { ok: true };
}
