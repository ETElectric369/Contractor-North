"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

export interface PermitInput {
  job_id?: string | null;
  permit_number?: string | null;
  type?: string;
  authority?: string | null;
  status?: string;
  applied_date?: string | null;
  issued_date?: string | null;
  expires_date?: string | null;
  fee?: number;
  inspection_date?: string | null;
  inspector?: string | null;
  inspection_result?: string;
  notes?: string | null;
  portal_url?: string | null;
}

function rev(jobId?: string | null) {
  revalidatePath("/permits");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

export async function createPermit(input: PermitInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { error } = await supabase.from("permits").insert({
    job_id: input.job_id || null,
    permit_number: input.permit_number?.trim() || null,
    type: input.type?.trim() || "Electrical",
    authority: input.authority?.trim() || null,
    status: input.status || "applied",
    applied_date: input.applied_date || null,
    issued_date: input.issued_date || null,
    expires_date: input.expires_date || null,
    fee: input.fee ?? 0,
    inspection_date: input.inspection_date || null,
    inspector: input.inspector?.trim() || null,
    inspection_result: input.inspection_result || "pending",
    notes: input.notes?.trim() || null,
    portal_url: input.portal_url?.trim() || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: error.message };
  rev(input.job_id);
  return { ok: true };
}

export async function updatePermit(id: string, patch: PermitInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const clean: Record<string, unknown> = {};
  for (const k of [
    "permit_number", "type", "authority", "status", "applied_date", "issued_date",
    "expires_date", "inspection_date", "inspector", "inspection_result", "notes", "portal_url",
  ] as const) {
    if (patch[k] !== undefined) clean[k] = (patch[k] as string) || null;
  }
  if (patch.fee !== undefined) clean.fee = patch.fee ?? 0;

  const { error } = await supabase.from("permits").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  rev(patch.job_id);
  return { ok: true };
}

export async function deletePermit(id: string, jobId?: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("permits").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  rev(jobId);
  return { ok: true };
}
