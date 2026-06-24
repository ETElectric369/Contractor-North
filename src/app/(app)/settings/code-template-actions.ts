"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

/** Create or update a job-code template (a named group of codes for a job type).
 *  Staff only — RLS also enforces it. */
export async function saveCodeTemplate(input: {
  id?: string | null;
  name: string;
  codes: string[];
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const name = (input.name || "").trim();
  if (!name) return { ok: false, error: "Name is required." };
  const codes = Array.from(new Set((input.codes || []).map((c) => c.trim()).filter(Boolean)));
  if (!codes.length) return { ok: false, error: "Pick at least one code." };

  const { supabase, userId } = ctx;
  if (input.id) {
    const { error } = await supabase.from("job_code_templates").update({ name, codes }).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from("job_code_templates").insert({ name, codes, created_by: userId });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteCodeTemplate(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("job_code_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}
