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

export async function createTask(input: {
  title: string;
  category: TaskCategory;
  job_id?: string | null;
  due_date?: string | null;
  priority?: number;
  assigned_to?: string | null;
  notes?: string | null;
  parent_id?: string | null;
  tags?: string[] | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.title.trim()) return { ok: false, error: "Title is required." };

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const { error } = await supabase.from("tasks").insert({
    title: input.title.trim(),
    category: input.category,
    job_id: input.job_id || null,
    due_date: input.due_date || null,
    priority: input.priority ?? 0,
    assigned_to: input.assigned_to || null,
    notes: input.notes?.trim() || null,
    parent_id: input.parent_id || null,
    tags: tags.length ? tags : null,
    created_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidateTaskViews(input.category, input.job_id);
  return { ok: true };
}

export async function toggleTask(
  id: string,
  done: boolean,
  opts?: { category?: string | null; jobId?: string | null },
): Promise<Result> {
  const supabase = await createClient();
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
