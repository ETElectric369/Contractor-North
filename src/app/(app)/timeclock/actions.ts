"use server";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";

import { revalidatePath } from "next/cache";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { visibleJobIdOrNull } from "@/lib/job-visibility";
import { requireStaff } from "@/lib/staff-guard";
import { ACTIVE_JOB_STATUSES, pickJobScheduledToday } from "@/lib/job-status";
import { hoursBetween } from "@/lib/utils";
import { splitPreview } from "@/lib/split-preview";
import { resolveOfflinePunchTime } from "@/lib/offline/punch-time";
import { runOnce } from "@/lib/offline/run-once";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";
import { createNotifications } from "@/lib/notifications";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { setJobCrew } from "../schedule/actions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeoPoint } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { lastSwitchMs, switchBreadcrumb } from "./switch-breadcrumb";
import {
  clampCloseAtMs,
  durationSpan,
  lunchFits,
  needsStatedStop,
  placeLunch,
  stopCrumb,
  withAutoConfirmedCrumb,
  withStopCrumb,
  type LunchPart,
} from "./close-math";
import { loadShiftChains, type ShiftInfo } from "@/lib/shift-chain";
import { ADOPT_AFTER_CLOCK_IN_MS, ADOPT_AFTER_SWITCH_MS } from "./adopt-window";
import { billedPartMoved, claimedMoveRefusal, type ClaimHolder, type ClaimIndex } from "./claim-words";
import { LONG_SHIFT_PHRASE, MAX_SHIFT_HOURS, clockDoorWords, clockedOutWords, isLongOpenShift, stopProblem } from "@/lib/long-shift";

export type ClockResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  /** The clock has been running LONG_SHIFT_HOURS or more and nobody said when it stopped: the
   *  caller should ask for a stop time instead of closing at now (the Timeclock long-shift block). */
  needsTime?: boolean;
};

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
      .select("job_id, kind")
      .eq("profile_id", uid)
      .eq("work_date", todayStr)
      .maybeSingle();
    const day = dayRow as { job_id?: string | null; kind?: string } | null;
    /**
     * OFF FAILS CLOSED (0170) — and this is the half that actually costs money.
     *
     * The office marks Brian off for the week. Without this line the resolver falls straight
     * through to tier 1, which reads `jobs.assigned_to` — the ROSTER, which still (correctly)
     * contains him — so his phone would punch onto the very job the office thought it had taken
     * him off, and that job_id lands in time_entries, which is what the job gets COSTED from.
     *
     * A deliberate "not on a job today" must beat every guess below it. The day row wins; a
     * job-less punch is the honest outcome and the office attaches it later if it was a mistake.
     */
    if (day?.kind === "off") return null;
    const dayJobId = day?.job_id ?? null;
    if (dayJobId) {
      const { data: dayJob } = await supabase
        .from("jobs")
        .select("id")
        .eq("id", dayJobId)
        .in("status", ACTIVE_JOB_STATUSES)
        .maybeSingle();
      if (dayJob) return dayJobId;
    }

    /**
     * THE PUNCH AND THE CARD READ THE SAME ROWS (0266, and the reason it exists).
     *
     * `scheduled_end` rides along because the two dates ARE the job's window whenever the segment
     * rows are missing, and the PROJECTION law is that a missing field reads as an absence rather
     * than an error. Leaving it out is what made this mirror answer only on a job's START day: on
     * day two of a three-day job the Clock's Next Up card said "22 Pine" off the full window while
     * this resolver, mirroring the start day alone, went somewhere else. A card and a punch that
     * disagree about where a man is, is the exact thing the precedence law exists to stop.
     *
     * Until 0266 a tech could not READ job_schedule_segments at all (0040's only policy was
     * staff-only for every verb, reads included), so both surfaces were running on mirrors and
     * drifting apart in different directions. Now both read the real rows, and the mirror below is
     * what it should always have been: the fallback for a job whose segments were never written.
     */
    const { data: mine } = await supabase
      .from("jobs")
      .select("id, scheduled_start, scheduled_end")
      .contains("assigned_to", [uid])
      .in("status", ACTIVE_JOB_STATUSES);
    const myJobs = (mine ?? []) as { id: string; scheduled_start: string | null; scheduled_end: string | null }[];
    if (myJobs.length) {
      // Scheduled today via the segments table (multi-range jobs) …
      const { data: segs } = await supabase
        .from("job_schedule_segments")
        .select("job_id")
        .in("job_id", myJobs.map((j) => j.id))
        .lte("start_date", todayStr)
        .gte("end_date", todayStr);
      const segToday = new Set(((segs ?? []) as { job_id: string }[]).map((s) => s.job_id));
      // … or, for a job with no segment rows at all, across its own scheduled window rather than
      // on its first day only. `todayStr` is already the ORG's day, which is what the window is in.
      for (const j of myJobs) {
        if (segToday.has(j.id)) continue;
        const start = j.scheduled_start ? String(j.scheduled_start).slice(0, 10) : null;
        if (!start) continue;
        const end = j.scheduled_end ? String(j.scheduled_end).slice(0, 10) : start;
        if (start <= todayStr && todayStr <= end) segToday.add(j.id);
      }
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
  /** Offline queue (0167/0168): when the user actually PRESSED the button. Set only by a replay
   *  from the device queue; see resolveOfflinePunchTime for why it's bounded and labelled. */
  offline_pressed_at?: string | null;
  /** Offline queue idempotency key — makes a retried punch exactly-once. */
  clientOpId?: string;
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  /**
   * EXACTLY-ONCE (0167). The DB's one_open_entry index already stops a second OPEN shift, but it
   * reports that as "You're already clocked in." — which is a confusing lie to show someone whose
   * punch actually landed, and it tells the queue the op was rejected. runOnce makes the replay a
   * genuine no-op that returns the original result.
   */
  const { data: profRow } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  return runOnce(
    {
      clientOpId: input.clientOpId,
      action: "time.clockIn",
      orgId: (profRow as { org_id?: string } | null)?.org_id,
      profileId: user.id,
    },
    () => clockInInner(supabase, user.id, input),
  );
}

async function clockInInner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  input: {
    job_id: string | null;
    job_code: string | null;
    gps: GeoPoint | null;
    clock_in_at?: string | null;
    offline_pressed_at?: string | null;
    clientOpId?: string;
  },
): Promise<ClockResult> {
  const user = { id: userId };

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

  /**
   * OFFLINE PUNCH (0168). A tech taps clock-in at 7:02 in a dead zone and the phone reconnects at
   * 11:00. The tech clamp below would round that to ~10:30 and cost him four hours — it exists to
   * stop BACKDATING, and a punch that was made live and merely delivered late is not backdating.
   *
   * Nothing can prove which of the two it is; the device asserts both. So the offline path is
   * BOUNDED (older than a long day → refused, with the office named) and DISCLOSED (source
   * 'offline', visible on the timecard) rather than pretending to verify. A refusal here loses
   * nothing: the queue keeps the punch and shows it as still waiting.
   */
  let offlinePunch = false;
  if (input.offline_pressed_at) {
    const verdict = resolveOfflinePunchTime(input.offline_pressed_at);
    if (!verdict.ok) return { ok: false, error: verdict.reason };
    if (verdict.offline) {
      offlinePunch = true;
      input = { ...input, clock_in_at: verdict.iso };
    }
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
      // The tech round-back clamp is the ANTI-BACKDATING guard. An offline punch already went
      // through resolveOfflinePunchTime, which bounds it and marks it — applying the clamp on top
      // would delete exactly the hours the queue exists to preserve.
      if (!isStaff && !offlinePunch) {
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
    // 'offline' outranks the others: it says the SERVER CLOCK wasn't the authority for this time,
    // which is the fact the office needs when reading the card.
    source: offlinePunch ? "offline" : backdated ? "manual" : input.gps ? "app" : "manual",
  });

  // "You're already clocked in" now lives in dbError's constraint map, not in a string test here.
  // cn-v702 wrapped the ARGUMENT of this test: dbError translates the duplicate-key message into a
  // sentence, that sentence never contains "one_open_entry", so the branch went dead and the most
  // common clock-in failure — tapping Clock In twice at 60mph — started showing the raw Postgres
  // text on the surface whose whole point was to stop doing that.
  if (error) return { ok: false, error: dbError(error) };

  // Clocking into a job means work has started — promote it to in_progress.
  //
  // ON THE SERVICE CLIENT, AND THAT IS THE POINT. `jobs_write` requires is_org_staff(), so on the
  // caller's client this was a zero-row update for every TECH — i.e. for exactly the people who
  // clock into jobs. The comment above it ("never let a blocked update fail the clock-in") had
  // quietly become "this never works for the crew": Brian starts at 7am, the job sits in
  // to_be_scheduled all day, and the office's board is wrong about what is actually being worked.
  //
  // Scoped by hand, because a service client has no RLS to fall back on:
  //   · this exact job id, which the caller just clocked into (visibleJobIdOrNull vetted it above)
  //   · that job's org must be the caller's org
  //   · only from a pre-work status — never un-complete or un-cancel a finished job
  // It writes ONE column on ONE row, and it is the same promotion the office's own clock-in did.
  if (jobId) {
    await promoteJobToInProgress(supabase, jobId);
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
  }

  revalidatePath("/timeclock");
  revalidatePath("/planner");
  return { ok: true };
}

/**
 * PROMOTE A JOB TO in_progress WHEN SOMEBODY STARTS WORKING ON IT.
 *
 * ONE COPY, called by clock-in and by switch-job. The drift between those two copies IS the bug
 * this fixes: clockIn was moved onto the service client in cn-v650 because `jobs_write` requires
 * is_org_staff(), so a TECH's promotion was a zero-row UPDATE that PostgREST reports as success —
 * Brian starts at 7am, the job sits in to_be_scheduled all day, and the office's board is wrong
 * about what is actually being worked. switchJob kept the old broken copy, so the same silent
 * no-op survived on the other path.
 *
 * THE AUTHORIZATION IS THE READ, on the caller's OWN RLS client. No visible row means no org id
 * and nothing is promoted — so the service write can only ever touch a job this person could
 * already see, in their own org. It writes ONE column on ONE row, and never un-completes a
 * finished or cancelled job.
 *
 * Never throws: the punch is the thing that must land.
 */
async function promoteJobToInProgress(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
): Promise<void> {
  try {
    const { data: jobRow } = await supabase.from("jobs").select("org_id").eq("id", jobId).maybeSingle();
    const jobOrg = (jobRow as { org_id?: string } | null)?.org_id;
    if (!jobOrg) return;
    await createServiceClient()
      .from("jobs")
      .update({ status: "in_progress" })
      .eq("id", jobId)
      .eq("org_id", jobOrg)
      .in("status", ACTIVE_JOB_STATUSES.filter((st) => st !== "in_progress"));
  } catch {
    /* the punch already landed — a board that lags is not worth failing it over */
  }
}

export type SwitchJobResult = ClockResult & {
  /** The entry the clock is running on NOW. After a cut it is a new entry; the panel, the job-page
   *  button and the geofence monitor re-key to it. */
  entry_id?: string;
  /** "cut": the running entry was closed and a new one opened; "repointed": the whole entry moved. */
  mode?: "cut" | "repointed";
  /** The running entry's notes after the switch (the new entry starts with none). */
  notes?: string;
  /** Hours on the entry the switch closed (0 on a re-point). */
  closed_hours?: number;
};

/**
 * Mid-shift job switch. A SWITCH IS A CUT (0288 switch_job): the running entry is closed right now
 * and a new entry opens at the same instant on the new job, so the day's split is two ordinary
 * timecard entries with their own clock times, captured as it happens instead of reconstructed at
 * clock-out. Two exceptions, decided by the database: a running entry with NO job (and no code), or
 * one opened under two minutes ago, is RE-POINTED whole instead, because a job-less morning has
 * always billed to the job you switch to and a 28-second piece helps nobody.
 *
 * switch_job runs AS THE CALLER, so RLS and the tech guards judge the close and the open exactly as
 * they judge a clock-out and a clock-in. Self-scoped for a tech; the office may switch anyone in
 * its own company.
 */
