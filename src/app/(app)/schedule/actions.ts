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

/** Offer the customer up to 3 date+time slots; returns the public pick token.
 *  A slot with no time schedules the job at 8 AM (legacy behavior). */
export async function createScheduleProposal(
  jobId: string,
  slots: { date: string; time?: string }[],
  timeNote?: string | null,
): Promise<Result & { token?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const clean = slots
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? ""))
    .map((s) => ({ date: s.date, time: /^\d{2}:\d{2}/.test(s.time ?? "") ? (s.time as string) : "" }))
    .slice(0, 3);
  if (!clean.length) return { ok: false, error: "Pick at least one date." };

  // One pending proposal per job — replace any existing one.
  await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending");

  const { data, error } = await supabase
    .from("schedule_proposals")
    .insert({ job_id: jobId, dates: clean, time_note: timeNote || null, created_by: user.id })
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

/** Reschedule a job (ISO string from the client, or null to clear). A single
 *  date here collapses the job back to one window, so clear any multi-range
 *  segments to keep the calendar/scheduler consistent. */
export async function rescheduleJob(
  id: string,
  startIso: string | null,
): Promise<Result> {
  const supabase = await createClient();
  // Clearing segments is best-effort: if the table isn't there yet (migration
  // 0040 not applied), the error is ignored and single-window rescheduling
  // still works.
  await supabase.from("job_schedule_segments").delete().eq("job_id", id);
  const patch: Record<string, unknown> = { scheduled_start: startIso };
  if (startIso) patch.status = "scheduled";
  const { error } = await supabase.from("jobs").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath("/calendar");
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

export type DateRange = { start: string; end: string }; // yyyy-mm-dd each

/** Canonical writer for a job's schedule as one or more date ranges. Replaces
 *  all segments, and mirrors the overall min start / max end onto
 *  jobs.scheduled_start/end (8am–4pm local) so every legacy reader still works. */
export async function setJobScheduleRanges(
  jobId: string,
  ranges: DateRange[],
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Keep only well-formed ranges; default a missing end to the start.
  const clean = ranges
    .map((r) => ({ start: r.start, end: r.end || r.start }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end))
    .map((r) => (r.end < r.start ? { start: r.start, end: r.start } : r))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Mirror the overall window onto the job FIRST — this is what every legacy
  // reader uses, and it must succeed even if the segments table isn't there.
  const minStart = clean.length ? clean[0].start : null;
  const maxEnd = clean.length ? clean.reduce((m, r) => (r.end > m ? r.end : m), clean[0].end) : null;
  const patch: Record<string, unknown> = {
    scheduled_start: minStart ? new Date(`${minStart}T08:00:00`).toISOString() : null,
    scheduled_end: maxEnd ? new Date(`${maxEnd}T16:00:00`).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("jobs").update(patch).eq("id", jobId);
  if (error) return { ok: false, error: error.message };

  // Replace segments wholesale. If the table is missing (migration 0040 not yet
  // applied) a single range is already fully saved via the mirror above; only
  // multi-range needs the table, so surface a clear message in that case.
  const { error: delErr } = await supabase.from("job_schedule_segments").delete().eq("job_id", jobId);
  let segOk = !delErr;
  if (segOk && clean.length) {
    const rows = clean.map((r) => ({ job_id: jobId, start_date: r.start, end_date: r.end }));
    const { error: insErr } = await supabase.from("job_schedule_segments").insert(rows);
    segOk = !insErr;
  }

  revalidatePath("/schedule");
  revalidatePath("/calendar");
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);

  if (!segOk && clean.length > 1) {
    return { ok: false, error: "Multiple date ranges need a quick database update (migration 0040). The first range was saved." };
  }
  return { ok: true };
}

function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
