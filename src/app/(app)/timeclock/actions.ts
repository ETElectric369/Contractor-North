"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { visibleJobIdOrNull } from "@/lib/job-visibility";
import type { GeoPoint } from "@/lib/types";

export type ClockResult = { ok: boolean; error?: string };

export async function clockIn(input: {
  job_id: string | null;
  job_code: string | null;
  gps: GeoPoint | null;
  clock_in_at?: string | null; // optional backdated start (e.g. forgot to clock in)
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Only attach a job the caller can actually see (RLS-scoped) — a stray/foreign
  // job_id (e.g. from a hand-built action call) would otherwise persist as a
  // dangling reference. Drops it to a no-job entry instead.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);

  // Allow starting the shift at any time the user picks — never into the future
  // (small skew allowed), and floored at 31 days back so a fat-fingered year
  // can't create a monstrous open shift.
  let clockInIso = new Date().toISOString();
  let backdated = false;
  if (input.clock_in_at) {
    const d = new Date(input.clock_in_at);
    const ms = d.getTime();
    if (!isNaN(ms) && ms <= Date.now() + 60_000 && ms >= Date.now() - 31 * 86_400_000) {
      clockInIso = d.toISOString();
      backdated = Math.abs(ms - Date.now()) > 60_000;
    }
  }

  // The DB has a unique index preventing two open entries; surface a friendly msg.
  const { error } = await supabase.from("time_entries").insert({
    profile_id: user.id,
    job_id: jobId,
    job_code: input.job_code,
    gps_in: input.gps,
    clock_in: clockInIso,
    status: "open",
    source: backdated ? "manual" : input.gps ? "app" : "manual",
  });

  if (error) {
    return {
      ok: false,
      error: error.message.includes("one_open_entry")
        ? "You're already clocked in."
        : error.message,
    };
  }

  // Clocking into a job means work has started — promote it to in_progress.
  // Only from pre-work states (never un-complete/-cancel a finished job), and
  // never let a blocked update (e.g. RLS) fail the clock-in itself.
  if (jobId) {
    await supabase
      .from("jobs")
      .update({ status: "in_progress" })
      .eq("id", jobId)
      .in("status", ["scheduled", "on_hold", "quoted", "lead"]);
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
  }

  revalidatePath("/timeclock");
  revalidatePath("/planner");
  return { ok: true };
}

export interface JobAllocationInput {
  job_id: string | null;
  job_code: string | null;
  hours: number;
  description: string;
}

export async function clockOut(input: {
  entry_id: string;
  lunch_minutes: number;
  notes: string;
  gps: GeoPoint | null;
  auto?: boolean;
  miles?: number;
  allocations?: JobAllocationInput[];
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { error } = await supabase
    .from("time_entries")
    .update({
      clock_out: new Date().toISOString(),
      lunch_minutes: input.lunch_minutes || 0,
      notes: input.notes || null,
      gps_out: input.gps,
      status: "closed",
      source: input.auto ? "auto_gps" : undefined,
      // Only set miles when the clock-out captured them, so we never overwrite an
      // existing value with 0.
      ...(input.miles != null && input.miles > 0 ? { miles: input.miles } : {}),
    })
    .eq("id", input.entry_id)
    .eq("profile_id", user.id);

  if (error) return { ok: false, error: error.message };

  // Replace any existing allocations with the submitted set. INSERT the new rows
  // BEFORE deleting the old ones, so a failed insert can't wipe the entry's
  // allocations (the JS client has no multi-statement transaction).
  const allocations = (input.allocations ?? []).filter(
    (a) => a.hours > 0 || a.description.trim() || a.job_id || a.job_code,
  );
  const { data: oldAllocs } = await supabase
    .from("time_allocations")
    .select("id")
    .eq("time_entry_id", input.entry_id);
  const oldIds = (oldAllocs ?? []).map((a: { id: string }) => a.id);
  if (allocations.length) {
    const rows = allocations.map((a, idx) => ({
      time_entry_id: input.entry_id,
      job_id: a.job_id,
      job_code: a.job_code,
      hours: a.hours || 0,
      description: a.description || null,
      sort_order: idx,
    }));
    const { error: allocErr } = await supabase.from("time_allocations").insert(rows);
    if (allocErr) return { ok: false, error: allocErr.message };
  }
  if (oldIds.length) await supabase.from("time_allocations").delete().in("id", oldIds);

  revalidatePath("/timeclock");
  return { ok: true };
}

/** Close the CALLER's currently-open time entry — finds the open entry instead of
 *  taking an entry_id, so the action registry / voice can "clock me out" hands-free.
 *  Routes through the one clockOut path (no duplicate close logic). */
export async function clockOutCurrent(input: {
  miles?: number;
  notes?: string;
  lunch_minutes?: number;
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: open } = await supabase
    .from("time_entries")
    .select("id")
    .eq("profile_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (!open) return { ok: false, error: "You're not clocked in." };
  return clockOut({
    entry_id: (open as any).id,
    lunch_minutes: input.lunch_minutes ?? 0,
    notes: input.notes ?? "",
    gps: null,
    miles: input.miles,
  });
}

/**
 * Add a past (manual) timecard entry. Techs can add their own; owner/admin/
 * office can add for any crew member. clock_in/clock_out are ISO strings built
 * on the client (so the user's local time is used).
 */
export async function createManualEntry(input: {
  profile_id: string;
  clock_in: string;
  clock_out: string;
  job_id: string | null;
  job_code: string | null;
  lunch_minutes: number;
  notes: string;
  miles?: number;
  rate_override?: number | null;
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isStaff = !!me && ["owner", "admin", "office"].includes(me.role);
  const profileId = isStaff ? input.profile_id || user.id : user.id;

  const ci = new Date(input.clock_in);
  const co = new Date(input.clock_out);
  if (isNaN(ci.getTime()) || isNaN(co.getTime())) {
    return { ok: false, error: "Invalid date/time." };
  }
  if (co <= ci) return { ok: false, error: "End must be after start." };

  // Drop a job_id the caller can't see (e.g. a crafted voice/registry call) — never
  // persist a cross-org job reference.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);

  const { error } = await supabase.from("time_entries").insert({
    profile_id: profileId,
    job_id: jobId,
    job_code: input.job_code,
    clock_in: ci.toISOString(),
    clock_out: co.toISOString(),
    lunch_minutes: input.lunch_minutes || 0,
    notes: input.notes || null,
    miles: input.miles ?? 0,
    rate_override: input.rate_override ?? null,
    status: "closed",
    source: "manual",
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timeclock");
  revalidatePath("/timecards");
  return { ok: true };
}

/** Edit an existing time entry (office payroll correction). RLS allows the
 *  entry owner or org staff. */
export async function updateTimeEntry(input: {
  id: string;
  clock_in: string;
  clock_out: string;
  lunch_minutes: number;
  job_id?: string | null; // assign / reassign the entry to a job (null clears it)
  job_code: string | null;
  notes: string;
  miles?: number;
  profile_id?: string | null; // reassign the entry to a different team member
}): Promise<ClockResult> {
  const supabase = await createClient();
  const ci = new Date(input.clock_in);
  const co = new Date(input.clock_out);
  if (isNaN(ci.getTime()) || isNaN(co.getTime())) {
    return { ok: false, error: "Invalid date/time." };
  }
  if (co <= ci) return { ok: false, error: "End must be after start." };

  const patch: Record<string, unknown> = {
    clock_in: ci.toISOString(),
    clock_out: co.toISOString(),
    lunch_minutes: input.lunch_minutes || 0,
    job_code: input.job_code,
    notes: input.notes || null,
    miles: input.miles ?? 0,
    status: "closed",
  };
  // Only touch job_id when the caller sent the field, so older callers that omit
  // it don't accidentally null out an entry's job. `null` explicitly clears it.
  if (input.job_id !== undefined) patch.job_id = input.job_id;
  if (input.profile_id) patch.profile_id = input.profile_id;

  // If the job is changing, grab the previous job first so we can refresh BOTH
  // the old and new job pages (their Time tab + labor totals), not just the
  // timecard lists — otherwise a reassigned entry lingers on the old job.
  let oldJobId: string | null = null;
  if (input.job_id !== undefined) {
    const { data: prev } = await supabase
      .from("time_entries")
      .select("job_id")
      .eq("id", input.id)
      .maybeSingle();
    oldJobId = (prev as { job_id: string | null } | null)?.job_id ?? null;
  }

  const { error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  if (input.job_id !== undefined) {
    for (const jid of new Set([oldJobId, input.job_id].filter(Boolean) as string[])) {
      revalidatePath(`/jobs/${jid}`);
    }
    revalidatePath("/jobs");
  }
  return { ok: true };
}

export async function deleteTimeEntry(id: string): Promise<ClockResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("time_entries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  return { ok: true };
}

/** Copy a finished entry to a new one (same person/job/code/times) so a repeat
 *  day can be logged in one tap, then tweaked. Open entries can't be duplicated. */
export async function duplicateTimeEntry(id: string): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: e, error: readErr } = await supabase
    .from("time_entries")
    .select("profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, notes, status")
    .eq("id", id)
    .single();
  if (readErr || !e) return { ok: false, error: readErr?.message ?? "Entry not found." };
  if (e.status !== "closed" || !e.clock_out) {
    return { ok: false, error: "Clock out the entry before duplicating it." };
  }

  const { error } = await supabase.from("time_entries").insert({
    profile_id: e.profile_id,
    clock_in: e.clock_in,
    clock_out: e.clock_out,
    lunch_minutes: e.lunch_minutes,
    miles: e.miles,
    job_id: e.job_id,
    job_code: e.job_code,
    notes: e.notes,
    status: "closed",
    source: "manual",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timecards");
  return { ok: true };
}

/** Save the "what did you do today?" note (and optional translation) mid-shift. */
export async function saveEntryNotes(
  entry_id: string,
  notes: string,
  translated_notes: string | null,
): Promise<ClockResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("time_entries")
    .update({ notes, translated_notes })
    .eq("id", entry_id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timeclock");
  return { ok: true };
}
