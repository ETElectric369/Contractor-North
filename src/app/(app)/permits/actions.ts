"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { orgTrade } from "@/lib/org-trade";
import { defaultPermitType } from "@/lib/trade-package";

export type Result = { ok: boolean; error?: string };

/**
 * THE PERMIT ITSELF — NOT ITS INSPECTIONS (0378).
 *
 * permits.inspection_date, permits.inspector and permits.inspection_result are SUPERSEDED: they
 * carried ONE inspection inline, and a permit needs several, from different authorities, in order
 * ("we have to get it inspected by both the Town of Truckee and Liberty Utilities before Liberty will
 * put the meter back on"). They live in permit_inspections now — booked and written up through
 * permits/inspection-actions. Nothing here reads or writes them, and tests/no-superseded-permit-columns
 * fails the suite if anything starts again.
 *
 * `authority` STAYS, and keeps its own meaning: who ISSUED the permit. Who issues it and who inspects
 * it are not the same question.
 */
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
  notes?: string | null;
  portal_url?: string | null;
}

function rev(jobId?: string | null) {
  revalidatePath("/permits");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

/**
 * THE TRADE'S PERMIT, NEVER THE COLUMN'S. permits.type defaults to "Electrical" in the database
 * (0022, written for one electrician), and this door used to send the same word for a blank type —
 * so a plumber's permit logged by Nort with no type said Electrical. A blank type is now the
 * company's trade's permit (lib/trade-package defaultPermitType: Plumbing, Mechanical, Building, …),
 * read from its settings only when nothing was typed; the forms always send a type, so the read is
 * Nort's and the API's. A failed settings read is said, not papered over with a guess.
 */
type StaffCtx = Extract<Awaited<ReturnType<typeof requireStaff>>, { supabase: unknown }>;
async function permitTypeFor(ctx: StaffCtx, typed: string | undefined): Promise<{ type: string } | { error: string }> {
  const t = typed?.trim();
  if (t) return { type: t };
  // The company's own row, by id (three orgs, one database: RLS scopes it, and the read says so too).
  if (!ctx.orgId) return { error: "Your sign-in isn't attached to a company yet." };
  const { data: org, error } = await ctx.supabase.from("organizations").select("settings").eq("id", ctx.orgId).limit(1).maybeSingle();
  if (error) return { error: dbError(error) };
  return { type: defaultPermitType(orgTrade(getOrgSettings((org as { settings?: unknown } | null)?.settings)).key) };
}

export async function createPermit(input: PermitInput): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const picked = await permitTypeFor(ctx, input.type);
  if ("error" in picked) return { ok: false, error: picked.error };

  const { error } = await supabase.from("permits").insert({
    job_id: input.job_id || null,
    permit_number: input.permit_number?.trim() || null,
    type: picked.type,
    authority: input.authority?.trim() || null,
    status: input.status || "applied",
    applied_date: input.applied_date || null,
    issued_date: input.issued_date || null,
    expires_date: input.expires_date || null,
    fee: input.fee ?? 0,
    notes: input.notes?.trim() || null,
    portal_url: input.portal_url?.trim() || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: dbError(error) };
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
    "expires_date", "notes", "portal_url",
  ] as const) {
    if (patch[k] !== undefined) clean[k] = (patch[k] as string) || null;
  }
  if (patch.fee !== undefined) clean.fee = patch.fee ?? 0;

  const { error } = await supabase.from("permits").update(clean).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  rev(patch.job_id);
  return { ok: true };
}

export async function deletePermit(id: string, jobId?: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("permits").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  rev(jobId);
  return { ok: true };
}