export async function switchJob(input: {
  entry_id: string;
  job_id: string;
  job_code?: string | null;
  /** The tech's CURRENT notes text (may hold unsaved typing). It is saved onto the part being
   *  closed, which is where that work happened. */
  notes?: string;
  /** A fix taken AT THE SWITCH: the new part's geofence anchor. Omitted/unusable ⇒ no anchor,
   *  never the old site's centre left armed. */
  gps?: GeoPoint | null;
}): Promise<SwitchJobResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: entry } = await supabase
    .from("time_entries")
    .select("id, org_id, profile_id, job_id, job_code, notes, rate_override, clock_in, split_from, profiles:profile_id(full_name)")
    .eq("id", input.entry_id)
    .eq("status", "open")
    .maybeSingle();
  if (!entry) return { ok: false, error: "No open entry to switch." };

  /**
   * A SWITCH ON A FORGOTTEN CLOCK IS A CLOSE AT NOW (review of 0291, 2026-09-24). In cut mode
   * switch_job (0288) writes clock_out = now() on the running entry, which is the very one-tap
   * mistake clockOut refuses past LONG_SHIFT_HOURS: Brian forgets on job A Tuesday, opens job B's
   * page Wednesday morning, taps Switch, and job A gets a 17-hour shift that payroll pays and the
   * labor import bills. So the switch asks the same question the clock-out does. A re-point (no job
   * and no code yet) closes nothing and moves the whole running shift, so it is left alone.
   */
  // The SHIFT's start (audit v994 SW1): a second switch late in a forgotten day is the same
  // one-tap close at now as the first.
  const shiftSw = await shiftOf(supabase, entry as { id: string; profile_id: string; clock_in: string; split_from?: string | null });
  const ciMs = shiftSw ? shiftSw.startMs : entry.clock_in ? Date.parse(String(entry.clock_in)) : NaN;
  const wouldCut = !!entry.job_id || !!entry.job_code;
  if (wouldCut && isLongOpenShift(ciMs, Date.now())) {
    const tz = await orgTz(supabase);
    const since = dayClock(shiftSw ? shiftSw.startIso : String(entry.clock_in), tz);
    if (entry.profile_id === user.id) {
      return {
        ok: false,
        needsTime: true,
        error: `You've been on the clock since ${since}, ${LONG_SHIFT_PHRASE}. Pick when you stopped on Timeclock, then clock in on this job.`,
      };
    }
    // The office's own door names whose clock it is: "Clock Out Brian" on Timecards.
    const owner = (entry as { profiles?: { full_name?: string | null } | { full_name?: string | null }[] | null }).profiles;
    const ownerName = (Array.isArray(owner) ? owner[0] : owner)?.full_name ?? null;
    return {
      ok: false,
      error: `That clock has been running since ${since}, ${LONG_SHIFT_PHRASE}. ${clockedOutWords(ownerName, false).clockOutVerb} at the time the shift really ended (Timecards, ${clockDoorWords(ownerName).clockOut}), then clock in on this job.`,
    };
  }

  // The new job must be visible to the caller (RLS-scoped): never point an entry at a foreign job.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);
  if (!jobId) return { ok: false, error: "That job isn't available." };
  if (jobId === entry.job_id) return { ok: false, error: "You're already clocked into that job." };

  // The note typed so far belongs to the part being closed. Saved first, own open row, so the
  // close below never strands unsaved typing on a finished entry nobody reopens.
  const typed = (input.notes ?? "").trim();
  if (typed && typed !== (entry.notes ?? "").trim()) {
    await supabase.from("time_entries").update({ notes: typed }).eq("id", entry.id).eq("status", "open");
  }

  // THE ANCHOR MOVES WITH THE JOB. The geofence fences on the entry's gps_in; a switch that left
  // it on site A let the live watch auto-close the shift at the time the tech drove to site B.
  const gps = input.gps;
  const usableFix =
    gps != null &&
    typeof gps.lat === "number" && typeof gps.lng === "number" &&
    Number.isFinite(gps.lat) && Number.isFinite(gps.lng) &&
    (gps.accuracy == null || gps.accuracy <= 200);
  const nowIso = new Date().toISOString();
  const fix = usableFix ? { lat: gps!.lat, lng: gps!.lng, accuracy: gps!.accuracy ?? null, captured_at: nowIso } : null;

  const { data: res, error } = await supabase.rpc("switch_job", {
    p_entry: entry.id,
    p_job_id: jobId,
    p_job_code: input.job_code ?? null,
    p_gps: fix,
  });
  if (error) return { ok: false, error: dbError(error) };
  const r = (res ?? {}) as {
    mode?: "cut" | "repointed";
    entry_id?: string;
    closed_id?: string | null;
    closed_hours?: number;
    rate_left_behind?: boolean;
    /** Minutes of a lunch already on the running row that did not fit the part closing now, so it
     *  moved whole to the new part (0288). */
    lunch_moved?: number;
  };
  if (!r.entry_id) return { ok: false, error: "The switch did not save. Try again." };

  const { data: j } = await supabase.from("jobs").select("job_number, name").eq("id", jobId).maybeSingle();
  const label = j ? jobLabel(j as any) : "another job";
  let notes = "";
  if (r.mode === "repointed") {
    // The whole entry moved. A re-point with no usable fix must not keep the first site's anchor
    // armed (switch_job keeps gps_in when it is handed none), and the breadcrumb is what re-opens
    // adoptGeofenceAnchor's window from the switch rather than from clock-in.
    const base = typed || (entry.notes ?? "").trim();
    notes = base ? `${base}
${switchBreadcrumb(label, nowIso)}` : switchBreadcrumb(label, nowIso);
    await supabase
      .from("time_entries")
      .update({ notes, ...(fix ? {} : { gps_in: null }) })
      .eq("id", r.entry_id)
      .eq("status", "open");
  }

  // PAY DOES NOT MOVE SILENTLY. A tech's own insert may not carry a pay rate (0154), so a special
  // rate the office set on this shift stays on the part before the switch. Said to the tech, and
  // put on the office's bell, which is where it gets fixed.
  const warnings: string[] = [];
  const lunchMoved = Math.max(0, Number(r.lunch_moved) || 0);
  if (lunchMoved > 0) {
    warnings.push(`The ${lunchMoved}-minute lunch on this shift didn't fit the part before the switch, so it moved to this part.`);
  }
  if (r.rate_left_behind) {
    warnings.push("Your special pay rate stays on the part before the switch. The office will set it on this part.");
    try {
      const staff = (await orgStaffIds(String(entry.org_id))).filter((id) => id !== user.id);
      const { data: who } = await supabase.from("profiles").select("full_name").eq("id", entry.profile_id).maybeSingle();
      const name = (who as { full_name?: string | null } | null)?.full_name ?? "A crew member";
      await createNotifications(String(entry.org_id), staff, {
        type: "general",
        title: `${name} switched jobs mid-shift`,
        body: `The pay rate on the first part did not carry to the part on ${label}. Set it on Timecards if it applies.`,
        url: "/timecards",
      });
    } catch {
      /* the warning to the tech above still stands */
    }
  }

  // Switching into a job means work has started there (the shared helper, never the caller's
  // client: for a tech that is a zero-row no-op reported as success).
  await promoteJobToInProgress(supabase, jobId);
  revalidatePath(`/jobs/${jobId}`);
  if (entry.job_id) revalidatePath(`/jobs/${entry.job_id}`);
  revalidatePath("/jobs");
  revalidatePath("/timeclock");
  revalidatePath("/timecards");
  revalidatePath("/planner"); // who's-on-which-job shows on My Day
  return {
    ok: true,
    entry_id: r.entry_id,
    mode: r.mode ?? "cut",
    notes,
    closed_hours: Number(r.closed_hours) || 0,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

/**
 * The caller's OWN closed part that ended when this one began (a Switch Job closes one part and opens
 * the next at the same instant, 0288). paid_at rides along: a paid part never takes a lunch (SW6).
 */
async function touchingPartBefore(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profileId: string,
  clockInIso: string,
): Promise<LunchPart | null> {
  const { data } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, lunch_minutes, paid_at")
    .eq("profile_id", profileId)
    .eq("status", "closed")
    .eq("clock_out", clockInIso)
    .maybeSingle();
  const p = data as LunchPart | null;
  return p?.clock_out ? p : null;
}

/**
 * The SHIFT this running entry is part of (lib/shift-chain): after a Switch Job, its start is the
 * first piece's clock-in. Null for an entry that never switched (no read is made) or when the read
 * fails (reported; the caller falls back to the entry's own start, what it said before).
 */
async function shiftOf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  entry: { id?: string; profile_id?: string | null; clock_in?: string; split_from?: string | null } | null,
): Promise<ShiftInfo | null> {
  if (!entry?.id || !entry.clock_in || !entry.split_from) return null;
  try {
    const chains = await loadShiftChains(
      supabase as unknown as SupabaseClient,
      [{ id: entry.id, profile_id: entry.profile_id ?? null, clock_in: entry.clock_in, split_from: entry.split_from }],
      null,
    );
    return chains.get(entry.id) ?? null;
  } catch (e) {
    reportError("shift-chain", e, { entryId: entry.id });
    return null;
  }
}

