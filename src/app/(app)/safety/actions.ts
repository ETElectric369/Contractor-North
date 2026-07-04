"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

export async function addSafetyRecord(input: {
  kind: "incident" | "toolbox";
  record_date?: string | null;
  title: string;
  profile_id?: string | null;
  job_id?: string | null;
  severity?: string | null;
  recordable?: boolean;
  description?: string | null;
  attendees?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.title?.trim()) return { ok: false, error: "Title is required." };

  const { error } = await supabase.from("safety_records").insert({
    kind: input.kind === "toolbox" ? "toolbox" : "incident",
    record_date: input.record_date || new Date().toISOString().slice(0, 10),
    title: input.title.trim(),
    profile_id: input.profile_id || null,
    job_id: input.job_id || null,
    severity: input.severity || null,
    recordable: !!input.recordable,
    description: input.description?.trim() || null,
    attendees: input.attendees?.trim() || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/safety");
  return { ok: true };
}

/** Amend an existing safety record in place — preserving created_by/created_at
 *  on what is a legal OSHA record (delete + re-add would destroy them). Mirrors
 *  addSafetyRecord's kind-aware field set. */
export async function updateSafetyRecord(
  id: string,
  patch: {
    kind: "incident" | "toolbox";
    record_date?: string | null;
    title: string;
    profile_id?: string | null;
    job_id?: string | null;
    severity?: string | null;
    recordable?: boolean;
    description?: string | null;
    attendees?: string | null;
  },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!id) return { ok: false, error: "Missing record." };
  if (!patch.title?.trim()) return { ok: false, error: "Title is required." };

  const isToolbox = patch.kind === "toolbox";
  const { error } = await supabase
    .from("safety_records")
    .update({
      record_date: patch.record_date || new Date().toISOString().slice(0, 10),
      title: patch.title.trim(),
      // Incident-only fields are cleared on a toolbox talk, and vice-versa.
      profile_id: isToolbox ? null : patch.profile_id || null,
      job_id: isToolbox ? null : patch.job_id || null,
      severity: isToolbox ? null : patch.severity || null,
      recordable: isToolbox ? false : !!patch.recordable,
      description: patch.description?.trim() || null,
      attendees: isToolbox ? patch.attendees?.trim() || null : null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/safety");
  return { ok: true };
}

export async function deleteSafetyRecord(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("safety_records").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/safety");
  return { ok: true };
}
