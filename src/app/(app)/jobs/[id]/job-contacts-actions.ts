"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

/** Link a contact (subcontractor / supplier / inspector — any customer) to a job. The same
 *  contact can be linked to many jobs (it's a many-to-many, separate from jobs.customer_id). */
export async function linkJobContact(jobId: string, customerId: string, role: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!customerId) return { ok: false, error: "Pick a contact." };
  // Both the job and the contact must be visible to this caller (RLS) before we link them.
  const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };
  const { data: cust } = await supabase.from("customers").select("id").eq("id", customerId).maybeSingle();
  if (!cust) return { ok: false, error: "Contact not found." };

  const { error } = await supabase
    .from("job_contacts")
    .insert({ job_id: jobId, customer_id: customerId, role: role?.trim() || "Subcontractor", created_by: ctx.userId });
  if (error) {
    if ((error as { code?: string }).code === "23505")
      return { ok: false, error: "That contact is already on this job in that role." };
    if ((error as { code?: string }).code === "42P01")
      return { ok: false, error: "Sublinking isn't set up yet — run migration 0087." };
    return { ok: false, error: error.message };
  }
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function unlinkJobContact(id: string, jobId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("job_contacts").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