export async function clockOut(input: {
  entry_id: string;
  /** Unpaid lunch in minutes. Every clock-out door STATES this now, 0 included (the box
   *  is off by default). null/undefined = an older client that never asked — the open row's
   *  own lunch is then preserved rather than a meal invented. */
  lunch_minutes: number | null;
  notes: string;
  gps: GeoPoint | null;
  auto?: boolean;
  miles?: number;
  at?: string; // explicit clock-out time (ISO) — used by the geofence auto clock-out
  /** THE LUNCH WAS BEFORE THE SWITCH. After a Switch Job the day is two entries (0288); a lunch
   *  taken on the first part goes on it. The caller's own closed entry that ended exactly when
   *  this one began; anything else, or a lunch that does not fit it, lands on this shift instead
   *  and the answer says so. */
  lunch_on_entry_id?: string | null;
  lunch_on_minutes?: number | null;
  /** Set when the SYSTEM closed this shift with nobody answering, so the card says why and the
   *  office's "needs attention" list picks it up (0193's column). Null on every human close. */
  autoClosedReason?: string | null;
  /** The person STATED `at` (the Timeclock long-shift picker, the geofence prompt's picker). A clock
   *  that has run LONG_SHIFT_HOURS closes only at a stated time; see needsStatedStop. */
  picked?: boolean;
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // A clock-out is ONE tap for everyone (Erik's two-button rework): the job was resolved at
  // clock-in, and a day on two jobs is two entries (Switch Job, or a split on Timecards), never a
  // breakdown typed in at the end of it.

  // One self-scoped read of the entry: its clock_in feeds the `at` clamp, and status tells
  // "already closed" from "entry is gone" in the zero-row branch below (audit v921, the projection law).
  const { data: entRow } = await supabase
    .from("time_entries")
    .select("clock_in, lunch_minutes, status, notes, org_id, id, profile_id, split_from")
    .eq("id", input.entry_id)
    .eq("profile_id", user.id)
    .maybeSingle();
  const ent = entRow as {
    id?: string;
    profile_id?: string | null;
    split_from?: string | null;
    clock_in?: string;
    lunch_minutes?: number | null;
    status?: string | null;
    notes?: string | null;
    org_id?: string | null;
  } | null;
  const entClockIn = ent?.clock_in ?? null;

  // Clock-out time defaults to now; `at` (the geofence "time they left") is honored only inside
  // [clock_in + 1 min, now + 1 min]: never negative hours, never a close in the future.
  let clockOutIso = new Date().toISOString();
  if (input.at) {
    const atMs = Date.parse(input.at);
    if (!isNaN(atMs) && atMs <= Date.now() + 60_000) {
      const ciMs = entClockIn ? Date.parse(entClockIn) : 0;
      clockOutIso = new Date(clampCloseAtMs(atMs, ciMs, Date.now())).toISOString();
    }
  }

  /**
   * A FORGOTTEN CLOCK IS NOT CLOSED AT "NOW" BY ONE TAP (Erik, 2026-09-24).
   *
   * Brian clocks in Tuesday at 1:37 PM and forgets. Wednesday morning he taps Clock Out, and the
   * old door wrote a 17-hour shift nobody worked, which the office then had to find and undo by
   * hand before it could invoice the job. Past LONG_SHIFT_HOURS a plain tap is refused with a
   * sentence that sends him to the picker on Timeclock; nothing is written, and his clock keeps
   * running until he says when it stopped. Every door lands here (the panel, My Day, the job page,
   * the geofence prompt, Nort's "clock me out"), so a stale tab or a voice command gets the same
   * answer as the button.
   */
  const ciMsForStop = entClockIn ? Date.parse(entClockIn) : NaN;
  const closeMs = Date.parse(clockOutIso);
  const nowMs = Date.now();
  let lateStop: { tz: string; name: string } | null = null;
  if (ent?.status === "open" && Number.isFinite(ciMsForStop)) {
    const picked = !!input.picked;
    const unattended = !!input.autoClosedReason;
    // THE TWELVE HOURS COUNT FROM THE START OF THE DAY (Erik, 2026-09-24, audit v994 SW1). After a
    // Switch Job the running entry began at the switch; the forgotten-clock question reads the
    // whole shift (lib/shift-chain). The 18-hour ceiling below stays per entry, as the database
    // enforces it.
    const shift = await shiftOf(supabase, ent);
    const shiftStartMs = shift ? shift.startMs : ciMsForStop;
    const shiftStartIso = shift ? shift.startIso : (entClockIn as string);
    if (needsStatedStop({ clockInMs: shiftStartMs, closeMs, nowMs, picked, unattended })) {
      const tz = await orgTz(supabase);
      return {
        ok: false,
        needsTime: true,
        error: `You've been on the clock since ${dayClock(shiftStartIso, tz)}, ${LONG_SHIFT_PHRASE}. Pick when you stopped on Timeclock.`,
      };
    }
    if (!unattended && closeMs - ciMsForStop > MAX_SHIFT_HOURS * 3_600_000) {
      return {
        ok: false,
        error:
          "That's more than 18 hours after you clocked in. Pick when you really stopped. If the shift truly ran that long, the office has to enter it.",
      };
    }
    // A stop time stated after a long run says so on the card, and the office hears about it. Not
    // only a `picked` one: needsStatedStop lets an `at` well before now through as a real time, and
    // a LONG_SHIFT_HOURS-to-18-hour close by a person, however it arrived, must never land without a trace. Only
    // the unattended geofence close is exempt, and auto_closed_reason already flags that one.
    if (!unattended && isLongOpenShift(shiftStartMs, nowMs)) {
      const tz = await orgTz(supabase);
      const { data: me } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
      lateStop = { tz, name: ((me as { full_name?: string | null } | null)?.full_name ?? "").trim() };
    }
  }

  // LUNCH IS OPT-IN (Erik 2026-09-08: "remove the auto deduct 30 min lunch and change it to
  // a checkbox as an option but default to 0"). Nothing is deducted unless somebody says so:
  // the clock-out checkbox now STATES its answer on every punch, including 0.
  //   • stated (including 0) → honored exactly. That is the whole point of the change.
  //   • unstated (an older client, a crafted call with no field) → PRESERVE whatever the open
  //     row already carries, e.g. an office fixEntry "his lunch was 45". Never invent one.
  // NaN (a garbage crafted value) counts as NOT stated — the old `|| 0` coercion, kept.
  const lunchAsked = input.lunch_minutes != null && Number.isFinite(input.lunch_minutes);
  let lunchMinutes = Math.max(
    0,
    lunchAsked ? (input.lunch_minutes as number) : Number(ent?.lunch_minutes) || 0,
  );

  // A LUNCH AFTER A SWITCH JOB LANDS WHERE IT FITS (close-math placeLunch, the one rule the
  // "finish your timecard" prompt uses too). Decided BEFORE anything is written:
  //   - a lunch put on the part before the switch goes there when that part is the touching one,
  //     has room and is not paid (audit v994 SW6: a paid part is frozen); otherwise it lands on
  //     this part and the answer says why;
  //   - THE LUNCH HAS TO FIT THE PART IT LANDS ON. A 30-minute lunch on a 20-minute part deducts
  //     20 (hoursBetween clamps the part at 0), so the day would be paid 10 minutes more than the
  //     lunch anyone stated. A lunch that does not fit here goes on the part before when it fits
  //     there; if it fits neither, nothing is written and the sentence says why. The geofence close
  //     has nobody to ask, so it keeps the old behaviour.
  const priorLunch = Math.max(0, Math.round(Number(input.lunch_on_minutes) || 0));
  let lunchOnPrior: { id: string; lunch: number } | null = null;
  let lunchWarning: string | undefined;
  const wantsPrior = !!input.lunch_on_entry_id && priorLunch > 0;
  if (entClockIn && (wantsPrior || (lunchMinutes > 0 && !lunchFits(entClockIn, clockOutIso, lunchMinutes)))) {
    const prior = await touchingPartBefore(supabase, user.id, entClockIn);
    const placed = placeLunch({
      hereLunch: lunchMinutes,
      priorLunch: wantsPrior ? priorLunch : 0,
      priorId: input.lunch_on_entry_id ?? null,
      here: { clock_in: entClockIn, clock_out: clockOutIso },
      prior,
      refuse: !input.auto,
    });
    if (!placed.ok) return { ok: false, error: `${placed.error} You're still clocked in.` };
    lunchMinutes = placed.here;
    lunchOnPrior = placed.prior;
    lunchWarning = placed.warning;
  }

  // The stop time a person picked after a long run is written on the card in the same UPDATE, so
  // the office can tell it from a live punch.
  const typedNotes = input.notes && input.notes.trim() ? input.notes : null;
  const lateCrumb =
    lateStop && entClockIn
      ? stopCrumb({
          how: "self",
          byName: lateStop.name || "the crew member",
          atIso: new Date(nowMs).toISOString(),
          runningSinceIso: entClockIn,
          newStartIso: null,
          tz: lateStop.tz,
        })
      : null;
  const notesOut = lateCrumb ? withStopCrumb(typedNotes ?? ent?.notes ?? null, lateCrumb) : typedNotes;

  const { data: closedRows, error } = await supabase
    .from("time_entries")
    .update({
      clock_out: clockOutIso,
      lunch_minutes: lunchMinutes,
      // NEVER BLANK WHAT THE SHIFT ALREADY CARRIES (audit v921 high). `input.notes || null`
      // erased the tech's end-of-day note AND switchJob's "[switched to … at …]" breadcrumbs
      // whenever a door closed the shift without re-sending them — the job page's Clock Out and
      // Nort both pass "". The office then reads a blank card, the EOD cron texts the tech to
      // fill in a note they already wrote, and the breadcrumb the office needs to re-derive a
      // split is gone. An empty string means "not supplied", not "delete it".
      ...(notesOut ? { notes: notesOut } : {}),
      gps_out: input.gps,
      status: "closed",
      // 'auto_gps' even when the person PICKED the stop time in the geofence sheet (checked
      // 2026-09-24). Nothing a person reads shows it: the timecard badge names only manual and
      // offline, Nort never reads source. Its one reader is /timeclock's catch-up prompt, which
      // asks the lunch question every geofence close skipped, picked time or not; stamping
      // 'app' would lose that question. And 0248's guard lets a tech's own session move a punch
      // to 'auto_gps' and nothing else. A picked stop past the long-shift line says so in the
      // notes crumb above.
      source: input.auto ? "auto_gps" : undefined,
      // A shift the system closed by itself has to SAY so on the card — a back-dated clock-out
      // that nobody agreed to is exactly the row an office needs to see (audit 6).
      ...(input.autoClosedReason ? { auto_closed_reason: input.autoClosedReason } : {}),
      // Only set miles when the clock-out captured them, so we never overwrite an
      // existing value with 0.
      ...(input.miles != null && input.miles > 0 ? { miles: input.miles } : {}),
    })
    .eq("id", input.entry_id)
    .eq("profile_id", user.id)
    // ONLY AN OPEN ROW MAY BE CLOSED (audit v921). The panel and My Day send an entry id from
    // a server render that can be minutes old: the geofence on his other phone may have closed
    // the shift at 15:00 already. Without this filter a 17:30 tap on the stale screen moved
    // clock_out two and a half hours later, recomputed the lunch and overwrote gps_out on a
    // FINISHED shift — staff and owners skip the DB's "ask the office to correct a finished
    // shift" refusal (0169 runs only for non-staff), so nothing else stopped it.
    .eq("status", "open")
    // And a zero-row UPDATE is a 204, not a success (the silent-write law): if the office
    // removed or reassigned the entry while the panel sat open, this matched nothing and
    // clockOut still returned ok — the tech watched a clean clock-out and had no hours.
    .select("id");

  if (error) {
    // NOBODY GETS LEFT UNABLE TO CLOCK OUT. 0278 put an overlap ceiling under time_entries, and a
    // clock-out is an UPDATE that sets clock_out — so a live shift running across hours the office
    // has already recorded for this person now trips that trigger. Its sentence tells whoever is
    // holding the phone to "edit that entry", and a tech cannot edit entries at all, which is a
    // wall at the end of a working day.
    //
    // Nothing is lost when this happens: the update is refused whole, so the shift is still open
    // with every minute of it on the row. The answer has to SAY that, and name the person who can
    // actually clear the way, instead of handing a man in a truck a database's words.
    const raw = String((error as { message?: unknown } | null)?.message ?? "");
    if (/overlap a shift already recorded/i.test(raw)) {
      return {
        ok: false,
        error:
          "These hours overlap a shift already recorded for you, so this one can't close on top of it. Your shift is still running and nothing was lost. The office has to fix that other entry on Timecards first.",
      };
    }
    return { ok: false, error: dbError(error) };
  }
  if (!closedRows?.length) {
    // Say which failure it is, and refresh the screens so the next tap sees the truth.
    revalidatePath("/timeclock");
    revalidatePath("/planner");
    return {
      ok: false,
      error: ent
        ? "That shift is already closed — pull down to refresh."
        : "That entry is gone — the office may have removed it. Ask them to add the shift.",
    };
  }

  if (lunchOnPrior) {
    // The tech's own finished row: 0143 lets him RAISE a lunch there, never lower it. Never a paid
    // one (SW6): staff skip the database's paid lock, so the filter is the lock here.
    const { data: upd, error: lErr } = await supabase
      .from("time_entries")
      .update({ lunch_minutes: lunchOnPrior.lunch })
      .eq("id", lunchOnPrior.id)
      .eq("status", "closed")
      .is("paid_at", null)
      .select("id");
    if (lErr || !upd?.length) {
      lunchWarning = "You're clocked out, but the lunch didn't save on the part before the switch. Ask the office to add it on Timecards.";
    }
  }

  // The office hears that a stop time was set after the fact: on the bell only, with the shift a tap
  // away. Never fails the clock-out that already landed (createNotifications never throws).
  if (lateStop && entClockIn && ent?.org_id) {
    const name = lateStop.name || "A crew member";
    const first = firstName(name);
    const hours = hoursBetween(entClockIn, clockOutIso, lunchMinutes);
    const staff = (await orgStaffIds(ent.org_id)).filter((id) => id !== user.id);
    await createNotifications(ent.org_id, staff, {
      type: "clock_stopped_late",
      title: `${first} Set His Stop Time Late`,
      body: `${first} was still on the clock from ${shortDayClock(entClockIn, lateStop.tz)} and picked ${clockOnly(clockOutIso, lateStop.tz)} as his stop, ${hours.toFixed(2)} h.`,
      url: `/timecards?entry=${input.entry_id}`,
    });
  }

  revalidatePath("/timeclock");
  revalidatePath("/timecards");
  revalidatePath("/planner"); // clock-in/out status shows on My Day
  return lunchWarning ? { ok: true, warning: lunchWarning } : { ok: true };
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
    // null when the caller didn't mention lunch → the entry keeps whatever lunch it
    // already carries (0 for a normal punch).
    lunch_minutes: input.lunch_minutes ?? null,
    notes: input.notes ?? "",
    gps: null,
    miles: input.miles,
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
    .select("id, clock_in, gps_in, notes, split_how")
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
  //
  // SINCE 0288 A SWITCH IS A CUT (audit v994 SW2): the part after a switch is a NEW entry
  // (split_how 'live') that begins at the switch, and no breadcrumb is written for it (that note is
  // only for a re-point). So a live piece is itself the "after a switch" case, timed from its own
  // clock-in; before this, every cut switch got the 15-minute window and a switch with no fix (every
  // Nort switch) left the fence off for the rest of the day.
  const ciMs = Date.parse((open as { clock_in: string }).clock_in);
  const swMs = lastSwitchMs((open as { notes: string | null }).notes);
  const livePiece = (open as { split_how?: string | null }).split_how === "live";
  const openedAt = Math.max(isNaN(ciMs) ? 0 : ciMs, swMs ?? 0);
  const windowMs =
    livePiece || (swMs != null && swMs >= (isNaN(ciMs) ? 0 : ciMs)) ? ADOPT_AFTER_SWITCH_MS : ADOPT_AFTER_CLOCK_IN_MS;
  if (!openedAt || Date.now() - openedAt > windowMs) {
    return { ok: false, error: "Too long since clock-in to backfill a location." };
  }

  const { data: anchored, error } = await supabase
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
    .eq("status", "open")
    .is("gps_in", null)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  // A zero-row update is a 204, not an anchor (the silent-write law): the shift closed or switched
  // meanwhile, or another tab anchored it first.
  if (!anchored?.length) return { ok: false, error: "That shift changed before the location saved." };
  return { ok: true };
}

/** Geofence clock-out — the GeofenceMonitor calls this when the employee has left the
 *  job site. `atIso` is never a guess: it's either NOW (the "Clock out now" tap), a time
 *  the USER picked in the prompt sheet, or — for the live-watch auto close — the time
 *  GPS last observed them at the site. Clocks out the caller's OPEN entry, stamps the
 *  GPS, and marks the source 'auto_gps' so /timeclock asks the lunch question after the
 *  fact. The entry's note is preserved. */
/**
 * @param unattended  TRUE only when the monitor closed the shift ITSELF, with nobody answering.
 *
 * ── WHY THIS IS A MARK AND NOT A CEILING (audit 6) ──────────────────────────────────────────
 *
 * The reviewer's fix said to put a bound in the database, "where the client cannot bypass it".
 * The principle is right — law 5 — but there is no bound the database can actually compute here.
 * A legitimate geofence close IS back-dated: he left at 15:00, the phone noticed at 15:05, and
 * closing at 15:00 is the CORRECT and conservative answer. The stale-observation bug produces the
 * same shape — a clock_out well before now() — just with a wrong number in it. From inside
 * Postgres, holding only clock_in, the proposed clock_out and now(), the two are indistinguishable,
 * so any ceiling tight enough to catch the bug would refuse real closes.
 *
 * What the database CAN do is refuse to let it pass unnoticed. `auto_closed_reason` (0193) puts
 * the row in the timecards "needs attention" list, where a human who can tell the difference sees
 * it. The actual fix for the wrong number is in the monitor, which is the only place that knows
 * whether its own observation was continuous.
 */
export async function geoClockOut(
  gps: GeoPoint | null,
  atIso: string,
  unattended = false,
  /** The entry the monitor was WATCHING. A Switch Job closes the running entry and opens a new one
   *  (0288), so a leave-site verdict formed against the old entry must not close the new one: when
   *  this is given and is no longer the open entry, nothing happens. */
  watchedEntryId?: string | null,
  /** The person picked `atIso` in the prompt (the geofence sheet's "Pick the time"). Past
   *  LONG_SHIFT_HOURS only a picked time closes the shift; "Clock Out Now" passes false. */
  picked = false,
): Promise<ClockResult> {
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
  if (watchedEntryId && (open as { id: string }).id !== watchedEntryId) {
    // The shift the monitor fenced has already ended (a switch, or a close on another screen).
    // Closing whatever happens to be open now would end a shift nobody left.
    return { ok: false, error: "That shift already ended; nothing was closed." };
  }

  return clockOut({
    entry_id: (open as any).id,
    // A geofence close asks nobody anything, so it states nothing: the entry keeps its own
    // lunch (0 unless the office set one) and /timeclock's catch-up prompt carries the box
    // for the tech to tick after the fact. It may only RAISE it (the 0143 guard).
    lunch_minutes: null,
    notes: (open as any).notes ?? "",
    gps,
    auto: true,
    at: atIso,
    autoClosedReason: unattended
      ? "closed automatically from the last GPS fix at the job site — nobody answered the prompt"
      : null,
    picked,
  });
}

/**
 * Finish a geofence auto-clock-out: the questions the close could not ask, answered after the fact.
 * Self-scoped to the caller's OWN closed entry; the clock times stay LOCKED at the geofence times.
 *
 *   * Lunch: confirmed here (a tech may only RAISE it on a closed shift, the 0143 guard; lowering it
 *     would add paid hours after the fact).
 *   * "I switched at [time] → job": OFFICE ONLY, and only because the owner of the shift is office
 *     too (Erik punches his own clock). It is a split (0288 split_time_entry), which cuts the shift
 *     into two ordinary entries, and after-the-fact splits are office work. A tech's debrief is
 *     lunch only; the office splits his shift on Timecards.
 *
 * Answering stamps AUTO_CONFIRMED_CRUMB onto the notes (every piece, after a split), which is what
 * stops the prompt asking again.
 *
 * AFTER A SWITCH JOB (audit v994 SW3) the auto-closed entry is only the part since the switch, and
 * the day's lunch was usually taken before it. The lunch goes through the clock-out's own rule
 * (close-math placeLunch): on the part before the switch when the person says so (or when it does
 * not fit this part), never on a paid part, raise-only there, and refused in words when it fits
 * neither. Before this the whole lunch landed on a 20-minute last part, which hoursBetween clamps
 * to 0: the day was paid ten minutes nobody worked, and a tech could never lower it again.
 */
export async function completeAutoClockOut(input: {
  entry_id: string;
  lunch_minutes: number;
  /** The lunch was taken on the part before the switch (the touching part that ended when this
   *  one began). Ignored when there is no such part. */
  lunch_on_prior?: boolean;
  /** Staff only: the shift was really two jobs. `at` must fall inside it. */
  switched?: { at: string; job_id: string | null; job_code?: string | null } | null;
}): Promise<ClockResult & { split?: SplitResult }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: entry } = await supabase
    .from("time_entries")
    // lunch_minutes rides along so the debrief can tell whether the confirmed meal CHANGED the
    // shift's hours: the claim warning below needs the before figure (the projection law).
    .select("id, clock_in, clock_out, job_id, lunch_minutes, notes")
    .eq("id", input.entry_id)
    .eq("profile_id", user.id)
    .eq("status", "closed")
    .maybeSingle();
  if (!entry) return { ok: false, error: "Entry not found." };
  const lunch = Math.max(0, Math.round(Number(input.lunch_minutes) || 0));
  const existingHere = Math.max(0, Number(entry.lunch_minutes) || 0);

  // WHERE THE LUNCH LANDS, decided before anything is written (the one rule, close-math).
  let hereLunch = lunch;
  let priorWrite: { id: string; lunch: number } | null = null;
  let priorBefore: LunchPart | null = null;
  let lunchWarning: string | undefined;
  const onPrior = !!input.lunch_on_prior && lunch > 0;
  // Only a lunch being STATED here is placed: a lunch the part already carried (a Switch Job moved it
  // there) is its own business, and re-placing it could put it on both parts.
  if (entry.clock_out && (onPrior || (lunch > existingHere && !lunchFits(entry.clock_in, entry.clock_out, lunch)))) {
    priorBefore = await touchingPartBefore(supabase, user.id, entry.clock_in);
    const placed = placeLunch({
      hereLunch: onPrior ? 0 : lunch,
      priorLunch: onPrior ? lunch : 0,
      priorId: priorBefore?.id ?? null,
      here: { clock_in: entry.clock_in, clock_out: entry.clock_out },
      prior: priorBefore,
      refuse: true,
    });
    if (!placed.ok) return { ok: false, error: `${placed.error} Nothing was changed.` };
    priorWrite = placed.prior;
    lunchWarning = placed.warning;
    // The lunch went on the part before: this part keeps what it already carries.
    hereLunch = placed.here > 0 ? placed.here : existingHere;
  }

  const claims = await claimsOnSources(supabase, priorWrite ? [input.entry_id, priorWrite.id] : [input.entry_id]);
  if ("error" in claims) return { ok: false, error: claims.error };

  // A split is decided BEFORE anything is written, so a refusal leaves the shift as it was.
  let splitPlan: { at: string; lunchOn: "left" | "right"; jobId: string | null; jobCode: string | null } | null = null;
  if (input.switched) {
    const ctx = await requireStaff();
    if ("error" in ctx) return { ok: false, error: "The office splits a shift after it ends. Tell them when you switched." };
    const jobId = input.switched.job_id ? await visibleJobIdOrNull(supabase, input.switched.job_id) : null;
    const jobCode = (input.switched.job_code ?? "").trim() || null;
    if (!jobId && !jobCode) return { ok: false, error: "Pick the job you switched to." };
    const preview = splitPreview(
      { clock_in: entry.clock_in, clock_out: entry.clock_out, status: "closed", lunch_minutes: hereLunch },
      input.switched.at,
    );
    // THE LUNCH LANDS WHERE IT FITS: the longer part by default, the other part if it only fits
    // there. If it fits neither, the split cannot be made with that lunch, and the answer says so
    // rather than guessing a lunch nobody stated.
    let lunchOn = preview.lunchOn;
    if (!preview.ok && hereLunch > 0) {
      const other = splitPreview(
        { clock_in: entry.clock_in, clock_out: entry.clock_out, status: "closed", lunch_minutes: hereLunch },
        input.switched.at,
        preview.lunchOn === "left" ? "right" : "left",
      );
      if (other.ok) lunchOn = other.lunchOn;
      else return { ok: false, error: preview.problem ?? other.problem ?? "That split time doesn't fit this shift." };
    } else if (!preview.ok) {
      return { ok: false, error: preview.problem ?? "That split time doesn't fit this shift." };
    }
    splitPlan = { at: preview.at, lunchOn, jobId, jobCode };
  }

  // The part before the switch first: if it refuses, nothing has been written and the prompt stays.
  // Raise-only (placeLunch never goes below what it carries), never a paid part, the caller's own row.
  if (priorWrite) {
    const { data: priorUpd, error: priorErr } = await supabase
      .from("time_entries")
      .update({ lunch_minutes: priorWrite.lunch })
      .eq("id", priorWrite.id)
      .eq("profile_id", user.id)
      .eq("status", "closed")
      .is("paid_at", null)
      .select("id");
    if (priorErr || !priorUpd?.length) {
      return {
        ok: false,
        error: priorErr
          ? dbError(priorErr)
          : "The part before the switch didn't take the lunch (it may have just been paid). Nothing was changed; reload and try again.",
      };
    }
  }

  const { data: lunchUpd, error: lunchErr } = await supabase
    .from("time_entries")
    .update({ lunch_minutes: hereLunch, notes: withAutoConfirmedCrumb(entry.notes) })
    .eq("id", input.entry_id)
    .select("id");
  // A zero-row update is a 204, not a success (the silent-write law): without this, a confirmed
  // meal that never landed still reported ok and the shift stayed paid gross.
  if (lunchErr || !lunchUpd?.length) {
    return {
      ok: false,
      error: priorWrite
        ? `The lunch is saved on the part before the switch, but this shift didn't take the answer. ${lunchErr ? dbError(lunchErr) : "Reload and try again."}`
        : lunchErr
          ? dbError(lunchErr)
          : "That shift didn't take the lunch — reload and try again.",
    };
  }

  let split: SplitResult | undefined;
  if (splitPlan) {
    const res = await splitTimeEntry({
      entry_id: input.entry_id,
      at: splitPlan.at,
      job_id: splitPlan.jobId,
      job_code: splitPlan.jobCode,
      lunch_on: splitPlan.lunchOn,
    });
    if (!res.ok) {
      // The lunch is saved and stands; only the split did not happen, and the sentence says so.
      return { ok: false, error: `Saved the lunch, but the shift was not split. ${res.error ?? ""}`.trim() };
    }
    split = res;
    // The new part holds the clock-out, so it is the row the prompt would find next: it carries
    // the answer too.
    if (res.right_id) {
      await supabase.from("time_entries").update({ notes: withAutoConfirmedCrumb(null) }).eq("id", res.right_id);
    }
  }

  if (entry.job_id) revalidatePath(`/jobs/${entry.job_id}`);
  if (splitPlan?.jobId) revalidatePath(`/jobs/${splitPlan.jobId}`);
  revalidatePath("/timeclock");
  revalidatePath("/timecards");
  revalidatePath("/planner"); // auto clock-out changes who's on the clock on My Day
  // The confirmed lunch can TRIM what an invoice already bills (the office invoices from the truck
  // at the end of the day, before the tech debriefs). The trim is right and it stands, but the
  // invoice keeps its old figure, so the answer says which invoice and both numbers.
  const holder = claims.get(input.entry_id);
  const closed = !!entry.clock_in && !!entry.clock_out;
  const hoursWere = closed ? hoursBetween(entry.clock_in, entry.clock_out as string, Number(entry.lunch_minutes) || 0) : null;
  const hoursNow = closed ? hoursBetween(entry.clock_in, entry.clock_out as string, hereLunch) : null;
  const warnings: string[] = [];
  if (lunchWarning) warnings.push(lunchWarning);
  if (holder && hoursWere != null && hoursNow != null && Math.abs(hoursWere - hoursNow) >= 0.01) {
    warnings.push(billedPartMoved(holder, hoursWere, hoursNow));
  }
  // The part before the switch can be billed too: its trim is said the same way.
  const priorHolder = priorWrite ? claims.get(priorWrite.id) : null;
  if (priorWrite && priorHolder && priorBefore?.clock_out) {
    const was = hoursBetween(priorBefore.clock_in, priorBefore.clock_out, Number(priorBefore.lunch_minutes) || 0);
    const now = hoursBetween(priorBefore.clock_in, priorBefore.clock_out, priorWrite.lunch);
    if (Math.abs(was - now) >= 0.01) warnings.push(billedPartMoved(priorHolder, was, now));
  }
  if (priorWrite) revalidatePath("/timecards");
  if (split?.warning) warnings.push(split.warning);
  return { ok: true, ...(split ? { split } : {}), ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

/**
 * ONE PERSON, TWO SHIFTS OVER THE SAME HOURS, IS ONE SHIFT PAID TWICE.
 *
 * aggregatePayrollEntries (payroll-math.ts) buckets time_entries by profile_id and sums every row
 * it is handed. No identity check, no overlap check, and nothing above it has one either — so two
 * rows describing one afternoon are earned twice, owed twice and paid twice, and the man writing
 * the cheque has nothing on screen telling him so. Brian has an identical 1.5h pair on Aug 18
 * sitting unpaid in the ledger right now; that pair alone is $60 of his Owed figure.
 *
 * cn-v959 built this exact test — but INSIDE the copy button, because that is the door somebody
 * happened to file a bug about. Add Entry and the edit modal write the same table with the same
 * consequence and had no check of any kind. So the test lives here now and all three doors call
 * it: one rule, one wording, and the next door that writes a shift has it already waiting.
 *
 * 0278 puts the same rule under the database, which is where it stops being a convention and
 * becomes a boundary. This layer is not the boundary — it exists so the office reads a sentence
 * naming the shift the way the timecard shows it, instead of a Postgres exception.
 *
 * Returns the sentence to refuse with, or null when the hours are clear.
 */
async function overlapRefusal(
  supabase: SupabaseClient,
  profileId: string,
  startMs: number,
  endMs: number,
  opts?: {
    /** The row being edited or copied — it is allowed to overlap itself. */
    excludeId?: string;
    /** Already in the caller's hand (the copy reads both to name its target); else read here. */
    name?: string;
    tz?: string;
    /** A copy onto the SAME person: the exact match it finds IS the original, so say that. */
    samePerson?: boolean;
  },
): Promise<string | null> {
  if (!profileId || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  // 0217 caps a shift at 18 hours, so a day back catches every entry that could still be running
  // into this one.
  const { data: near, error: nearErr } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out")
    .eq("profile_id", profileId)
    .gte("clock_in", new Date(startMs - 24 * 3_600_000).toISOString())
    .lte("clock_in", new Date(endMs).toISOString())
    .limit(100);
  // A FAILED READ IS NOT A CLEAR DAY. Waving the write through on the one occasion the check could
  // not be made is how the pair in the ledger got there; 0278 would still refuse it, but the
  // office would be reading the database's words instead of ours.
  if (nearErr) return dbError(nearErr);

  const rows = ((near ?? []) as { id: string; clock_in: string; clock_out: string | null }[]).filter(
    (r) => r.id !== opts?.excludeId && Number.isFinite(new Date(r.clock_in).getTime()),
  );
  // An OPEN entry has no end, so it counts as running until now — a man still clocked in cannot
  // also have worked these hours somewhere else.
  const endOf = (r: { clock_out: string | null }) => (r.clock_out ? new Date(r.clock_out).getTime() : Date.now());
  const exact = rows.find((r) => new Date(r.clock_in).getTime() === startMs && r.clock_out != null && endOf(r) === endMs);
  const clash =
    exact ??
    rows.find((r) => {
      const s = new Date(r.clock_in).getTime();
      const e = endOf(r);
      // A MINUTE OF SLACK — the same tolerance 0248 uses and 0278 enforces underneath. Clocking
      // out and straight back in on the next job is the most ordinary move of the day, and the
      // second or two of overlap a double tap leaves behind is not a double shift.
      return s < endMs && e > startMs && Math.min(e, endMs) - Math.max(s, startMs) > 60_000;
    });
  if (!clash) return null;

  // Only now, with something to actually say, pay for the two reads the sentence needs.
  let fullName: string | null = opts?.name ?? null;
  if (!fullName) {
    const { data: p } = await supabase.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
    fullName = (p as { full_name?: string | null } | null)?.full_name ?? null;
  }
  const name = fullName || "That person";
  let tz = opts?.tz;
  if (!tz) {
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
  }

  if (exact) {
    const when = shiftWhen(new Date(startMs).toISOString(), new Date(endMs).toISOString(), tz);
    return opts?.samePerson
      ? `${name} already has ${when}. Pick the person who worked it with them, or edit that entry.`
      : `${name} already has ${when} on another entry. Open that one to change it.`;
  }
  // An open shift has no finish to name, so it gets its start instead of a made-up one.
  const startedAt = shiftWhen(clash.clock_in, clash.clock_in, tz).split(" to ")[0];
  return clash.clock_out
    ? `${name} is already on the clock ${shiftWhen(clash.clock_in, clash.clock_out, tz)}, so these hours would be counted twice. Edit that entry instead.`
    : `${name} has been clocked in since ${startedAt}, so these hours would be counted twice. ${clockedOutWords(fullName, false).clockOutFirst}: tap their shift on Timecards and use ${clockDoorWords(fullName).clockOut}.`;
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
  /** Unpaid lunch minutes. null/undefined = none stated ⇒ 0 (lunch is opt-in since
   *  2026-09-08); an explicit number from the checkbox or a Nort correction is honored. */
  lunch_minutes?: number | null;
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
  let spanWarning: string | undefined;
  // Lunch: whatever was stated, otherwise none. Nothing here infers a meal from the span.
  const lunchMin = Math.max(0, Number(input.lunch_minutes) || 0);
  if ((!clockIn || !clockOut) && input.work_date && input.hours != null) {
    if (!(input.hours > 0 && input.hours <= 24)) return { ok: false, error: "Hours must be between 0 and 24." };
    // Center the span on midday in the ORG tz; add the unpaid lunch to the span so the
    // net paid hours come out exactly as stated (payroll deducts lunch from the span).
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
    const plan = durationSpan({ workDate: input.work_date, hours: input.hours, lunchMin, tz, nowMs: Date.now() });
    if (!plan.ok) return { ok: false, error: plan.error };
    clockIn = plan.clockIn;
    clockOut = plan.clockOut;
    spanWarning = plan.warning;
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

  // THE EASIEST WAY IN THE APP TO PAY FOR ONE AFTERNOON TWICE was this button: Add Entry wrote a
  // second row for a person who already had those hours and said nothing, because nothing here
  // ever looked. The office reaches for it when it should be EDITING the row that exists.
  const overlaps = await overlapRefusal(supabase, profileId, ci.getTime(), co.getTime());
  if (overlaps) return { ok: false, error: overlaps };

  // Drop a job_id the caller can't see (e.g. a crafted voice/registry call) — never
  // persist a cross-org job reference.
  const jobId = await visibleJobIdOrNull(supabase, input.job_id);

  const { data: made, error } = await supabase.from("time_entries").insert({
    profile_id: profileId,
    job_id: jobId,
    job_code: input.job_code,
    clock_in: ci.toISOString(),
    clock_out: co.toISOString(),
    lunch_minutes: lunchMin,
    notes: notes || null,
    miles: input.miles ?? 0,
    rate_override: input.rate_override ?? null,
    status: "closed",
    source: "manual",
  }).select("id");
  if (error) return { ok: false, error: dbError(error) };
  // The silent-write law: an insert that comes back with no row wrote nothing, and this door was
  // reporting that as a saved shift. Hours that never landed are hours nobody gets paid for.
  if (!made?.length) return { ok: false, error: "Those hours didn't save. Reload and try again." };

  revalidatePath("/timeclock");
  revalidatePath("/timecards");
  revalidatePath("/planner"); // a manual entry changes hours on My Day
  if (jobId) {
    // The entry is billable labor on this job — refresh its Time tab + labor totals
    // so "Create invoice" sees it immediately.
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath("/jobs");
  }
  return spanWarning ? { ok: true, warning: spanWarning } : { ok: true };
}

/**
 * CLOCK OUT FOR THEM: the office closes somebody's RUNNING shift at the time it really stopped.
 *
 * Erik, 2026-09-24: "Brian did it the other day too and I had no way to stop it to set the time for
 * the invoice". Brian clocked in on Herringbone at 1:37 PM and forgot. The office could see the
 * clock running on Timecards and on the job, and the only doors it had either refused an open row
 * or closed it at "now", which would have billed the customer for the night. Erik fixed the times
 * by hand a day later, and the invoice waited on it.
 *
 * This is the one door that stops a clock at a STATED time, for every caller: the office's sheet
 * (Clock Out Brian, on an ordinary shift or a forgotten one; 2026-09-24 Erik
 * asked for "an option to [end] an employees time clock and clock out for them" at any time),
 * updateTimeEntry on an open row (the editor, Nort's time.fixEntry, a crafted call), all
 * land here and get the same bounds, the same card crumb and the same message to the crew member.
 *
 *   * bounds (stopProblem): after the start, not in the future, at most 18 hours, lunch shorter than
 *     the shift. 0291 refuses a future close under this for every session caller.
 *   * the row must still be OPEN when the write lands (.eq status open): a clock stopped a moment
 *     ago on his phone is not stopped twice, and the answer says so rather than claiming success.
 *   * the card says who stopped it and when (stopCrumb), and the person whose clock it was is told,
 *     on the bell and by push, with the times it now reads.
 */
export async function stopShift(input: {
  entry_id: string;
  clock_out: string;
  /** A corrected start ("he really started at noon"). Omitted: the stored clock-in stands. */
  clock_in?: string;
  lunch_minutes: number;
  job_id?: string | null;
  job_code?: string | null;
  notes?: string;
  miles?: number;
  rate_override?: number | null;
}): Promise<ClockResult & { hours?: number; sentence?: string; still_open_entry_id?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  /**
   * SWITCHED, NOT CLOCKED OUT (audit v994 SW4). Since 0288 a Switch Job closes the running entry and
   * opens the next, so the office's sheet, opened on the old entry, finds it closed (or loses the race
   * to the switch) while the person is still on the clock on the new job. Telling the office "he was
   * already clocked out" there made them walk away from a clock that was still running. So a closed
   * entry is checked against the same person's OPEN one, and the answer names the switch and hands
   * back that entry's id for the sheet to open, pre-filled, never applied.
   */
  const stillOpen = async (profileId: string, orgId: string, fullName: string, isSelf: boolean, tz: string) => {
    const { data: next } = await supabase
      .from("time_entries")
      .select("id, clock_in, job_code, job:job_id(job_number, name)")
      .eq("profile_id", profileId)
      .eq("org_id", orgId)
      .eq("status", "open")
      .maybeSingle();
    const n = next as { id?: string; clock_in?: string; job_code?: string | null; job?: unknown } | null;
    if (!n?.id || !n.clock_in) return null;
    const j = (Array.isArray(n.job) ? n.job[0] : n.job) as { job_number?: string | null; name?: string | null } | null;
    const where = j ? jobLabel(j) : n.job_code || "another job";
    const w = clockedOutWords(fullName, isSelf);
    const is = isSelf ? "are" : "is";
    return {
      ok: false as const,
      still_open_entry_id: n.id,
      error: `${w.subject} switched to ${where} at ${dayClock(n.clock_in, tz)} and ${is} still on the clock. Nothing was changed. Open that shift to ${clockDoorWords(fullName, { self: isSelf }).clockOut}.`,
    };
  };

  const { data: row } = await supabase
    .from("time_entries")
    .select("id, profile_id, org_id, clock_in, clock_out, status, job_id, notes, paid_at, profiles:profile_id(full_name), job:job_id(job_number, name)")
    .eq("id", input.entry_id)
    .maybeSingle();
  const stored = row as {
    id: string;
    profile_id: string;
    org_id: string;
    clock_in: string;
    clock_out: string | null;
    status: string;
    job_id: string | null;
    notes: string | null;
    profiles?: { full_name?: string | null } | { full_name?: string | null }[] | null;
    job?: { job_number?: string | null; name?: string | null } | { job_number?: string | null; name?: string | null }[] | null;
  } | null;
  if (!stored) return { ok: false, error: "Entry not found." };
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const ownerFull = (one(stored.profiles)?.full_name ?? "").trim();
  const ownerName = ownerFull || "That person";
  const self = stored.profile_id === ctx.userId;
  const said = clockedOutWords(ownerFull, self);
  const tz = await orgTz(supabase);
  if (stored.status !== "open") {
    const moved = await stillOpen(stored.profile_id, stored.org_id, ownerFull, self, tz);
    if (moved) return moved;
    return {
      ok: false,
      error: stored.clock_out
        ? `${said.subject} ${said.was} already clocked out at ${dayClock(stored.clock_out, tz)}. Reload to see the times.`
        : `${said.subject} ${said.was} already clocked out. Reload to see the times.`,
    };
  }

  const startIso = input.clock_in ?? stored.clock_in;
  const startMs = Date.parse(startIso);
  const stopMs = Date.parse(input.clock_out);
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return { ok: false, error: "Pick the time the shift stopped." };
  const lunch = Math.max(0, Math.round(Number(input.lunch_minutes) || 0));
  const problem = stopProblem({ startMs, stopMs, nowMs: Date.now(), lunchMin: lunch, who: "he", tz });
  if (problem) return { ok: false, error: problem };

  const overlaps = await overlapRefusal(supabase, stored.profile_id, startMs, stopMs, { excludeId: stored.id, name: ownerName, tz });
  if (overlaps) return { ok: false, error: overlaps };

  // A job the caller cannot see never lands on the row (a crafted id, a foreign org).
  let jobId: string | null | undefined = undefined;
  if (input.job_id !== undefined) {
    jobId = input.job_id ? await visibleJobIdOrNull(supabase, input.job_id) : null;
    if (input.job_id && !jobId) return { ok: false, error: "That job isn't available." };
  }

  const { data: actor } = await supabase.from("profiles").select("full_name").eq("id", ctx.userId).maybeSingle();
  const actorFull = ((actor as { full_name?: string | null } | null)?.full_name ?? "").trim();
  const actorName = actorFull || "The office";
  const startOut = new Date(startMs).toISOString();
  const stopOut = new Date(stopMs).toISOString();
  const notes = withStopCrumb(
    input.notes !== undefined ? input.notes : stored.notes,
    stopCrumb({
      how: "office",
      byName: actorName,
      atIso: new Date().toISOString(),
      runningSinceIso: stored.clock_in,
      newStartIso: input.clock_in ? startOut : null,
      tz,
    }),
  );

  // Field-presence rules mirror updateTimeEntry: a field the caller did not send is not touched.
  const patch: Record<string, unknown> = {
    clock_in: startOut,
    clock_out: stopOut,
    lunch_minutes: lunch,
    status: "closed",
    notes,
    auto_closed_reason: null,
  };
  if (jobId !== undefined) patch.job_id = jobId;
  if (input.job_code !== undefined) patch.job_code = input.job_code;
  if (input.miles !== undefined) patch.miles = input.miles ?? 0;
  // 0286 still applies underneath: a pay rate on an owner's shift is refused by the database.
  if (input.rate_override !== undefined) patch.rate_override = input.rate_override;

  const { data: upd, error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", stored.id)
    .eq("status", "open")
    .select("id");
  if (error) {
    const raw = String((error as { message?: unknown } | null)?.message ?? "");
    if (/overlap a shift already recorded/i.test(raw)) {
      const again = await overlapRefusal(supabase, stored.profile_id, startMs, stopMs, { excludeId: stored.id, name: ownerName, tz });
      if (again) return { ok: false, error: again };
    }
    return { ok: false, error: dbError(error) };
  }
  // The silent-write law: zero rows means somebody else stopped it first. Nothing here was saved.
  if (!upd?.length) {
    revalidateTime([stored.job_id]);
    const moved = await stillOpen(stored.profile_id, stored.org_id, ownerFull, self, tz);
    if (moved) return moved;
    return { ok: false, error: `${said.subject} ${said.was} clocked out a moment ago somewhere else. Reload to see it.` };
  }

  const hours = hoursBetween(startOut, stopOut, lunch);
  const job = one(stored.job);
  const newJobLabel =
    jobId !== undefined && jobId !== stored.job_id
      ? jobId
        ? await (async () => {
            const { data: j } = await supabase.from("jobs").select("job_number, name").eq("id", jobId).maybeSingle();
            return j ? jobLabel(j as { job_number?: string | null; name?: string | null }) : null;
          })()
        : null
      : job
        ? jobLabel(job)
        : null;
  const when = `${dayOnly(startOut, tz)}, ${clockOnly(startOut, tz)} to ${clockOnly(stopOut, tz)}`;
  // "5.00 h on Herringbone, Mon Jan 1, 12:00 PM to 5:00 PM": the facts every line below names.
  const facts = `${hours.toFixed(2)} h${newJobLabel ? ` on ${newJobLabel}` : ""}, ${when}`;

  if (!self) {
    // The actor's own name when the office has one; a profile with no name reads "The office".
    const actorFirst = actorFull ? firstName(actorFull) : "The office";
    const tellWho = actorFull ? actorFirst : "the office";
    const title = "You're Clocked Out";
    const body =
      `${actorFirst} clocked you out at ${clockOnly(stopOut, tz)}: ${facts}, ${lunch > 0 ? `${lunch} min lunch` : "no lunch"}. ` +
      `If that is wrong, tell ${tellWho}.`;
    // Both are best-effort by construction (they never throw); allSettled keeps it that way even if
    // that changes, so a push outage can never make a stopped clock look unstopped.
    await Promise.allSettled([
      createNotifications(stored.org_id, [stored.profile_id], { type: "clock_stopped", title, body, url: "/timeclock" }),
      sendPushToProfiles([stored.profile_id], "clock_out", { title, body, url: "/timeclock" }),
    ]);
  }

  revalidateTime([stored.job_id, typeof jobId === "string" ? jobId : null]);
  revalidatePath("/payroll");

  // Erik, 2026-09-24: "Brian is Clocked Out". The deed first, in his words, then the facts.
  const sentence = self ? `${said.headline}: ${facts}.` : `${said.headline}: ${facts}. ${said.told}`;
  return { ok: true, hours, sentence };
}

/**
 * Fix a RUNNING shift's job, code or notes without stopping it. The office sees Brian clocked into
 * the wrong job at 9 AM; stopping and restarting his clock would cut his day in two for nothing.
 * Patches only those fields, and only while the row is still open.
 */
export async function updateOpenEntry(input: {
  id: string;
  job_id?: string | null;
  job_code?: string | null;
  notes?: string;
}): Promise<ClockResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: prev } = await supabase.from("time_entries").select("job_id, status").eq("id", input.id).maybeSingle();
  const before = prev as { job_id: string | null; status: string } | null;
  if (!before) return { ok: false, error: "Entry not found." };

  const patch: Record<string, unknown> = {};
  if (input.job_id !== undefined) {
    const jobId = input.job_id ? await visibleJobIdOrNull(supabase, input.job_id) : null;
    if (input.job_id && !jobId) return { ok: false, error: "That job isn't available." };
    patch.job_id = jobId;
  }
  if (input.job_code !== undefined) patch.job_code = input.job_code;
  if (input.notes !== undefined) patch.notes = input.notes.trim() ? input.notes : null;
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing changed to save." };

  const { data: upd, error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", input.id)
    .eq("status", "open")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!upd?.length) {
    revalidateTime([before.job_id]);
    return { ok: false, error: "That clock isn't running any more. Reload." };
  }
  revalidateTime([before.job_id, typeof patch.job_id === "string" ? patch.job_id : null]);
  revalidatePath("/payroll");
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
  // (A shift split across jobs is two entries now: splitTimeEntry, 0288. This door edits one.)
}): Promise<ClockResult & { hours?: number; sentence?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  /**
   * A RUNNING CLOCK IS STOPPED BY stopShift, NOT EDITED (2026-09-24). This door used to write
   * status 'closed' onto whatever it was handed, so Nort's time.fixEntry ("close Brian's open entry
   * at 5") or a crafted call closed a live shift with none of the stop's bounds, no line on the card
   * saying who did it, and nobody telling Brian. Now every close of an open row goes through the one
   * door, and a hand-over to somebody else waits until the clock is stopped.
   */
  //
  // One stored-row fetch, first: its status decides which door this is. It also carries the
  // previous job (so a reassign can refresh BOTH job pages' Time tab + labor totals) plus the
  // pay-relevant fields and the two payroll locks. A base-paid entry (paid_at) freezes clock
  // in/out, lunch, rate and person; a mileage-settled entry (mileage_paid_at) freezes miles — for
  // EVERY caller (modal, registry, voice, crafted; no bypass param), because the payroll_runs
  // snapshot the accountant exports must keep matching the live entries. Undo the period on
  // /payroll, fix the entry, re-mark — that records a truthful new run instead of silently
  // diverging the books.
  const { data: prev } = await supabase
    .from("time_entries")
    .select("job_id, clock_in, clock_out, lunch_minutes, rate_override, profile_id, miles, paid_at, mileage_paid_at, auto_closed_reason, status, split_from, profiles:profile_id(full_name)")
    .eq("id", input.id)
    .maybeSingle();
  const stored = prev as {
    split_from?: string | null;
    profiles?: { full_name?: string | null } | { full_name?: string | null }[] | null;
    job_id: string | null;
    clock_in: string;
    clock_out: string | null;
    lunch_minutes: number | null;
    rate_override: number | null;
    profile_id: string;
    miles: number | null;
    paid_at: string | null;
    mileage_paid_at: string | null;
    auto_closed_reason: string | null;
    status: string | null;
  } | null;
  if (!stored) return { ok: false, error: "Entry not found." };

  if (stored.status === "open") {
    if (input.profile_id && input.profile_id !== stored.profile_id) {
      const owner = Array.isArray(stored.profiles) ? stored.profiles[0] : stored.profiles;
      return { ok: false, error: `${clockedOutWords(owner?.full_name, stored.profile_id === ctx.userId).clockOutFirst}, then move the shift to someone else.` };
    }
    return stopShift({
      entry_id: input.id,
      clock_in: input.clock_in,
      clock_out: input.clock_out,
      lunch_minutes: input.lunch_minutes,
      job_id: input.job_id,
      job_code: input.job_code,
      notes: input.notes,
      miles: input.miles,
      rate_override: input.rate_override,
    });
  }

  /**
   * A SPLIT SHIFT IS ONE PERSON'S (audit v994 SW7; 0319 refuses it underneath). Handing one piece
   * of a split shift (or its first entry) to somebody else left one "Split from one shift" bracket
   * across two people, with no Join Back and no Move The Split. Said here first, in the same words.
   */
  if (input.profile_id && input.profile_id !== stored.profile_id) {
    let splitShift = !!stored.split_from;
    if (!splitShift) {
      const { data: kids, error: kidsErr } = await supabase.from("time_entries").select("id").eq("split_from", input.id).limit(1);
      if (kidsErr) return { ok: false, error: dbError(kidsErr) };
      splitShift = !!kids?.length;
    }
    if (splitShift) {
      return { ok: false, error: "This shift was split into parts. Join the split back first, then move the shift to someone else." };
    }
  }

  const ci = new Date(input.clock_in);
  const co = new Date(input.clock_out);
  if (isNaN(ci.getTime()) || isNaN(co.getTime())) {
    return { ok: false, error: "Invalid date/time." };
  }
  if (co <= ci) return { ok: false, error: "End must be after start." };

  const patch: Record<string, unknown> = {
    // The office just LOOKED at this entry — the "system closed this by itself" flag has done
    // its job and comes off, or the Needs-attention strip grows forever (audit 7).
    auto_closed_reason: null,
    clock_in: ci.toISOString(),
    clock_out: co.toISOString(),
    lunch_minutes: input.lunch_minutes || 0,
    job_code: input.job_code,
    notes: input.notes || null,
    status: "closed",
  };
  // Only touch miles when the caller sent the field (mirrors job_id/rate_override): a
  // surface whose projection omits miles — or an edit that only changes a description —
  // must not silently zero a settled-or-unsettled mileage figure the tech earned.
  if (input.miles !== undefined) patch.miles = input.miles ?? 0;
  // Only touch job_id when the caller sent the field, so older callers that omit
  // it don't accidentally null out an entry's job. `null` explicitly clears it.
  if (input.job_id !== undefined) patch.job_id = input.job_id;
  if (input.profile_id) patch.profile_id = input.profile_id;
  // Only set rate_override when the caller sent the field (mirrors createManualEntry),
  // so older callers that omit it never wipe an existing supervisor rate. `null` clears it.
  if (input.rate_override !== undefined) patch.rate_override = input.rate_override;

  // Lunch on this door is EXACTLY what the office typed (Erik 2026-09-08 — lunch is opt-in
  // now, so 0 is a real answer). The old auto floor here quietly raised a typed 0 back to 30
  // on any shift over five hours, which is the very thing being removed; the office minutes
  // field on the edit modal is the one place a 45- or 60-minute lunch gets recorded.
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
  if (stored.mileage_paid_at && input.miles !== undefined && Math.abs((input.miles ?? 0) - Number(stored.miles ?? 0)) > 0.001) {
    return { ok: false, error: "Entry's mileage is settled — Undo on Payroll first." };
  }

  // AND A SHIFT MUST NOT BE MOVED ON TOP OF ANOTHER ONE. This door can change both ends of the
  // span AND hand the entry to a different person (input.profile_id), so a correction here lands
  // hours on somebody's week just as surely as Add Entry does, and it never once looked to see
  // whether they already had them.
  //
  // Gated on something ACTUALLY MOVING, which is 0217's lesson and 0278's: seven overlapping rows
  // are already in the ledger, and a note, job, mileage or split fix on one of them has to save
  // untouched — otherwise the guard traps the very rows it was built to let Erik sort out. Pulling
  // one of them clear of the other is a move, and it passes, because the new span is clean.
  const targetProfileId = input.profile_id || stored.profile_id;
  const movedOrReassigned =
    timeMoved(ci.toISOString(), stored.clock_in) ||
    timeMoved(co.toISOString(), stored.clock_out) ||
    targetProfileId !== stored.profile_id;
  if (movedOrReassigned) {
    const overlaps = await overlapRefusal(supabase, targetProfileId, ci.getTime(), co.getTime(), { excludeId: input.id });
    if (overlaps) return { ok: false, error: overlaps };
  }

  // THE INVOICE THAT BILLED THIS SHIFT KEEPS ITS CLAIM (0255). A labor line claims the entry ids it
  // billed, and the importers skip a claimed id. Read up front, so any refusal happens before a
  // single write:
  //   • a claimed entry may not move to another job (its hours went out on THIS job's invoice);
  //     0288's time_entries_billed_job_stays refuses the same thing under this, for every caller;
  //   • its hours MAY change (a typo is a typo), and the answer names the invoice and both figures.
  const claims = await claimsOnSources(supabase, [input.id]);
  if ("error" in claims) return { ok: false, error: claims.error };
  const billedBy = claims.get(input.id) ?? null;
  const hoursBefore = stored.clock_out ? hoursBetween(stored.clock_in, stored.clock_out, stored.lunch_minutes ?? 0) : null;
  const hoursAfter = hoursBetween(input.clock_in, input.clock_out, input.lunch_minutes || 0);
  const billedHoursMoved = !!billedBy && hoursBefore != null && Math.abs(hoursBefore - hoursAfter) >= 0.01;
  if (input.job_id !== undefined && (input.job_id ?? null) !== (oldJobId ?? null) && billedBy) {
    return { ok: false, error: claimedMoveRefusal(billedBy) };
  }

  const { data: entryUpd, error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", input.id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  // The silent-write law: a zero-row update is a 204, not a saved edit.
  if (!entryUpd?.length) return { ok: false, error: "That entry didn't take the edit — reload and try again." };

  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // an office hours/job edit changes My Day's totals + crew board
  if (input.job_id !== undefined) {
    for (const jid of new Set([oldJobId, input.job_id].filter(Boolean) as string[])) {
      revalidatePath(`/jobs/${jid}`);
    }
    revalidatePath("/jobs");
  }

  const warnings: string[] = [];
  if (billedHoursMoved && billedBy) {
    const fmt = (h: number) => `${(Math.round(h * 100) / 100).toString()} h`;
    warnings.push(
      `${billedBy.invoice_number ?? "An invoice"} billed this shift at ${fmt(hoursBefore ?? 0)} — it now reads ${fmt(hoursAfter)}. The invoice keeps its figure; adjust it by hand if the customer should pay for the difference.`,
    );
  }
  return warnings.length ? { ok: true, warning: warnings.join(" ") } : { ok: true };
}

// ── A SPLIT IS A CUT (0288) ────────────────────────────────────────────────────────────────────
//
// Erik, 2026-09-24: "i think it will be better if a shift is split to create multiple timecard
// entries instead of trying to do this complicated thing whatever it is it doesnt work very well".
//
// Three office verbs over the database functions that enforce every money law themselves (a split
// cannot create hours: worked seconds are asserted equal; a same-job part inherits the claim; a
// cross-job cut of a shift a live invoice bills is refused and names that invoice; pay, paid day
// and miles do not move). These wrappers only resolve the job the caller can see, turn the answer
// into sentences, and refresh the screens.

export type SplitResult = ClockResult & {
  left_id?: string;
  right_id?: string;
  left_hours?: number;
  right_hours?: number;
  /** The invoices whose claim the new part now carries (same-job split of a billed shift). */
  carried?: { invoice_id: string; invoice_number: string | null; status: string }[];
  /** A refusal because an invoice bills the shift: where to go to take it off. */
  invoiceHref?: string;
};

/** Pull the P0001 "invoice:<uuid>" detail split_time_entry attaches to its cross-job refusal. */
function invoiceHrefFrom(err: unknown): string | undefined {
  const detail = String((err as { details?: unknown } | null)?.details ?? "");
  const m = /^invoice:([0-9a-f-]{36})$/i.exec(detail.trim());
  return m ? `/billing/${m[1]}` : undefined;
}

async function jobIdsOf(supabase: SupabaseClient, ids: string[]): Promise<string[]> {
  const { data } = await supabase.from("time_entries").select("job_id").in("id", ids);
  return [...new Set(((data ?? []) as { job_id: string | null }[]).map((r) => r.job_id).filter(Boolean) as string[])];
}

function revalidateTime(jobIds: (string | null | undefined)[]) {
  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  revalidatePath("/planner");
  const ids = [...new Set(jobIds.filter(Boolean) as string[])];
  for (const jid of ids) revalidatePath(`/jobs/${jid}`);
  if (ids.length) revalidatePath("/jobs");
}

/**
 * Split This Shift: ONE cut of a closed entry at a clock time. The entry keeps its id as the first
 * part (every claim, note and payroll link that names it still names the start of the shift); the
 * second part is a new, ordinary entry on the job (or time code) picked for it. Office only.
 */
export async function splitTimeEntry(input: {
  entry_id: string;
  at: string;
  job_id: string | null;
  job_code?: string | null;
  lunch_on?: "left" | "right" | null;
  miles_on?: "left" | "right" | null;
}): Promise<SplitResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const atMs = Date.parse(input.at);
  if (!Number.isFinite(atMs)) return { ok: false, error: "Pick a split time inside the shift." };
  // A job the caller cannot see is refused, never quietly dropped to "no job": the hours would
  // land nowhere.
  let jobId: string | null = null;
  if (input.job_id) {
    jobId = await visibleJobIdOrNull(supabase, input.job_id);
    if (!jobId) return { ok: false, error: "That job isn't available." };
  }
  const jobCode = (input.job_code ?? "").trim() || null;
  if (!jobId && !jobCode) return { ok: false, error: "Pick a job or a time code for the new part." };

  const { data, error } = await supabase.rpc("split_time_entry", {
    p_entry: input.entry_id,
    p_at: new Date(atMs).toISOString(),
    p_right_job: jobId,
    p_right_code: jobCode,
    p_lunch_on: input.lunch_on ?? null,
    p_miles_on: input.miles_on ?? null,
  });
  if (error) {
    const href = invoiceHrefFrom(error);
    return { ok: false, error: dbError(error), ...(href ? { invoiceHref: href } : {}) };
  }
  const r = (data ?? {}) as {
    left_id?: string;
    right_id?: string;
    left_hours?: number;
    right_hours?: number;
    carried?: { invoice_id: string; invoice_number: string | null; status: string }[];
  };
  if (!r.right_id) return { ok: false, error: "That split didn't save. Reload and try again." };
  revalidateTime([...(await jobIdsOf(supabase, [input.entry_id])), jobId]);
  // NOTHING SILENT: a billed shift split on its own job hands its claim to the new part (it carries
  // hours that invoice already bills), and the office is told which invoice.
  // A void invoice bills nothing; it carries the id only so an un-void can never bill it twice, and
  // naming it here as "already bills" would be false.
  const carried = r.carried ?? [];
  const billing = carried.filter((c) => c.status !== "void");
  const warning = billing.length
    ? `${billing.map((c) => c.invoice_number ?? "An invoice").join(", ")} already ${billing.length === 1 ? "bills" : "bill"} this shift, so the new part carries that claim and will not be billed again.`
    : undefined;
  return {
    ok: true,
    left_id: r.left_id,
    right_id: r.right_id,
    left_hours: Number(r.left_hours) || 0,
    right_hours: Number(r.right_hours) || 0,
    carried,
    ...(warning ? { warning } : {}),
  };
}

/**
 * THE CLAIM ON A SHIFT, BEFORE ANYONE SPLITS IT. The split sheet says up front which invoice bills
 * this shift (a part on the same job carries that claim; a part on another job is refused), instead
 * of the office learning it from a toast after the sheet has closed. Office only; read-only.
 */
export async function shiftClaim(entryId: string): Promise<{ ok: true; holder: ClaimHolder | null } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error ?? "This action is staff-only.") };
  const claims = await claimsOnSources(ctx.supabase, [entryId]);
  if ("error" in claims) return { ok: false, error: claims.error };
  const h = claims.get(entryId);
  return { ok: true, holder: h ? { id: h.id, invoice_number: h.invoice_number } : null };
}

