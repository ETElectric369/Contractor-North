"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createJob(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Job name is required." };

  const start = String(formData.get("scheduled_start") ?? "");

  // Optionally create a customer inline (when no existing one is selected).
  let customerId = emptyToNull(formData.get("customer_id"));
  const newCustomerName = String(formData.get("new_customer_name") ?? "").trim();
  if (!customerId && newCustomerName) {
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: newCustomerName,
        phone: emptyToNull(formData.get("new_customer_phone")),
        email: emptyToNull(formData.get("new_customer_email")),
        status: "active",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      name,
      customer_id: customerId,
      description: emptyToNull(formData.get("description")),
      status: String(formData.get("status") ?? "estimate"),
      address: emptyToNull(formData.get("address")),
      scheduled_start: start ? new Date(start).toISOString() : null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/schedule");
  return { ok: true, id: data.id };
}

export async function setJobStatus(id: string, status: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("jobs").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  return { ok: true };
}

/** Assign a job to a single employee (or clear). */
export async function setJobAssignee(
  id: string,
  employeeId: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("jobs")
    .update({ assigned_to: employeeId ? [employeeId] : [] })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

/** Offer the customer up to 3 dates; returns the public pick-a-date token. */
export async function createScheduleProposal(
  jobId: string,
  dates: string[],
): Promise<Result & { token?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const clean = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(0, 3);
  if (!clean.length) return { ok: false, error: "Pick at least one date." };

  // One pending proposal per job — replace any existing one.
  await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending");

  const { data, error } = await supabase
    .from("schedule_proposals")
    .insert({ job_id: jobId, dates: clean, created_by: user.id })
    .select("token")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, token: data.token };
}

export async function cancelScheduleProposal(id: string, jobId: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/** Set a job's full schedule window from anywhere (ISO strings or null). */
export async function setJobSchedule(
  id: string,
  startIso: string | null,
  endIso: string | null,
): Promise<Result> {
  const supabase = await createClient();
  const patch: Record<string, unknown> = {
    scheduled_start: startIso,
    scheduled_end: endIso,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("jobs").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

/** Reschedule a job (ISO string from the client, or null to clear). */
export async function rescheduleJob(
  id: string,
  startIso: string | null,
): Promise<Result> {
  const supabase = await createClient();
  const patch: Record<string, unknown> = { scheduled_start: startIso };
  if (startIso) patch.status = "scheduled";
  const { error } = await supabase.from("jobs").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
