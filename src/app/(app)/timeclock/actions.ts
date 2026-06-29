"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { visibleJobIdOrNull } from "@/lib/job-visibility";
import { requireStaff } from "@/lib/staff-guard";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { hoursBetween } from "@/lib/utils";
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

  // Role decides how far the start time may move. STAFF (owner/admin/office) can
  // backdate freely (forgot to clock in). A TECH/field employee can only round the
  // LIVE start BACK to the nearest half hour — so they can't pad hours by backdating.
  const { data: meRow } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const isStaff = !!meRow && ["owner", "admin", "office"].includes((meRow as { role?: string }).role ?? "");

  // Only attach a job the caller can actually see (RLS-scoped) — a stray/foreign
  // job_id (e.g. from a hand-built action call) would otherwise persist as a
  // dangling reference. Drops it to a no-job entry instead.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);

  // Start time — never into the future (small skew), floored 31 days back so a
  // fat-fingered year can't create a monstrous open shift. For a tech the value is
  // additionally clamped to [floor-to-30-min(now), now] so it can only round back.
  let clockInIso = new Date().toISOString();
  let backdated = false;
  if (input.clock_in_at) {
    const d = new Date(input.clock_in_at);
    let ms = d.getTime();
    if (!isNaN(ms)) {
      if (!isStaff) {
        const now = Date.now();
        const floor30 = now - (now % 1_800_000); // last :00/:30 boundary
        ms = Math.min(Math.max(ms, floor30), now + 60_000);
      }
      if (ms <= Date.now() + 60_000 && ms >= Date.now() - 31 * 86_400_000) {
        clockInIso = new Date(ms).toISOString();
        backdated = Math.abs(ms - Date.now()) > 60_000;
      }
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
      // Promote any not-yet-finished job to in_progress on clock-in (never un-complete a
      // finished/cancelled one). Was a literal carrying dead 'quoted'/'lead' (non-job statuses).
      .in("status", ACTIVE_JOB_STATUSES.filter((s) => s !== "in_progress"));
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

/**
 * Server-side guard for the split-across-jobs hours (the C7 fix). The client
 * (edit-entry-button.tsx) blocks a split whose hours exceed the worked shift, but
 * every OTHER write path — voice ("clock me out, 9 hours on rough-in"), the action
 * registry, crafted calls — reaches clockOut/updateTimeEntry directly with
 * caller-supplied allocations, so billing/cost could be charged at hours that don't
 * match payroll. We re-derive the billable shift here from clock_in/clock_out/lunch
 * (the same hoursBetween() payroll uses) and proportionally SCALE the allocation
 * hours down so their sum never exceeds the worked hours. Under-allocation is left
 * alone (unallocated time is paid but not billed). A 0.01h tolerance mirrors the
 * client's rounding slack so a legitimate exact-fill split isn't touched.
 */
function clampAllocationHours<T extends { hours: number }>(
  allocations: T[],
  workedHrs: number,
): T[] {
  const sum = allocations.reduce((s, a) => s + (Number(a.hours) || 0), 0);
  if (sum <= workedHrs + 0.01 || sum <= 0) return allocations;
  // Sum overshoots the billable shift — scale every row by worked/sum so the total
  // lands exactly on workedHrs, preserving each job's share. Keep cents (2-dp) rounding.
  const scale = workedHrs / sum;
  return allocations.map((a) => ({
    ...a,
    hours: Math.round((Number(a.hours) || 0) * scale * 100) / 100,
  }));
}

export async function clockOut(input: {
  entry_id: string;
  lunch_minutes: number;
  notes: string;
  gps: GeoPoint | null;
  auto?: boolean;
  miles?: number;
  allocations?: JobAllocationInput[];
  at?: string; // explicit clock-out time (ISO) — used by the geofence auto clock-out
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // The codes+hours requirement (the wrong-hours-on-wrong-jobs fix) must hold on EVERY
  // surface, not just the UI button — voice ("clock me out"), the action registry, and
  // crafted calls all reach clockOut directly. A field tech can't close a shift with no
  // code breakdown; staff reconcile later, and the geofence auto-close (input.auto)
  // legitimately defers the codes to completeAutoClockOut.
  if (!input.auto) {
    const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const isStaff = ["owner", "admin", "office"].includes((me as { role?: string } | null)?.role ?? "");
    const allocOk = (input.allocations ?? []).some((a) => a.job_code && a.hours > 0);
    if (!isStaff && !allocOk) {
      return { ok: false, error: "Add the job code(s) you worked and the hours before clocking out." };
    }
  }

  // Clock-out time defaults to now; `at` (the geofence "time they left") is honored
  // only if it's not in the future and not before clock-in (never negative hours).
  let clockOutIso = new Date().toISOString();
  if (input.at) {
    const atMs = Date.parse(input.at);
    if (!isNaN(atMs) && atMs <= Date.now() + 60_000) {
      const { data: e } = await supabase.from("time_entries").select("clock_in").eq("id", input.entry_id).maybeSingle();
      const ciMs = e?.clock_in ? Date.parse(e.clock_in) : 0;
      clockOutIso = new Date(Math.max(atMs, ciMs + 60_000)).toISOString();
    }
  }

  const { error } = await supabase
    .from("time_entries")
    .update({
      clock_out: clockOutIso,
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
  let allocations = (input.allocations ?? []).filter(
    (a) => a.hours > 0 || a.description.trim() || a.job_id || a.job_code,
  );
  // C7: clamp the caller-supplied split to the entry's worked hours BEFORE persisting,
  // so a voice/registry/crafted call can't bill/cost more hours than payroll pays.
  // Re-read clock_in (so we don't trust the caller for the shift bounds) and use the
  // final clock_out + lunch we're about to write — the same gross-minus-lunch payroll uses.
  if (allocations.length) {
    const { data: ent } = await supabase
      .from("time_entries")
      .select("clock_in")
      .eq("id", input.entry_id)
      .eq("profile_id", user.id)
      .maybeSingle();
    if (ent?.clock_in) {
      const workedHrs = hoursBetween(ent.clock_in, clockOutIso, input.lunch_minutes || 0);
      allocations = clampAllocationHours(allocations, workedHrs);
    }
  }
  const { data: oldAllocs } = await supabase
    .from("time_allocations")
    .select("id")
    .eq("time_entry_id", input.entry_id);
  const oldIds = (oldAllocs ?? []).map((a: { id: string }) => a.id);
  if (allocations.length) {
    // Drop any job_id the caller can't actually see (crafted/registry call) — never
    // persist a cross-org job reference on an allocation.
    const rows = await Promise.all(
      allocations.map(async (a, idx) => ({
        time_entry_id: input.entry_id,
        job_id: await visibleJobIdOrNull(supabase, a.job_id),
        job_code: a.job_code,
        hours: a.hours || 0,
        description: a.description || null,
        sort_order: idx,
      })),
    );
    const { error: allocErr } = await supabase.from("time_allocations").insert(rows);
    if (allocErr) return { ok: false, error: allocErr.message };
  }
  if (oldIds.length) await supabase.from("time_allocations").delete().in("id", oldIds);

  revalidatePath("/timeclock");
  revalidatePath("/planner"); // clock-in/out status shows on My Day
  return { ok: true };
}

/** Close the CALLER's currently-open time entry — finds the open entry instead of
 *  taking an entry_id, so the action registry / voice can "clock me out" hands-free.
 *  Routes through the one clockOut path (no duplicate close logic). */
export async function clockOutCurrent(input: {
  miles?: number;
  notes?: string;
  lunch_minutes?: number;
  /** The job-code/hours split — required for a TECH to close a shift (the codes-and-hours
   *  rule), so voice ("clock me out, 6 hours on rough-in") can finally complete a clock-out. */
  allocations?: JobAllocationInput[];
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
    allocations: input.allocations,
  });
}

/** Geofence auto clock-out — the GeofenceMonitor calls this when the employee has left
 *  the spot they clocked in at. Clocks out the caller's OPEN entry at `atIso` (the time
 *  they were last at the site), stamps the GPS, and marks the source 'auto_gps'. The
 *  entry's note is preserved. */
export async function geoClockOut(gps: GeoPoint | null, atIso: string): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: open } = await supabase
    .from("time_entries")
    .select("id, notes, lunch_minutes")
    .eq("profile_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (!open) return { ok: false, error: "Not clocked in." };
  return clockOut({
    entry_id: (open as any).id,
    lunch_minutes: (open as any).lunch_minutes ?? 0,
    notes: (open as any).notes ?? "",
    gps,
    auto: true,
    at: atIso,
  });
}

/**
 * Finish a geofence auto-clock-out: the tech answers the clock-out questions AFTER the
 * fact (which code(s) + hours, and whether they took lunch). Self-scoped to the caller's
 * OWN closed entry — the clock in/out times stay LOCKED at the geofence times; the tech
 * can only add the code breakdown and confirm lunch (which can only reduce hours).
 */
export async function completeAutoClockOut(input: {
  entry_id: string;
  lunch_minutes: number;
  allocations: JobAllocationInput[];
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: entry } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out")
    .eq("id", input.entry_id)
    .eq("profile_id", user.id)
    .eq("status", "closed")
    .maybeSingle();
  if (!entry) return { ok: false, error: "Entry not found." };

  const lunch = Math.max(0, Math.round(Number(input.lunch_minutes) || 0));
  await supabase.from("time_entries").update({ lunch_minutes: lunch }).eq("id", input.entry_id);

  let allocations = (input.allocations ?? []).filter((a) => a.job_code || a.hours);
  // C7: clamp the post-hoc code split to the entry's worked hours. The geofence locked
  // the clock in/out times; lunch can only reduce hours — so bill/cost can't exceed payroll.
  if (allocations.length && entry.clock_in && entry.clock_out) {
    const workedHrs = hoursBetween(entry.clock_in, entry.clock_out, lunch);
    allocations = clampAllocationHours(allocations, workedHrs);
  }
  if (allocations.length) {
    const rows = await Promise.all(
      allocations.map(async (a, idx) => ({
        time_entry_id: input.entry_id,
        job_id: await visibleJobIdOrNull(supabase, a.job_id),
        job_code: a.job_code || null,
        hours: a.hours || 0,
        description: a.description || null,
        sort_order: idx,
      })),
    );
    const { error: insErr } = await supabase.from("time_allocations").insert(rows);
    if (insErr) return { ok: false, error: insErr.message };
  }
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // auto clock-out changes who's on the clock on My Day
  return { ok: true };
}

/**
 * Add a past (manual) timecard entry — STAFF ONLY. A tech padding hours with a
 * back-dated manual entry is exactly what mis-billed jobs; techs clock in/out live
 * (rounding the start back to the half hour at most). The office adds corrections
 * here, for any crew member.
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
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const profileId = input.profile_id || ctx.userId;

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
  revalidatePath("/planner"); // a manual entry changes hours on My Day
  if (jobId) {
    // The entry is billable labor on this job — refresh its Time tab + labor totals
    // so "Create invoice" sees it immediately.
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
  }
  return { ok: true };
}

/** Edit an existing time entry (office payroll correction). STAFF ONLY — a tech
 *  must not be able to change their own times/job after the fact (that's how wrong
 *  hours reached the wrong jobs). Techs edit only the "what I did" note via
 *  saveEntryNotes; the office corrects the rest. */
export async function updateTimeEntry(input: {
  id: string;
  clock_in: string;
  clock_out: string;
  lunch_minutes: number;
  job_id?: string | null; // assign / reassign the entry to a job (null clears it)
  job_code: string | null;
  notes: string;
  miles?: number;
  rate_override?: number | null; // per-entry pay rate (e.g. supervisor rate); blank/0 ⇒ default
  profile_id?: string | null; // reassign the entry to a different team member
  // Split this shift across jobs (e.g. "1h at Northwoods, rest elsewhere"). When present,
  // these REPLACE the entry's allocations; billing then charges each job its own hours and
  // the entry's single job_id is no longer billed gross. Omit (undefined) to leave splits
  // untouched; pass [] to clear them.
  allocations?: JobAllocationInput[];
}): Promise<ClockResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
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
  // Only set rate_override when the caller sent the field (mirrors createManualEntry),
  // so older callers that omit it never wipe an existing supervisor rate. `null` clears it.
  if (input.rate_override !== undefined) patch.rate_override = input.rate_override;

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

  // Split across jobs — REPLACE this entry's allocations with the submitted set.
  // Insert the new rows BEFORE deleting the old (a failed insert can't wipe the
  // split), and refresh every job touched on either side so labor totals move.
  if (input.allocations !== undefined) {
    let allocs = input.allocations.filter((a) => (a.hours ?? 0) > 0 || a.job_id || a.job_code || a.description?.trim());
    // C7: clamp the split to the entry's worked hours server-side (the client guard in
    // edit-entry-button.tsx is advisory — voice/registry/crafted calls bypass it). Worked
    // hours come from the times we just validated above (ci/co + lunch), same as payroll.
    const workedHrs = hoursBetween(input.clock_in, input.clock_out, input.lunch_minutes || 0);
    allocs = clampAllocationHours(allocs, workedHrs);
    const { data: oldAllocs } = await supabase.from("time_allocations").select("id, job_id").eq("time_entry_id", input.id);
    const oldIds = (oldAllocs ?? []).map((a: { id: string }) => a.id);
    const touched = new Set<string>((oldAllocs ?? []).map((a: { job_id: string | null }) => a.job_id).filter(Boolean) as string[]);
    if (allocs.length) {
      const rows = await Promise.all(
        allocs.map(async (a, idx) => ({
          time_entry_id: input.id,
          job_id: await visibleJobIdOrNull(supabase, a.job_id),
          job_code: a.job_code || null,
          hours: a.hours || 0,
          description: a.description || null,
          sort_order: idx,
        })),
      );
      for (const r of rows) if (r.job_id) touched.add(r.job_id);
      const { error: aErr } = await supabase.from("time_allocations").insert(rows);
      if (aErr) return { ok: false, error: aErr.message };
    }
    if (oldIds.length) await supabase.from("time_allocations").delete().in("id", oldIds);
    for (const jid of touched) revalidatePath(`/jobs/${jid}`);
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
  revalidatePath("/planner"); // a deleted entry changes My Day's hours/clock state
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
  revalidatePath("/planner"); // notes/job changes surface on My Day
  return { ok: true };
}