/**
 * Join Back Into One Shift, and the Undo after a split: two touching parts of one person's shift
 * become the first one again. The database refuses it unless both parts are billed by the same
 * lines (or neither), paid the same way and at the same rate. Office only.
 */
export async function joinTimeEntries(input: { left_id: string; right_id: string }): Promise<ClockResult & { kept_id?: string; hours?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const jobs = await jobIdsOf(supabase, [input.left_id, input.right_id]);
  const { data, error } = await supabase.rpc("join_time_entries", { p_left: input.left_id, p_right: input.right_id });
  if (error) return { ok: false, error: dbError(error) };
  const r = (data ?? {}) as { kept_id?: string; hours?: number };
  if (!r.kept_id) return { ok: false, error: "Those parts didn't join. Reload and try again." };
  revalidateTime(jobs);
  return { ok: true, kept_id: r.kept_id, hours: Number(r.hours) || 0 };
}

/**
 * Move The Split: slide the time where one part ends and the next begins. Never reorders. Allowed
 * on billed parts when both parts are billed by the same lines (a typo is a typo: 0261's C7 rule),
 * and the answer names every invoice whose part changed length, because that invoice keeps the
 * figure it went out with. Between parts billed differently the database refuses it (0288): the
 * moved hours would become billable a second time. Office only.
 */
