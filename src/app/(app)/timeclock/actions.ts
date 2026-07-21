"use server";

import { revalidatePath } from "next/cache";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { visibleJobIdOrNull } from "@/lib/job-visibility";
import { requireStaff } from "@/lib/staff-guard";
import { ACTIVE_JOB_STATUSES, pickJobScheduledToday } from "@/lib/job-status";
import { hoursBetween } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDateTimeUtc, todayBoundsInTz } from "@/lib/tz";
import { createNotifications } from "@/lib/notifications";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { setJobCrew } from "../schedule/actions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeoPoint } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { lastSwitchMs, switchBreadcrumb } from "./switch-breadcrumb";
import { clampCloseAtMs, tailAllocationHours } from "./close-math";
import { ADOPT_AFTER_CLOCK_IN_MS, ADOPT_AFTER_SWITCH_MS } from "./adopt-window";

export type ClockResult = { ok: boolean; error?: string };

/**
 * The simple clock-in flow's server-side job resolution: the DEFAULT punch carries no
 * job picker for ANY role now (Erik: "the clock is two buttons"; staff pick a job only
 * via the More-options disclosure), so the job is derived here —
 *   0. the member's explicit CREW DAY-ASSIGNMENT for the org-local today
 *      (crew_day_assignments, migration 0139) — THE PRECEDENCE LAW: a planned
 *      day-assignment WINS over schedule/in_progress guesses, so the punch lands
 *      on the job the office put them on. Honored only while that job is still
 *      in flight (never punches into a completed/cancelled job);
 *   1. else the job the tech is ASSIGNED to that's scheduled TODAY (scheduled_start
 *      today, or a job_schedule_segments row covering the org-local day),
 *   2. else the org's ONLY in_progress job (unambiguous),
 *   3. else null — the entry lands job-less and the office attaches it later.
 * Never guesses between candidates beyond "earliest scheduled first"; RLS scopes every
 * read to the caller's org. Best-effort: any failure resolves to null, never blocks the punch.
 */
async function resolveTechJobToday(supabase: SupabaseClient, uid: string): Promise<string | null> {
  try {
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
    const { dayStart, dayEnd, todayStr } = todayBoundsInTz(tz);

    // TIER 0 — today's crew day-assignment wins. Fails soft (falls through) until
    // migration 0139 lands: the select errors → data null → next tier.
    const { data: dayRow } = await supabase
      .from("crew_day_assignments")
      .select("job_id")
      .eq("profile_id", uid)
      .eq("work_date", todayStr)
      .maybeSingle();
    const dayJobId = (dayRow as { job_id?: string } | null)?.job_id ?? null;
    if (dayJobId) {
      const { data: dayJob } = await supabase
        .from("jobs")
        .select("id")
        .eq("id", dayJobId)
        .in("status", ACTIVE_JOB_STATUSES)
        .maybeSingle();
      if (dayJob) return dayJobId;
    }

    const { data: mine } = await supabase
      .from("jobs")
      .select("id, scheduled_start")
      .contains("assigned_to", [uid])
      .in("status", ACTIVE_JOB_STATUSES);
    const myJobs = (mine ?? []) as { id: string; scheduled_start: string | null }[];
    if (myJobs.length) {
      // Scheduled today via the segments table (multi-range jobs) …
      const { data: segs } = await supabase
        .from("job_schedule_segments")
        .select("job_id")
        .in("job_id", myJobs.map((j) => j.id))
        .lte("start_date", todayStr)
        .gte("end_date", todayStr);
      const segToday = new Set(((segs ?? []) as { job_id: string }[]).map((s) => s.job_id));
      // … or via the scheduled_start mirror (single-day jobs) — the SHARED tier-1 pick
      // (lib/job-status.pickJobScheduledToday), the same one the /timeclock crew board
      // points members with, so the punch and the board can't drift.
      const today = pickJobScheduledToday(myJobs, segToday, dayStart, dayEnd);
      if (today) return today.id;
    }

    // No scheduled assignment — if the org has exactly ONE job in progress, that's the site.
    const { data: prog } = await supabase.from("jobs").select("id").eq("status", "in_progress").limit(2);
    const inProg = (prog ?? []) as { id: string }[];
    if (inProg.length === 1) return inProg[0].id;
    return null;
  } catch {
    return null; // the punch must never wait on / fail over job resolution
  }
}

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
  const isStaff = !!meRow && isStaffRole((meRow as { role?: string }).role ?? "");

  // Only attach a job the caller can actually see (RLS-scoped) — a stray/foreign
  // job_id (e.g. from a hand-built action call) would otherwise persist as a
  // dangling reference. Drops it to a no-job entry instead.
  let jobId = await visibleJobIdOrNull(supabase, input.job_id);

  // Simple-by-default flow: a job-less punch resolves its job server-side for EVERY
  // role now (techs never see a picker; staff only pick via "More options" — and Erik's
  // own one-tap punch must resolve the same way): today's assignment → the only
  // in_progress job → none (the office attaches it later).
  if (!jobId) {
    jobId = await resolveTechJobToday(supabase, user.id);
  }

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

export type SwitchJobResult = ClockResult & {
  /** The entry's notes AFTER the breadcrumb was appended — the client syncs its textarea to this. */
  notes?: string;
  /** Hours recorded for the outgoing job's segment — the client mirrors the split locally. */
  segment_hours?: number;
};

