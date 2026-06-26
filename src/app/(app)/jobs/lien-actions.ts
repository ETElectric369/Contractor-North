"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

type Result = { ok: boolean; error?: string };

export type LienInput = {
  first_furnished_date?: string | null;
  completion_date?: string | null;
  owner_name?: string | null;
  owner_address?: string | null;
  hired_by_name?: string | null;
  gc_name?: string | null;
  gc_address?: string | null;
  lender_name?: string | null;
  lender_address?: string | null;
  estimated_amount?: number | null;
  noc_recorded?: boolean | null;
  prelim_sent_at?: string | null;
  lien_recorded_at?: string | null;
  notes?: string | null;
};

export type InsuranceInput = {
  carrier?: string | null;
  claim_number?: string | null;
  policy_number?: string | null;
  adjuster_name?: string | null;
  adjuster_phone?: string | null;
  date_of_loss?: string | null;
  notes?: string | null;
};

const d = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Partial update of a job's lien record — sets ONLY the provided date fields (so a voice
 *  "mark the prelim sent today" doesn't wipe owner/GC/dates already on file). Upserts on first
 *  set. Staff + org-scoped. */
export async function patchLienRecord(jobId: string, patch: Partial<LienInput>): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ["first_furnished_date", "completion_date", "prelim_sent_at", "lien_recorded_at", "notes"] as const) {
    if (patch[k] !== undefined) fields[k] = d(patch[k] as string | null | undefined);
  }
  const { data: existing } = await supabase.from("lien_records").select("id").eq("job_id", jobId).maybeSingle();
  const { error } = existing
    ? await supabase.from("lien_records").update(fields).eq("job_id", jobId)
    : await supabase.from("lien_records").insert({ ...fields, job_id: jobId, created_by: ctx.userId });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function upsertLienRecord(jobId: string, input: LienInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // The job must be visible to this org (RLS) before we attach a lien record.
  const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const fields = {
    first_furnished_date: d(input.first_furnished_date),
    completion_date: d(input.completion_date),
    owner_name: d(input.owner_name),
    owner_address: d(input.owner_address),
    hired_by_name: d(input.hired_by_name),
    gc_name: d(input.gc_name),
    gc_address: d(input.gc_address),
    lender_name: d(input.lender_name),
    lender_address: d(input.lender_address),
    estimated_amount: input.estimated_amount != null && Number(input.estimated_amount) > 0 ? Number(input.estimated_amount) : null,
    noc_recorded: !!input.noc_recorded,
    prelim_sent_at: d(input.prelim_sent_at),
    lien_recorded_at: d(input.lien_recorded_at),
    notes: d(input.notes),
    updated_at: new Date().toISOString(),
  };
  // Update if it exists (created_by stays); else insert (org_id via set_org_id trigger).
  const { data: existing } = await supabase.from("lien_records").select("id").eq("job_id", jobId).maybeSingle();
  const { error } = existing
    ? await supabase.from("lien_records").update(fields).eq("id", (existing as any).id)
    : await supabase.from("lien_records").insert({ ...fields, job_id: jobId, created_by: ctx.userId });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function upsertInsuranceClaim(jobId: string, input: InsuranceInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const fields = {
    carrier: d(input.carrier),
    claim_number: d(input.claim_number),
    policy_number: d(input.policy_number),
    adjuster_name: d(input.adjuster_name),
    adjuster_phone: d(input.adjuster_phone),
    date_of_loss: d(input.date_of_loss),
    notes: d(input.notes),
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase.from("insurance_claims").select("id").eq("job_id", jobId).maybeSingle();
  const { error } = existing
    ? await supabase.from("insurance_claims").update(fields).eq("id", (existing as any).id)
    : await supabase.from("insurance_claims").insert({ ...fields, job_id: jobId, created_by: ctx.userId });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