export async function moveTimeEntryCut(input: {
  left_id: string;
  right_id: string;
  at: string;
}): Promise<ClockResult & { left_hours?: number; right_hours?: number; invoiceHref?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const atMs = Date.parse(input.at);
  if (!Number.isFinite(atMs)) return { ok: false, error: "Pick a time for the split." };
  const { data, error } = await supabase.rpc("move_time_entry_cut", {
    p_left: input.left_id,
    p_right: input.right_id,
    p_at: new Date(atMs).toISOString(),
  });
  if (error) {
    const href = invoiceHrefFrom(error);
    return { ok: false, error: dbError(error), ...(href ? { invoiceHref: href } : {}) };
  }
  const r = (data ?? {}) as {
    moved?: boolean;
    left_hours?: number;
    right_hours?: number;
    billed?: { invoice_id: string; invoice_number: string | null; hours_before: number; hours_after: number }[];
  };
  revalidateTime(await jobIdsOf(supabase, [input.left_id, input.right_id]));
  const warnings = (r.billed ?? []).map((b) =>
    billedPartMoved({ id: b.invoice_id, invoice_number: b.invoice_number }, Number(b.hours_before) || 0, Number(b.hours_after) || 0),
  );
  return {
    ok: true,
    left_hours: Number(r.left_hours) || 0,
    right_hours: Number(r.right_hours) || 0,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

/**
 * Which non-void invoice bills each of these source rows (time_entry ids), via
 * invoice_items.source_ids (0255). The EARLIEST claimant wins a contested id, matching foldClaims.
 * Tolerates 0255 not being applied yet (a push deploys before its migration runs): with no
 * source_ids column there are no labor claims to protect, so the answer is "none" — while any
 * OTHER failure refuses, because editing blind is how a claim gets lost.
 */
async function claimsOnSources(supabase: SupabaseClient, ids: string[]): Promise<ClaimIndex | { error: string }> {
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("invoice_items")
    .select("source_ids, invoices!inner(id, invoice_number, status, created_at)")
    .overlaps("source_ids", ids)
    .neq("invoices.status", "void");
  if (error) {
    const code = String((error as { code?: string })?.code ?? "");
    const msg = String((error as { message?: string })?.message ?? "");
    if (code === "42703" || /source_ids/i.test(msg) || /does not exist/i.test(msg)) return new Map();
    reportError("claimsOnSources", error, { ids });
    return { error: "Couldn't check which invoice bills this shift — nothing was changed. Try again in a moment." };
  }
  const wanted = new Set(ids);
  const out = new Map<string, ClaimHolder & { created_at: string }>();
  for (const row of (data ?? []) as { source_ids?: string[] | null; invoices?: unknown }[]) {
    const raw = row.invoices;
    const inv = (Array.isArray(raw) ? raw[0] : raw) as { id: string; invoice_number: string | null; created_at: string } | undefined;
    if (!inv) continue;
    for (const sid of row.source_ids ?? []) {
      if (!wanted.has(sid)) continue;
      const cur = out.get(sid);
      if (!cur || inv.created_at < cur.created_at) out.set(sid, { id: inv.id, invoice_number: inv.invoice_number ?? null, created_at: inv.created_at });
    }
  }
  return out;
}

export async function deleteTimeEntry(id: string): Promise<ClockResult> {
  const supabase = await createClient();
  // Payroll locks: a base-paid or mileage-settled entry backs a payroll_runs
  // snapshot the accountant exports — deleting it would silently diverge the
  // books. No bypass for any caller: Undo the period on /payroll first.
  const { data: locked } = await supabase
    .from("time_entries")
    .select("paid_at, mileage_paid_at, job_id")
    .eq("id", id)
    .maybeSingle();
  const lock = locked as { paid_at: string | null; mileage_paid_at: string | null; job_id: string | null } | null;
  if (lock?.paid_at) return { ok: false, error: "Entry is in a paid period — Undo on Payroll first." };
  if (lock?.mileage_paid_at) return { ok: false, error: "Entry's mileage is settled — Undo on Payroll first." };

  // AN INVOICE THAT BILLED THIS SHIFT HOLDS IT (0255). A labor line's claim (invoice_items.source_ids)
  // names the entry: with the row gone the invoice would bill hours that no longer exist on the
  // timecard, and payroll and billing would disagree with no record of why. 0261 refuses it under
  // this; here the office reads which invoice to void or adjust first.
  const claims = await claimsOnSources(supabase, [id]);
  if ("error" in claims) return { ok: false, error: claims.error };
  const holders = [...new Map([...claims.values()].map((h) => [h.id, h] as const)).values()];
  if (holders.length) {
    const numbers = holders.map((h) => h.invoice_number ?? "an invoice");
    const list = numbers.length === 1 ? numbers[0] : `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
    return {
      ok: false,
      error: `${list} ${holders.length === 1 ? "bills" : "bill"} this shift — void or adjust ${holders.length === 1 ? "it" : "them"} first. Nothing was changed.`,
    };
  }

  // The silent-write law: a delete that hits zero rows (a cross-org or already-gone id) is a 204,
  // not a deleted entry.
  const { data: gone, error } = await supabase.from("time_entries").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: "That entry didn't delete — reload and try again." };
  if (lock?.job_id) revalidatePath(`/jobs/${lock.job_id}`); // the job's Time tab and its unbilled total
  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // a deleted entry changes My Day's hours/clock state
  return { ok: true };
}

/** "Thursday Sep 17, 11:00 AM to 9:00 PM" in the ORG's day (days are org-local, never the
 *  UTC server's), for the sentence a copy answers with. */
function shiftWhen(clockIn: string, clockOut: string, tz: string): string {
  const a = new Date(clockIn);
  const b = new Date(clockOut);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return "";
  // ICU puts a narrow no-break space before AM/PM; normalize it so the sentence reads,
  // copies and compares as plain text.
  const at = (d: Date) =>
    d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
  const weekday = a.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const monthDay = a.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  return `${weekday} ${monthDay}, ${at(a)} to ${at(b)}`;
}

// ── the words a stopped clock is described in, always in the ORG's clock ──
/** The org's timezone through the caller's own client (RLS scopes it to their org). */
async function orgTz(supabase: SupabaseClient): Promise<string> {
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
}
/** "1:37 PM" */
function clockOnly(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}
/** "Tue Sep 22" */
function dayOnly(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const wd = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const md = d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  return `${wd} ${md}`;
}
/** "Tue Sep 22, 1:37 PM" */
function dayClock(iso: string, tz: string): string {
  return `${dayOnly(iso, tz)}, ${clockOnly(iso, tz)}`;
}
/** "Tue 1:37 PM" */
function shortDayClock(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${clockOnly(iso, tz)}`;
}
function firstName(full: string | null | undefined): string {
  const f = (full ?? "").trim().split(/\s+/)[0];
  return f || "They";
}

/**
 * THE COPY IS FOR SOMEBODY (Erik, 2026-09-18): "I'm supposed to be able to copy this time card
 * for jimmy who worked with me."
 *
 * This copied a finished entry onto THE SAME PERSON, which is the one write the sanity trigger
 * (0217) can never accept: a byte-identical second shift for one profile. So the control refused
 * every time it was tapped, correctly, and could not succeed at anything. Two men on one job for
 * the same hours is the most ordinary day in this trade, so the copy now takes a TARGET and the
 * shift lands on whoever worked it too.
 *
 * `targetProfileId` is optional and defaults to the same person, so the old one-argument shape
 * still means what it meant. The identical-times rule still protects whoever the copy lands ON.
 * It just no longer refuses because the SOURCE person has those hours, which was the false
 * refusal. Open entries still can't be copied.
 */
export async function duplicateTimeEntry(
  id: string,
  targetProfileId?: string | null,
): Promise<ClockResult & { message?: string }> {
  // STAFF ONLY. This is the one tech-reachable path that INSERTS a closed entry — and it
  // copies rate_override — so an unguarded version let a member clone their own paid shift
  // (or a supervisor-rate one) as many times as they liked. It's an office convenience
  // anyway; the DB insert guard (0154) enforces the same rule at the write boundary.
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: e, error: readErr } = await supabase
    .from("time_entries")
    .select("profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, notes, status, rate_override")
    .eq("id", id)
    .single();
  if (readErr || !e) return { ok: false, error: readErr?.message ?? "Entry not found." };
  if (e.status !== "closed" || !e.clock_out) {
    return { ok: false, error: "Clock out the entry before duplicating it." };
  }
  const clockIn = String(e.clock_in);
  const clockOut = String(e.clock_out);
  const startMs = new Date(clockIn).getTime();
  const endMs = new Date(clockOut).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, error: "That entry's times can't be read, so there's nothing to copy." };
  }

  // Whoever was named, else the same person.
  const sourceId = String(e.profile_id);
  const targetId = (targetProfileId ?? "").trim() || sourceId;
  const samePerson = targetId === sourceId;

  // The target has to be someone the caller can actually see — RLS scopes this read to the
  // org, so an id from another tenant reads as "not on this crew" — and has to be NAMED,
  // because every sentence below says who the copy went to.
  const { data: targetRow } = await supabase
    .from("profiles")
    .select("id, full_name, active")
    .eq("id", targetId)
    .maybeSingle();
  const target = targetRow as { id: string; full_name: string | null; active: boolean | null } | null;
  if (!target) return { ok: false, error: "That person isn't on this crew." };
  const name = target.full_name ?? "That person";
  if (target.active === false) {
    return { ok: false, error: `${name} isn't active anymore, so hours can't be added for them.` };
  }

  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
  const when = shiftWhen(clockIn, clockOut, tz);

  // THE GUARD FOLLOWS THE PERSON THE COPY LANDS ON. 0217 refuses a byte-identical second shift per
  // profile, which is right — and is exactly why the old one-tap, same-person duplicate could
  // never succeed at anything. The test itself now lives in overlapRefusal, because Add Entry and
  // the edit modal write the same table with the same consequence and had no check at all; this
  // door keeps its own wording only for the same-person case, where the row it finds IS the
  // original and the honest answer is to point at the person picker.
  const overlaps = await overlapRefusal(supabase, targetId, startMs, endMs, { name, tz, samePerson });
  if (overlaps) return { ok: false, error: overlaps };

  const { data: made, error } = await supabase
    .from("time_entries")
    .insert({
      profile_id: targetId,
      clock_in: clockIn,
      clock_out: clockOut,
      lunch_minutes: e.lunch_minutes,
      // Miles and the pay-rate override belong to the person who earned them. Another man's
      // mileage was never driven by this one (0095 keeps mileage human-stated), and a
      // supervisor rate is not his pay. A copy onto the SAME person still carries both —
      // dropping the override there silently paid base rate (the cn-v291 wage-bug family).
      miles: samePerson ? e.miles : 0,
      job_id: e.job_id,
      job_code: e.job_code,
      notes: e.notes,
      rate_override: samePerson ? (e.rate_override ?? null) : null,
      status: "closed",
      source: "manual",
    })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  // The silent-write law: an insert that comes back with no row wrote nothing.
  if (!made?.length) return { ok: false, error: "That copy didn't save. Reload and try again." };

  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  revalidatePath("/planner"); // a copied entry changes My Day's hours + crew board
  // The copy is billable labor on that job — refresh its Time tab and unbilled total.
  if (e.job_id) revalidatePath(`/jobs/${e.job_id}`);

  // What stayed behind is said out loud, once, and only when there was something to leave.
  const dropped = samePerson
    ? []
    : [e.rate_override != null ? "rate override" : null, Number(e.miles) > 0 ? "miles" : null].filter(
        (x): x is string => !!x,
      );
  const warning = dropped.length
    ? `The ${dropped.join(" and ")} stayed on the original. Add ${dropped.length > 1 ? "them" : "it"} to ${name}'s entry if ${dropped.length > 1 ? "they apply" : "it applies"}.`
    : undefined;
  return { ok: true, message: `Copied to ${name}, ${when}.`, ...(warning ? { warning } : {}) };
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
  if (error) return { ok: false, error: dbError(error) };
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
 * day summary built from their own time_entries ("GPS tells the story:
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

  // GPS summary — the caller's own day: entries that STARTED today (a split day is several
  // entries, one job each), total net hours, miles, first arrival / last departure, hours per job.
  const { data: entries } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, lunch_minutes, miles, job_id, status")
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
    const key = e.job_id ?? "";
    perJob.set(key, (perJob.get(key) ?? 0) + h);
  }
  // Labels for the jobs touched today (one RLS-scoped lookup).
  const jobIds = [...perJob.keys()].filter(Boolean);
  const labelMap = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobRows } = await supabase.from("jobs").select("id, job_number, name").in("id", jobIds);
    for (const j of (jobRows ?? []) as { id: string; job_number: string | null; name: string | null }[]) {
      // jobLabel IS the SSOT for this, and always was — the old hand-rolled
      // `[job_number, name].join(" · ")` here was wrong twice over. It printed the
      // jobLabelWithNumber shape ("J-017 · Smith panel"), which that file reserves for
      // printed documents and exports somebody reconciles against, and Erik has said
      // three times that a screen label is the job NAME, not J-xxx. The comment that
      // used to sit here justified the fork by claiming jobLabel would render
      // "undefined · x" on a half-filled row; it would not — jobLabel is
      // `name || num || "Job"`, null-safe, and it never joins anything.
      // This label is FROZEN into gps_summary at file time, so every report filed with
      // the old code keeps the old shape until somebody backfills the JSON. Cheap
      // today: daily_reports is still empty (no profile has crew_lead = true).
      labelMap.set(j.id, jobLabel(j));
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
  if (error) return { ok: false, error: dbError(error) };

  // Tell the office — bell (always works) + push, suppressing the filer.
  // The deep link is "/planner": NO DEAD ENDS — the Daily Reports card (with the
  // filed→reviewed check-off and the GPS day story) lives on My Day since cn-v958,
  // so a tap on this bell has to land there and not on the payroll page it left.
  const staff = (await orgStaffIds(me.org_id)).filter((id) => id !== user.id);
  const name = me.full_name ?? "the crew";
  const payload = {
    title: `Daily report from ${name}`,
    body: (did || mats).split("\n")[0].slice(0, 140),
    url: "/planner",
  };
  await createNotifications(me.org_id, staff, { type: "daily_report", ...payload });
  await sendPushToProfiles(staff, "daily_report", payload);

  revalidatePath("/planner"); // THE Daily Reports card — the only page that renders a report
  return { ok: true, summary };
}

/**
 * Office review: flip a daily report filed → reviewed (the second half of 0128's
 * `status` design — "filed for office editing"). Staff-only; RLS (daily_reports_update:
 * own-or-staff, org-scoped) backstops the guard. Reviewed rows stay visible on My Day's
 * Daily Reports card (the review list since cn-v958), just checked off — so the ONE path
 * to revalidate is /planner. Revalidating it is not optional: a card that still shows
 * "Mark Reviewed" after the tap is a silent write in the user's eyes.
 */
export async function markDailyReportReviewed(id: string): Promise<ClockResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  // Checked write (the silent-write law): RLS refusing this row is a zero-row UPDATE with a
  // 200 and no error, and the button would toast "Report marked reviewed" over nothing.
  const { data: hit, error } = await ctx.supabase
    .from("daily_reports")
    .update({ status: "reviewed" })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!hit) return { ok: false, error: "That report isn't there any more — My Day is catching up." };
  revalidatePath("/planner"); // the Daily Reports card's reviewed badge + the "N to review" count
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