/**
 * Mid-shift job switch — records the OUTGOING job's hours as a time allocation and
 * re-points the open entry at the new job, so the day's split is captured AS IT
 * HAPPENS instead of being reconstructed from memory at clock-out (that
 * reconstruction is how wrong hours reached the wrong jobs). Self-scoped to the
 * caller's own OPEN entry. The current segment's start is derived from what's
 * already allocated (clock_in + previously recorded switch hours), so repeated
 * switches chain correctly even across app restarts. A human-readable breadcrumb
 * ("[switched to <job> at <ISO>]") is also appended to the notes so the office can
 * always re-derive the split in the edit modal, even if the allocations get replaced.
 */
export async function switchJob(input: {
  entry_id: string;
  job_id: string;
  job_code?: string | null;
  /** The tech's CURRENT notes text (may hold unsaved typing) — the breadcrumb is appended to this. */
  notes?: string;
  /** A fix taken AT THE SWITCH — becomes the entry's new geofence anchor (see below).
   *  Omitted/unusable ⇒ the old site's anchor is CLEARED, never left pointing at site A. */
  gps?: GeoPoint | null;
}): Promise<SwitchJobResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Self-scoped: only the caller's own OPEN entry can be switched.
  const { data: entry } = await supabase
    .from("time_entries")
    .select("id, clock_in, job_id, job_code, notes")
    .eq("id", input.entry_id)
    .eq("profile_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (!entry) return { ok: false, error: "No open entry to switch." };

  // The new job must be visible to the caller (RLS-scoped) — never re-point an
  // entry at a foreign/stray job id.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);
  if (!jobId) return { ok: false, error: "That job isn't available." };
  if (jobId === entry.job_id) return { ok: false, error: "You're already clocked into that job." };

  // The current segment started where the recorded switches left off: clock_in +
  // the hours already allocated by earlier switches. (An open entry has no other
  // allocation writers — clock-out replaces the whole set at close.)
  const { data: priorAllocs } = await supabase
    .from("time_allocations")
    .select("hours")
    .eq("time_entry_id", entry.id);
  const priorHours = (priorAllocs ?? []).reduce(
    (s: number, a: { hours: number | null }) => s + (Number(a.hours) || 0),
    0,
  );
  const segStartMs = new Date(entry.clock_in).getTime() + priorHours * 3_600_000;
  const segmentHours = Math.max(0, Math.round(((Date.now() - segStartMs) / 3_600_000) * 100) / 100);

  // Record the outgoing job's segment FIRST — a failed insert leaves the entry
  // untouched (still on the old job), so no time is ever attributed wrong.
  const { error: allocErr } = await supabase.from("time_allocations").insert({
    time_entry_id: entry.id,
    job_id: entry.job_id,
    job_code: entry.job_code,
    hours: segmentHours,
    description: "before switching jobs",
    sort_order: (priorAllocs ?? []).length,
  });
  if (allocErr) return { ok: false, error: allocErr.message };

  // Breadcrumb — human-readable AND parseable, appended to the tech's current note.
  const { data: j } = await supabase
    .from("jobs")
    .select("job_number, name")
    .eq("id", jobId)
    .maybeSingle();
  const label = j ? jobLabel((j as any)) : "another job";
  const base = (input.notes ?? entry.notes ?? "").trim();
  const crumb = switchBreadcrumb(label, new Date().toISOString());
  const notes = base ? `${base}\n${crumb}` : crumb;

  // THE ANCHOR MOVES WITH THE JOB. The geofence fences on the entry's gps_in; leaving
  // it on site A after a switch meant the live watch saw "left the site" the moment the
  // tech drove to site B, and its unanswered-prompt fallback closes the entry at the
  // time they were last seen at A — silently wiping the rest of the day's pay. So:
  // a usable fix taken at the switch becomes the new anchor; anything else NULLS it, and
  // a null anchor makes the monitor stand down (honestly quiet) until adoptGeofenceAnchor
  // re-arms it from a fix at the new site. Never leave a stale centre armed.
  const gps = input.gps;
  const usableFix =
    gps != null &&
    typeof gps.lat === "number" && typeof gps.lng === "number" &&
    Number.isFinite(gps.lat) && Number.isFinite(gps.lng) &&
    (gps.accuracy == null || gps.accuracy <= 200);
  const { error } = await supabase
    .from("time_entries")
    .update({
      job_id: jobId,
      job_code: input.job_code ?? null,
      notes,
      gps_in: usableFix
        ? { lat: gps!.lat, lng: gps!.lng, accuracy: gps!.accuracy ?? null, captured_at: new Date().toISOString() }
        : null,
    })
    .eq("id", entry.id)
    .eq("profile_id", user.id);
  if (error) return { ok: false, error: error.message };

  // Switching into a job means work has started there — promote it to in_progress
  // (same rule as clock-in; never un-complete a finished/cancelled job).
  await supabase
    .from("jobs")
    .update({ status: "in_progress" })
    .eq("id", jobId)
    .in("status", ACTIVE_JOB_STATUSES.filter((s) => s !== "in_progress"));
  revalidatePath(`/jobs/${jobId}`);
  if (entry.job_id) revalidatePath(`/jobs/${entry.job_id}`);
  revalidatePath("/jobs");
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // who's-on-which-job shows on My Day
  return { ok: true, notes, segment_hours: segmentHours };
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
  /** Unpaid lunch in minutes. null/undefined = "wasn't asked" (the one-tap flows) —
   *  the server's auto-lunch below decides. An explicit number (the details
   *  questionnaire, voice "I took an hour") is an ANSWER and is honored. */
  lunch_minutes: number | null;
  notes: string;
  gps: GeoPoint | null;
  auto?: boolean;
  miles?: number;
  /** undefined = leave the entry's recorded allocation rows alone (a one-tap close must
   *  never wipe mid-shift switchJob segments); a NON-EMPTY array replaces the whole set.
   *  `[]` is a no-op on the recorded rows — a clock-out may never destroy committed
   *  segments without replacing them (the "break it down later" / geofence paths pass it,
   *  and the AutoClockoutPrompt re-asks whenever the entry is left under-allocated). */
  allocations?: JobAllocationInput[];
  at?: string; // explicit clock-out time (ISO) — used by the geofence auto clock-out
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // The codes+hours requirement is GONE (Erik's two-button rework): a tech's clock-out
  // is ONE tap — no questionnaire — so allocations are optional for everyone. The job
  // was already resolved at clock-in; a job-less/split day is the office's reconcile.
  // Role still decides the auto-lunch below.
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const isStaff = isStaffRole((me as { role?: string } | null)?.role ?? "");

  // One self-scoped read of the entry's clock_in — feeds the `at` clamp, the
  // auto-lunch, and the allocation clamp below.
  const { data: entRow } = await supabase
    .from("time_entries")
    .select("clock_in, job_id, job_code")
    .eq("id", input.entry_id)
    .eq("profile_id", user.id)
    .maybeSingle();
  const ent = entRow as { clock_in?: string; job_id?: string | null; job_code?: string | null } | null;
  const entClockIn = ent?.clock_in ?? null;

  // The entry's ALREADY-RECORDED segments (switchJob writes one per mid-shift switch).
  // Read once: they set the floor for a backdated `at`, and they decide whether the
  // un-allocated tail needs filling below.
  const { data: recordedRows } = await supabase
    .from("time_allocations")
    .select("id, hours")
    .eq("time_entry_id", input.entry_id);
  const recorded = (recordedRows ?? []) as { id: string; hours: number | null }[];
  const recordedHours = recorded.reduce((s, a) => s + (Number(a.hours) || 0), 0);

  // Clock-out time defaults to now; `at` (the geofence "time they left") is honored
  // only if it's not in the future and not before clock-in (never negative hours).
  // FLOOR IT AT THE LAST RECORDED SEGMENT BOUNDARY: a mid-shift switch already
  // committed clock_in + recordedHours of work, so no caller — geofence fallback,
  // voice, a crafted call — may close the shift at a time that erases hours the
  // entry has already recorded as worked. (Belt to the anchor fix in switchJob:
  // even a stale-centre auto-close can no longer wipe the day.)
  let clockOutIso = new Date().toISOString();
  if (input.at) {
    const atMs = Date.parse(input.at);
    if (!isNaN(atMs) && atMs <= Date.now() + 60_000) {
      const ciMs = entClockIn ? Date.parse(entClockIn) : 0;
      clockOutIso = new Date(clampCloseAtMs(atMs, ciMs, recordedHours, Date.now())).toISOString();
    }
  }

  // Auto-lunch (Erik: "automatically deduct lunch"): the one-tap clock-out asks no lunch
  // question — and that's now EVERY role's default, not just a tech's (Erik clocks
  // himself and wants the same automation) — so a shift over 5 GROSS hours deducts the
  // 30-minute meal when the caller sent no explicit lunch figure. An explicit answer
  // (the "Clock out with details" questionnaire, voice "I took an hour") is honored —
  // though a tech's is still floored at the 30-minute legal meal, unchanged. The
  // geofence auto-close (input.auto) keeps its after-the-fact flow exactly as-is —
  // completeAutoClockOut owns lunch there, and it can only reduce hours.
  // NaN (a garbage crafted value) counts as NOT asked — the old `|| 0` coercion, kept.
  const lunchAsked = input.lunch_minutes != null && Number.isFinite(input.lunch_minutes);
  let lunchMinutes = lunchAsked ? (input.lunch_minutes as number) : 0;
  if (!input.auto && entClockIn) {
    const gross = hoursBetween(entClockIn, clockOutIso, 0);
    if (gross > 5 && (!lunchAsked || !isStaff)) lunchMinutes = Math.max(lunchMinutes, 30);
  }

  const { error } = await supabase
    .from("time_entries")
    .update({
      clock_out: clockOutIso,
      lunch_minutes: lunchMinutes,
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

  // Replace any existing allocations with the submitted set — ONLY when the caller
  // actually sent one (undefined = leave the recorded rows alone, so a one-tap close
  // from My Day / voice can't silently wipe a mid-shift switchJob split; the panel's
  // one-tap round-trips them as seeded rows and lands here with an array). INSERT the
  // new rows BEFORE deleting the old ones, so a failed insert can't wipe the entry's
  // allocations (the JS client has no multi-statement transaction).
  if (input.allocations !== undefined) {
    let allocations = input.allocations.filter(
      (a) => a.hours > 0 || a.description.trim() || a.job_id || a.job_code,
    );
    // C7: clamp the caller-supplied split to the entry's worked hours BEFORE persisting,
    // so a voice/registry/crafted call can't bill/cost more hours than payroll pays.
    // clock_in came from the self-scoped read above (never the caller) and the clamp uses
    // the final clock_out + lunch we just wrote — the same gross-minus-lunch payroll uses.
    if (allocations.length && entClockIn) {
      const workedHrs = hoursBetween(entClockIn, clockOutIso, lunchMinutes);
      allocations = clampAllocationHours(allocations, workedHrs);
    }
    const oldIds = recorded.map((a) => a.id);
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
      if (oldIds.length) await supabase.from("time_allocations").delete().in("id", oldIds);
    }
    // An EMPTY submitted set no longer destroys recorded rows. `[]` used to mean
    // "clear the split" and the delete ran unconditionally — so the geofence close
    // (and "break it down later") deleted the segments switchJob had recorded, and
    // the recovery prompt then re-filed the WHOLE day onto the post-switch job.
    // Nothing legitimately needs a clock-out to erase committed segments; the office
    // edit modal (updateTimeEntry) still clears a split with [] when asked to.
  }

  // TAIL BACKSTOP — the segment from the last switch to clock-out. switchJob records
  // only the OUTGOING job's hours, and only the timeclock panel seeds a live row for
  // the incoming one; My Day, the job-page button and voice/registry all close with no
  // allocations, leaving a partially-allocated entry. Billing treats "has any rows" as
  // fully allocated (labor-billing.ts), so those tail hours were billed to NO job and
  // vanished from job cost. Fill the remainder onto the entry's current job here, where
  // every closer passes through. Payroll is untouched — this writes only the billing split.
  if (input.allocations === undefined && recorded.length && entClockIn) {
    const workedHrs = hoursBetween(entClockIn, clockOutIso, lunchMinutes);
    const tail = tailAllocationHours(workedHrs, recordedHours);
    if (tail > 0) {
      await supabase.from("time_allocations").insert({
        time_entry_id: input.entry_id,
        job_id: ent?.job_id ?? null,
        job_code: ent?.job_code ?? null,
        hours: tail,
        description: "after switching jobs",
        sort_order: recorded.length,
      });
      if (ent?.job_id) {
        revalidatePath(`/jobs/${ent.job_id}`); // its labor total just gained the tail
        revalidatePath("/jobs");
      }
    }
  }

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
  /** Optional job-code/hours split (voice: "clock me out, 6 hours on rough-in").
   *  Optional for everyone since the two-button rework — with no split the entry
   *  bills gross to its own job. */
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
    // null when the caller didn't mention lunch → clockOut's auto-lunch decides
    // (>5h ⇒ 30 min, every role). Omitted allocations leave any recorded
    // mid-shift switch segments on the entry untouched.
    lunch_minutes: input.lunch_minutes ?? null,
    notes: input.notes ?? "",
    gps: null,
    miles: input.miles,
    allocations: input.allocations,
  });
}

