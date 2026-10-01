"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { CO_NEEDS_JOB, CO_NOT_AVAILABLE, CO_STAYS_ON_JOB } from "./co-words";

export type Result = { ok: boolean; error?: string; id?: string };

/*
 * CHANGE ORDERS LIVE ON THEIR JOB (W2-12). There is no list page any more (/change-orders redirects
 * to /jobs), so each write revalidates the job pages, where the Change Orders tab shows them. And a
 * change order always has its job (co-words.ts): create refuses one without, an edit can't unlink it,
 * and every write asks for its row back, because a zero-row write is a 204 that changed nothing.
 */

export async function createChangeOrder(formData: FormData): Promise<Result> {
  // change_orders is staff-only at the RLS boundary (is_org_staff on both read and write).
  // Guarding here too is the house pattern: the tech gets a sentence instead of a policy error.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId, orgId } = ctx;

  const description = String(formData.get("description") ?? "").trim();
  if (!description) return { ok: false, error: "Description is required." };
  // THE JOB IS REQUIRED: a change order with no job shows on no job, and nothing else can open it.
  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) return { ok: false, error: CO_NEEDS_JOB };
  // And it has to be one of this company's jobs (RLS scopes the read; the org filter says so twice).
  let jobRead = supabase.from("jobs").select("id").eq("id", jobId);
  if (orgId) jobRead = jobRead.eq("org_id", orgId);
  const { data: job, error: jobErr } = await jobRead.maybeSingle();
  if (jobErr) return { ok: false, error: dbError(jobErr) };
  if (!job) return { ok: false, error: CO_NEEDS_JOB };

  const { data, error } = await supabase
    .from("change_orders")
    .insert({
      description,
      amount: Number(formData.get("amount")) || 0,
      job_id: jobId,
      status: "pending",
      created_by: userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbError(error) };
  if (!data?.id) return { ok: false, error: "That change order didn't save. Nothing was added - try again." };
  revalidatePath("/jobs/[id]", "page");
  return { ok: true, id: data.id };
}

// PATCH semantics: only the fields present in the FormData are written — an absent key
// never touches its column (it used to zero the AMOUNT and unlink the job when a caller
// didn't repeat them). The edit form submits description and amount; it has no Job box.
export async function updateChangeOrder(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  const clean: Record<string, unknown> = {};
  if (formData.has("description")) {
    const description = String(formData.get("description") ?? "").trim();
    if (!description) return { ok: false, error: "Description is required." };
    clean.description = description;
  }
  if (formData.has("amount")) clean.amount = Number(formData.get("amount")) || 0;
  // NEVER UNLINKED (W2-12): "" used to become null, the last door that could orphan one. A change
  // order moved to another of this company's jobs is still on a job, so a real id stays allowed.
  if (formData.has("job_id")) {
    const jobId = String(formData.get("job_id") ?? "").trim();
    if (!jobId) return { ok: false, error: CO_STAYS_ON_JOB };
    let jobRead = supabase.from("jobs").select("id").eq("id", jobId);
    if (orgId) jobRead = jobRead.eq("org_id", orgId);
    const { data: job, error: jobErr } = await jobRead.maybeSingle();
    if (jobErr) return { ok: false, error: dbError(jobErr) };
    if (!job) return { ok: false, error: "That job isn't available, so nothing changed." };
    clean.job_id = jobId;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };

  let write = supabase.from("change_orders").update(clean).eq("id", id);
  if (orgId) write = write.eq("org_id", orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: CO_NOT_AVAILABLE };
  revalidatePath("/jobs/[id]", "page");
  return { ok: true };
}

export async function deleteChangeOrder(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  let write = supabase.from("change_orders").delete().eq("id", id);
  if (orgId) write = write.eq("org_id", orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: CO_NOT_AVAILABLE };
  revalidatePath("/jobs/[id]", "page");
  return { ok: true };
}

export async function setChangeOrderStatus(
  id: string,
  status: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  let write = supabase.from("change_orders").update({ status }).eq("id", id);
  if (orgId) write = write.eq("org_id", orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: CO_NOT_AVAILABLE };
  revalidatePath("/jobs/[id]", "page");
  return { ok: true };
}
