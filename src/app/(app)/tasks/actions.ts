"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

export type TaskCategory = "sales" | "operations" | "office";

function revalidateTaskViews(category?: string | null, jobId?: string | null) {
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
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
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.title.trim()) return { ok: false, error: "Title is required." };

  const { error } = await supabase.from("tasks").insert({
    title: input.title.trim(),
    category: input.category,
    job_id: input.job_id || null,
    due_date: input.due_date || null,
    priority: input.priority ?? 0,
    assigned_to: input.assigned_to || null,
    notes: input.notes?.trim() || null,
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
    due_date?: string | null;
    priority?: number;
    assigned_to?: string | null;
    notes?: string | null;
  },
  opts?: { category?: string | null; jobId?: string | null },
): Promise<Result> {
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};
  if (patch.title !== undefined) clean.title = patch.title.trim();
  if (patch.category !== undefined) clean.category = patch.category;
  if (patch.due_date !== undefined) clean.due_date = patch.due_date || null;
  if (patch.priority !== undefined) clean.priority = patch.priority;
  if (patch.assigned_to !== undefined) clean.assigned_to = patch.assigned_to || null;
  if (patch.notes !== undefined) clean.notes = patch.notes?.trim() || null;

  const { error } = await supabase.from("tasks").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateTaskViews(opts?.category, opts?.jobId);
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