/**
 * Backfill the geofence anchor for the caller's OPEN entry when clock-in couldn't
 * capture GPS — My Day and the job-page clock button punch with gps:null, and the
 * timeclock punch races a short GPS cap that loses to the iOS permission dialog on
 * first use. Without an anchor the geofence was silently dead for those shifts.
 * Tightly guarded: self-scoped to the caller's own OPEN entry, only while gps_in is
 * still empty, only within 15 minutes of clock-in (a reopen-from-home hours later can
 * never become "where the job is"), and only with a usable fix. The capture time is
 * stored alongside the coords so a backfilled anchor is distinguishable from a true
 * clock-in stamp when someone audits the entry.
 *
 * The two adoption windows (clock-in vs after a mid-shift switch) are the SHARED
 * constants in ./adopt-window, imported by the client monitor too so the two can't drift.
 */
export async function adoptGeofenceAnchor(entryId: string, gps: GeoPoint): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (
    typeof gps?.lat !== "number" || typeof gps?.lng !== "number" ||
    !Number.isFinite(gps.lat) || !Number.isFinite(gps.lng)
  ) {
    return { ok: false, error: "Bad coordinates." };
  }
  // A fix fuzzier than this proves nothing about where the job is — refuse it.
  if (gps.accuracy != null && gps.accuracy > 200) return { ok: false, error: "Fix too fuzzy to anchor on." };

  const { data: open } = await supabase
    .from("time_entries")
    .select("id, clock_in, gps_in, notes")
    .eq("id", entryId)
    .eq("profile_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (!open) return { ok: false, error: "Not clocked in." };
  if ((open as { gps_in: GeoPoint | null }).gps_in) return { ok: false, error: "Anchor already set." };
  // The adoption window opens at clock-in AND re-opens at each mid-shift switch: a
  // switch with no fix to hand deliberately NULLS the anchor (never leave the old
  // site's centre armed), so the fence has to be allowed to re-arm at the new site
  // or it stays dead for the rest of the day. Bounded either way — an app reopened
  // from home hours later can still never become "where the job is".
  const ciMs = Date.parse((open as { clock_in: string }).clock_in);
  const swMs = lastSwitchMs((open as { notes: string | null }).notes);
  const openedAt = Math.max(isNaN(ciMs) ? 0 : ciMs, swMs ?? 0);
  const windowMs = swMs != null && swMs >= (isNaN(ciMs) ? 0 : ciMs) ? ADOPT_AFTER_SWITCH_MS : ADOPT_AFTER_CLOCK_IN_MS;
  if (!openedAt || Date.now() - openedAt > windowMs) {
    return { ok: false, error: "Too long since clock-in to backfill a location." };
  }

  const { error } = await supabase
    .from("time_entries")
    .update({
      gps_in: {
        lat: gps.lat,
        lng: gps.lng,
        accuracy: gps.accuracy ?? null,
        // Honesty marker: this was captured AFTER the punch, not at it.
        captured_at: new Date().toISOString(),
      },
    })
    .eq("id", entryId)
    .eq("profile_id", user.id)
    .eq("status", "open");
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Geofence clock-out — the GeofenceMonitor calls this when the employee has left the
 *  job site. `atIso` is never a guess: it's either NOW (the "Clock out now" tap), a time
 *  the USER picked in the prompt sheet, or — for the live-watch auto close — the time
 *  GPS last observed them at the site. Clocks out the caller's OPEN entry, stamps the
 *  GPS, and marks the source 'auto_gps' so /timeclock asks the codes+lunch questions
 *  after the fact. The entry's note is preserved. */
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

  // Does the entry already carry recorded segments (a mid-shift switchJob split)?
  // If so, DON'T send an allocation set at all — the geofence close used to send `[]`,
  // which deleted those rows, and the recovery prompt then re-filed the entire day onto
  // the post-switch job (Job A lost its hours, Job B was over-billed the same hours).
  // With the rows preserved, clockOut's tail backstop allocates the closing segment and
  // the day's split survives the close. Only a genuinely un-split entry sends `[]`, which
  // keeps the after-the-fact breakdown flow (completeAutoClockOut) exactly as it was.
  const { count: allocCount } = await supabase
    .from("time_allocations")
    .select("id", { count: "exact", head: true })
    .eq("time_entry_id", (open as any).id);
  return clockOut({
    entry_id: (open as any).id,
    lunch_minutes: (open as any).lunch_minutes ?? 0,
    notes: (open as any).notes ?? "",
    gps,
    auto: true,
    at: atIso,
    allocations: (allocCount ?? 0) > 0 ? undefined : [],
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

  // Whatever the entry already carries. This action INSERTS alongside those rows (it
  // never replaces them), so both the clamp ceiling and the sort order have to start
  // from what's there — a mid-shift switch's segments now SURVIVE the geofence close.
  const { data: existing } = await supabase
    .from("time_allocations")
    .select("id, hours")
    .eq("time_entry_id", input.entry_id);
  const existingRows = (existing ?? []) as { id: string; hours: number | null }[];
  let already = existingRows.reduce((s, a) => s + (Number(a.hours) || 0), 0);

  // A meal confirmed HERE, AFTER the switch segments + tail were recorded (the switched
  // geofence auto-close deducted no lunch, so those rows summed to GROSS), would leave the
  // BILLED hours above the now-reduced PAID hours. Scale the recorded rows down to the
  // worked total so billing can never exceed payroll (the C7 no-over-bill law) — only when
  // the confirmed lunch actually pushed worked below what's already on the entry.
  if (entry.clock_in && entry.clock_out && existingRows.length) {
    const workedNow = hoursBetween(entry.clock_in, entry.clock_out, lunch);
    if (already > workedNow + 0.01) {
      const scaled = clampAllocationHours(
        existingRows.map((r) => ({ id: r.id, hours: Number(r.hours) || 0 })),
        workedNow,
      );
      for (const r of scaled) {
        await supabase.from("time_allocations").update({ hours: r.hours }).eq("id", r.id);
      }
      already = scaled.reduce((s, r) => s + (Number(r.hours) || 0), 0);
    }
  }

  let allocations = (input.allocations ?? []).filter((a) => a.job_code || a.hours);
  // C7: clamp the post-hoc split to the hours still UNALLOCATED. The geofence locked the
  // clock in/out times and lunch can only reduce hours, so bill/cost can't exceed payroll —
  // and clamping against the full shift (rather than the remainder) would let an entry's
  // recorded switch segments be billed a second time on top.
  if (allocations.length && entry.clock_in && entry.clock_out) {
    const remaining = Math.max(0, hoursBetween(entry.clock_in, entry.clock_out, lunch) - already);
    allocations = clampAllocationHours(allocations, remaining);
  }
  if (allocations.length) {
    const rows = await Promise.all(
      allocations.map(async (a, idx) => ({
        time_entry_id: input.entry_id,
        job_id: await visibleJobIdOrNull(supabase, a.job_id),
        job_code: a.job_code || null,
        hours: a.hours || 0,
        description: a.description || null,
        sort_order: existingRows.length + idx,
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
 *
 * Two input shapes: exact times (clock_in + clock_out ISO timestamps), or a DURATION
 * (work_date + hours — "Brian worked 6 hours Tuesday"). The duration shape expands to a
 * span centered on midday in the ORG timezone (lengthened by any lunch so the paid hours
 * equal the stated hours) and is flagged in notes as duration-entered. `hours` must be
 * the user's stated number — the fragment kernel never infers a payroll figure.
 */
export async function createManualEntry(input: {
  profile_id: string;
  clock_in?: string;
  clock_out?: string;
  work_date?: string; // YYYY-MM-DD (duration shape)
  hours?: number; // explicit, user-stated worked hours (duration shape)
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

  let clockIn = input.clock_in;
  let clockOut = input.clock_out;
  let notes = input.notes;
  if ((!clockIn || !clockOut) && input.work_date && input.hours != null) {
    if (!(input.hours > 0 && input.hours <= 24)) return { ok: false, error: "Hours must be between 0 and 24." };
    // Center the span on midday in the ORG tz; add the unpaid lunch to the span so the
    // net paid hours come out exactly as stated (payroll deducts lunch from the span).
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
    const spanMin = Math.round(input.hours * 60) + (input.lunch_minutes || 0);
    const startMin = Math.max(0, 12 * 60 - Math.round(spanMin / 2));
    const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
    const mm = String(startMin % 60).padStart(2, "0");
    const startIso = tzDateTimeUtc(input.work_date, `${hh}:${mm}`, tz);
    if (!startIso) return { ok: false, error: "I couldn't read that date." };
    clockIn = startIso;
    clockOut = new Date(new Date(startIso).getTime() + spanMin * 60_000).toISOString();
    // Flag it so a reviewer knows the times are a placeholder span, not observed times.
    notes = [notes?.trim(), `[duration-entered: ${input.hours}h]`].filter(Boolean).join(" ");
  }
  if (!clockIn || !clockOut) return { ok: false, error: "Need clock in & out times, or a work date + hours." };

  const ci = new Date(clockIn);
  const co = new Date(clockOut);
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
    notes: notes || null,
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

  // One stored-row fetch: the previous job (so a reassign can refresh BOTH job
  // pages' Time tab + labor totals) plus the pay-relevant fields and the two
  // payroll locks. A base-paid entry (paid_at) freezes clock in/out, lunch, rate
  // and person; a mileage-settled entry (mileage_paid_at) freezes miles — for
  // EVERY caller (modal, registry, voice, crafted; no bypass param), because the
  // payroll_runs snapshot the accountant exports must keep matching the live
  // entries. Undo the period on /payroll, fix the entry, re-mark — that records
  // a truthful new run instead of silently diverging the books.
  const { data: prev } = await supabase
    .from("time_entries")
    .select("job_id, clock_in, clock_out, lunch_minutes, rate_override, profile_id, miles, paid_at, mileage_paid_at")
    .eq("id", input.id)
    .maybeSingle();
  const stored = prev as {
    job_id: string | null;
    clock_in: string;
    clock_out: string | null;
    lunch_minutes: number | null;
    rate_override: number | null;
    profile_id: string;
    miles: number | null;
    paid_at: string | null;
    mileage_paid_at: string | null;
  } | null;
  if (!stored) return { ok: false, error: "Entry not found." };
  const oldJobId: string | null = stored.job_id;

  // The locks trip on VALUE-diff, not field presence — clock_in/out/lunch are
  // mandatory params the edit modal re-sends on every save, so a notes/job/split
  // fix on a paid entry must pass untouched. Times compare at minute granularity
  // (the modal round-trips them with seconds truncated).
  const timeMoved = (nextIso: string, storedIso: string | null) =>
    !storedIso || Math.abs(new Date(nextIso).getTime() - new Date(storedIso).getTime()) >= 60_000;
  if (stored.paid_at) {
    const oldRate = stored.rate_override == null ? null : Number(stored.rate_override);
    const newRate = input.rate_override === undefined ? oldRate : (input.rate_override ?? null);
    const rateMoved =
      (oldRate == null) !== (newRate == null) ||
      (oldRate != null && newRate != null && Math.abs(oldRate - newRate) > 0.001);
    const payMoved =
      timeMoved(ci.toISOString(), stored.clock_in) ||
      timeMoved(co.toISOString(), stored.clock_out) ||
      (input.lunch_minutes || 0) !== (stored.lunch_minutes ?? 0) ||
      rateMoved ||
      (!!input.profile_id && input.profile_id !== stored.profile_id);
    if (payMoved) return { ok: false, error: "Entry is in a paid period — Undo on Payroll first." };
  }
  if (stored.mileage_paid_at && Math.abs((input.miles ?? 0) - Number(stored.miles ?? 0)) > 0.001) {
    return { ok: false, error: "Entry's mileage is settled — Undo on Payroll first." };
  }

  const { error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // an office hours/job edit changes My Day's totals + crew board
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
  // Payroll locks: a base-paid or mileage-settled entry backs a payroll_runs
  // snapshot the accountant exports — deleting it would silently diverge the
  // books. No bypass for any caller: Undo the period on /payroll first.
  const { data: locked } = await supabase
    .from("time_entries")
    .select("paid_at, mileage_paid_at")
    .eq("id", id)
    .maybeSingle();
  const lock = locked as { paid_at: string | null; mileage_paid_at: string | null } | null;
  if (lock?.paid_at) return { ok: false, error: "Entry is in a paid period — Undo on Payroll first." };
  if (lock?.mileage_paid_at) return { ok: false, error: "Entry's mileage is settled — Undo on Payroll first." };
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
    .select("profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, notes, status, rate_override")
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
    // A duplicated supervisor-rate shift must PAY like the original — dropping the
    // override silently paid base rate (the cn-v291 wage-bug family).
    rate_override: e.rate_override ?? null,
    status: "closed",
    source: "manual",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // a duplicated entry changes My Day's hours + crew board
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

/**
 * Office crew assignment (the /timeclock admin list): put a member on ONE active job
 * for today — or none. Removes them from every OTHER active job's crew and adds them
 * to the chosen one, routing every write through the canonical setJobCrew (which
 * diffs the crew and notifies the added member — bell + "assigned" push). Staff-only.
 */
export async function assignMemberToJob(memberId: string, jobId: string | null): Promise<ClockResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // The member must be visible to the caller (RLS keeps this org-scoped).
  const { data: member } = await supabase.from("profiles").select("id").eq("id", memberId).maybeSingle();
  if (!member) return { ok: false, error: "Member not found." };

  // Every ACTIVE job currently carrying this member (the set to clear).
  const { data: mine } = await supabase
    .from("jobs")
    .select("id, assigned_to")
    .contains("assigned_to", [memberId])
    .in("status", ACTIVE_JOB_STATUSES);
  const carrying = (mine ?? []) as { id: string; assigned_to: string[] | null }[];

  // ADD to the chosen job first — a mid-way failure must never leave them unassigned.
  if (jobId) {
    const { data: target } = await supabase.from("jobs").select("id, assigned_to").eq("id", jobId).maybeSingle();
    if (!target) return { ok: false, error: "Job not found." };
    const ids = ((target as { assigned_to?: string[] | null }).assigned_to ?? []) as string[];
    if (!ids.includes(memberId)) {
      const res = await setJobCrew(jobId, [...ids, memberId]);
      if (!res.ok) return { ok: false, error: res.error };
    }
  }
  // …then take them off every other active job (removals are silent by design).
  for (const j of carrying) {
    if (j.id === jobId) continue;
    const res = await setJobCrew(j.id, (j.assigned_to ?? []).filter((x) => x !== memberId));
    if (!res.ok) return { ok: false, error: res.error };
  }

  revalidatePath("/timeclock"); // setJobCrew already refreshed /schedule, /planner, the job pages
  return { ok: true };
}

export type DailyReportSummary = {
  total_hours: number;
  miles: number;
  first_in: string | null;
  last_out: string | null;
  jobs: { job_id: string | null; label: string; hours: number }[];
};
export type DailyReportResult = ClockResult & { summary?: DailyReportSummary };

/**
 * The crew-lead debrief: file (upsert) today's daily report — "what did you do today?"
 * + "what materials do you need tomorrow?" — for the CALLER, stamped with a GPS-derived
 * day summary built from their own time_entries + allocations ("GPS tells the story:
 * drive time, miles, arrive at job, time on job"). One report per person per org-local
 * day (re-filing revises it). Confirmed by Nort and filed for office editing; org staff
 * get the bell + a "daily_report" push (the quote-accept dual-channel pattern), never
 * the filer themselves.
 */
export async function fileDailyReport(input: {
  did_today: string;
  materials_tomorrow: string;
}): Promise<DailyReportResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const did = (input.did_today ?? "").trim();
  const mats = (input.materials_tomorrow ?? "").trim();
  if (!did && !mats) return { ok: false, error: "Say what you did today (or dictate it) before filing." };

  const { data: meRow } = await supabase
    .from("profiles")
    .select("org_id, full_name")
    .eq("id", user.id)
    .maybeSingle();
  const me = meRow as { org_id: string | null; full_name: string | null } | null;
  if (!me?.org_id) return { ok: false, error: "No organization on your profile." };

  // "Today" is the ORG's local day — the same boundary the clock pages use.
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
  const { dayStart, dayEnd, todayStr } = todayBoundsInTz(tz);

  // GPS summary — the caller's own day: entries that STARTED today, their split rows,
  // total net hours, miles, first arrival / last departure, and hours per job.
  const { data: entries } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, lunch_minutes, miles, job_id, status, time_allocations(job_id, hours)")
    .eq("profile_id", user.id)
    .gte("clock_in", dayStart.toISOString())
    .lt("clock_in", dayEnd.toISOString());
  const rows = (entries ?? []) as {
    id: string;
    clock_in: string;
    clock_out: string | null;
    lunch_minutes: number | null;
    miles: number | null;
    job_id: string | null;
    status: string;
    time_allocations?: { job_id: string | null; hours: number | null }[] | null;
  }[];

  let totalHours = 0;
  let miles = 0;
  let firstIn: string | null = null;
  let lastOut: string | null = null;
  const perJob = new Map<string, number>(); // job_id (or "") → hours
  for (const e of rows) {
    const end = e.clock_out ?? new Date().toISOString(); // an open entry counts to "now"
    const h = hoursBetween(e.clock_in, end, e.lunch_minutes ?? 0);
    totalHours += h;
    miles += Number(e.miles) || 0;
    if (!firstIn || e.clock_in < firstIn) firstIn = e.clock_in;
    if (e.clock_out && (!lastOut || e.clock_out > lastOut)) lastOut = e.clock_out;
    const allocs = (e.time_allocations ?? []).filter((a) => (Number(a.hours) || 0) > 0);
    if (allocs.length) {
      for (const a of allocs) {
        const key = a.job_id ?? "";
        perJob.set(key, (perJob.get(key) ?? 0) + (Number(a.hours) || 0));
      }
    } else {
      const key = e.job_id ?? "";
      perJob.set(key, (perJob.get(key) ?? 0) + h);
    }
  }
  // Labels for the jobs touched today (one RLS-scoped lookup).
  const jobIds = [...perJob.keys()].filter(Boolean);
  const labelMap = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobRows } = await supabase.from("jobs").select("id, job_number, name").in("id", jobIds);
    for (const j of (jobRows ?? []) as { id: string; job_number: string | null; name: string | null }[]) {
      // Deliberately NOT schedule-options' jobLabel: this drops empty halves and falls
      // back to the id (the shared shape would print "undefined · x" on a partial row).
      labelMap.set(j.id, [j.job_number, j.name].filter(Boolean).join(" · ") || j.id);
    }
  }
  const summary: DailyReportSummary = {
    total_hours: Math.round(totalHours * 100) / 100,
    miles: Math.round(miles * 10) / 10,
    first_in: firstIn,
    last_out: lastOut,
    jobs: [...perJob.entries()].map(([jobId, hours]) => ({
      job_id: jobId || null,
      label: jobId ? labelMap.get(jobId) ?? "a job" : "No job set",
      hours: Math.round(hours * 100) / 100,
    })),
  };

  // One row per (org, person, day) — re-filing revises. org_id passed explicitly
  // (belt) on top of the set_org_id stamp trigger (suspenders).
  const { error } = await supabase.from("daily_reports").upsert(
    {
      org_id: me.org_id,
      profile_id: user.id,
      report_date: todayStr,
      did_today: did || null,
      materials_tomorrow: mats || null,
      gps_summary: summary,
      status: "filed",
    },
    { onConflict: "org_id,profile_id,report_date" },
  );
  if (error) return { ok: false, error: error.message };

  // Tell the office — bell (always works) + push, suppressing the filer.
  const staff = (await orgStaffIds(me.org_id)).filter((id) => id !== user.id);
  const name = me.full_name ?? "the crew";
  const payload = {
    title: `Daily report from ${name}`,
    body: (did || mats).split("\n")[0].slice(0, 140),
    url: "/timecards",
  };
  await createNotifications(me.org_id, staff, { type: "daily_report", ...payload });
  await sendPushToProfiles(staff, "daily_report", payload);

  revalidatePath("/planner"); // the boss's Daily reports card
  revalidatePath("/timecards");
  return { ok: true, summary };
}

/**
 * Office review: flip a daily report filed → reviewed (the second half of 0128's
 * `status` design — "filed for office editing"). Staff-only; RLS (daily_reports_update:
 * own-or-staff, org-scoped) backstops the guard. Reviewed rows stay visible on the
 * /timecards review list, just checked off.
 */
export async function markDailyReportReviewed(id: string): Promise<ClockResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("daily_reports").update({ status: "reviewed" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timecards");
  revalidatePath("/planner");
  return { ok: true };
}

/**
 * Geofence site-leave push — TECHS ONLY (Erik: "push at geofence for clock out only
 * for techs"). The GeofenceMonitor's leave-site detection is client-side, so it calls
 * this tiny hook when the prompt sheet opens; the push complements the sheet (which
 * only renders while the app is foregrounded) and never replaces the existing
 * auto-clockout behavior. Self-targeted by construction — the recipient is always the
 * CALLER — and inert unless they're actually clocked in, so a stray call can't spam.
 */
// One leave-prompt per shift per this window. The client monitor re-checks on every PWA
// mount/wake, so without a DURABLE cap a single stray "outside" read re-pushes on every
// reload (Brian, 2026-07-20 — still on-site, still clocked in). Aligned with the client's
// 45-min "Still Working" snooze.
const GEOFENCE_PUSH_DEBOUNCE_MS = 30 * 60 * 1000;

export async function notifyGeofenceExit(jobLabel?: string): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (isStaffRole((me as { role?: string } | null)?.role ?? "")) return { ok: true }; // techs only
  const { data: open } = await supabase
    .from("time_entries")
    .select("id, last_geofence_push_at")
    .eq("profile_id", user.id)
    .eq("status", "open")
    .maybeSingle();
  if (!open) return { ok: true }; // not on the clock — nothing to remind
  // Durable debounce (0147): the in-memory client guard resets on every PWA reload, so this
  // is what actually stops the spam — no-op if we already prompted this shift within the window.
  const lastAt = (open as { last_geofence_push_at?: string | null }).last_geofence_push_at;
  if (lastAt && Date.now() - Date.parse(lastAt) < GEOFENCE_PUSH_DEBOUNCE_MS) return { ok: true };
  const label = (jobLabel ?? "").trim().slice(0, 80) || "the job site";
  await sendPushToProfiles([user.id], "clock_out", {
    title: "Clock out?",
    body: `Looks like you left ${label} — you're still on the clock.`,
    url: "/timeclock",
  });
  // Stamp AFTER sending so a failed push doesn't silence the next legit prompt. Own open row
  // + a non-pay column → passes both the RLS owner policy and the 0143 write guard.
  await supabase
    .from("time_entries")
    .update({ last_geofence_push_at: new Date().toISOString() })
    .eq("id", (open as { id: string }).id);
  return { ok: true };
}
