"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { pushCalendarItem } from "@/lib/calendar-sync";
import { notifyJobCrewAdded } from "@/lib/crew-notify";
import { requireStaff } from "@/lib/staff-guard";
import { JOB_STATUSES } from "@/lib/job-status";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { todayStrInTz, tzDateTimeUtc, tzDayStartUtc, tzMinutesOfDay } from "@/lib/tz";
import { addDaySegment, shiftSegmentCovering } from "@/lib/schedule-math";
import { rescheduleAppointment } from "../appointments/actions";
import {
  fitIntoDay,
  hmToMinutes,
  minutesToHm,
  PINNED_TO_TOP,
  type Busy,
} from "@/lib/schedule/fit-day";
import {
  appointmentTypeFor,
  daysNeeded,
  spanEnd,
  WORK_DAY_MINUTES,
  workingDaysFrom,
} from "@/lib/schedule/work-shape";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Result = { ok: boolean; error?: string; id?: string };

// Work-day window the scheduler blocks off for a dated (all-day) job: the org's
// work_day_start/work_day_end (Settings → Scheduling), via workDayWindowHm —
// which keeps the original 8 AM–4 PM block for an org that never saved a window.

/** The org's IANA timezone (default America/Los_Angeles). Server actions run in
 *  UTC, so any "8 AM local" instant must be built against this — never via a
 *  bare `new Date("…T08:00")`, which the server parses as UTC. */
async function orgTimezone(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((data as any)?.settings).timezone;
}

/** Timezone + the all-day work window ("HH:MM" start/end), ONE settings query —
 *  the schedule-writer bundle. */
async function orgSchedulePrefs(
  supabase: SupabaseClient,
): Promise<{ tz: string; dayStartHm: string; dayEndHm: string }> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const raw = (data as any)?.settings;
  const win = workDayWindowHm(raw);
  return { tz: getOrgSettings(raw).timezone, dayStartHm: win.start, dayEndHm: win.end };
}

/** The stored scheduled_start's wall-clock "HH:MM" in the org timezone, or null.
 *  Lets a day-move preserve an explicit start time instead of snapping back to
 *  the all-day default. A time that reads exactly as the all-day window start
 *  (allDayHm — the org's work_day_start, default 08:00) is treated as "no
 *  explicit time" — the same convention the calendar uses to decide whether to
 *  render a time at all. */
function localHmInTz(iso: string | null, tz: string, allDayHm: string): string | null {
  if (!iso) return null;
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return hm === allDayHm ? null : hm;
}

/** Advance an early-stage job to "scheduled" once it has a date — without ever
 *  downgrading a job that's already further along (in_progress, complete, …).
 *  The conditional `.in()` means non-early jobs are simply left untouched. */
async function advanceToScheduled(supabase: SupabaseClient, id: string): Promise<void> {
  // BUG FIX (lifecycle rework): this used to filter on ["lead","quoted","estimate"] — the
  // first two were never job_status enum values, so the promotion could error out silently
  // (the call is fire-and-forget). The waiting room is to_be_scheduled; a date promotes it.
  await supabase
    .from("jobs")
    .update({ status: "scheduled" })
    .eq("id", id)
    .in("status", ["to_be_scheduled", "estimate"]);
}

export async function createJob(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const start = String(formData.get("scheduled_start") ?? "");
  const address = emptyToNull(formData.get("address"));

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
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  // Fragment-first: a bare address (or just a customer) is a valid start — never
  // make the caller invent a name. Default: address → customer's name → dated stub.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && address) name = address;
  if (!name && customerId) {
    if (newCustomerName) {
      name = newCustomerName;
    } else {
      const { data: cust } = await supabase.from("customers").select("name").eq("id", customerId).maybeSingle();
      name = String(cust?.name ?? "").trim();
    }
  }
  if (!name) {
    const tz = await orgTimezone(supabase); // org-local date, not the server's UTC day
    const day = new Date(`${todayStrInTz(tz)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    name = `New job — ${day}`;
  }

  // In Progress is the default (Erik 2026-07): when he creates a job by hand he's usually
  // already working it — "estimate" as a default just parked real work in a dead bucket.
  // Validate against the job-status spine so a caller can't write a retired enum value
  // ("estimate"/"invoiced") or garbage — anything off-spine lands as in_progress.
  const rawStatus = String(formData.get("status") ?? "").trim();
  const status = (JOB_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : "in_progress";

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      name,
      customer_id: customerId,
      description: emptyToNull(formData.get("description")),
      status,
      billing_type: String(formData.get("billing_type") ?? "tm"), // T&M is the default now (Estimate); switch to fixed per job
      address,
      // The parts the picker resolved. A fixed form is no help if the insert has nowhere to put
      // them — same shape updateJob has used all along (jobs/actions.ts:396-398).
      unit: emptyToNull(formData.get("unit")),
      city: emptyToNull(formData.get("city")),
      state: emptyToNull(formData.get("state")),
      zip: emptyToNull(formData.get("zip")),
      scheduled_start: start ? new Date(start).toISOString() : null,
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbError(error) };

  // Live Google push (fire-safe: never throws, no-op when not connected).
  if (start) await pushCalendarItem("job", data.id);

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  return { ok: true, id: data.id };
}

// setJobStatus lived here as an UNGUARDED copy (no requireStaff / no status whitelist) — the job-page
// status dropdown imported THIS one, silently bypassing the guard on the canonical jobs/actions copy.
// Removed to kill the name-collision footgun; the single caller now imports the guarded jobs/actions one
// (which revalidates /schedule + /planner so the calendar stays fresh).

/** Assign a job to a single employee (or clear). */
export async function setJobAssignee(
  id: string,
  employeeId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const ids = employeeId ? [employeeId] : [];
  // Read the OLD crew first so the write can be diffed — a newly ADDED member gets
  // the bell + "assigned" push (never the caller, never on removal).
  const { data: prev } = await supabase
    .from("jobs")
    .select("assigned_to, org_id, job_number, name")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabase
    .from("jobs")
    .update({ assigned_to: ids })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  if (prev) {
    const p = prev as { assigned_to: string[] | null; org_id: string | null; job_number: string | null; name: string | null };
    // Awaited: an un-awaited promise in a serverless action can be dropped when the
    // function freezes after returning — the bell/push would silently vanish. The helper
    // try/catches internally, so awaiting can never fail the assignment itself.
    await notifyJobCrewAdded({ id, org_id: p.org_id, job_number: p.job_number, name: p.name }, p.assigned_to, ids, ctx.userId);
  }
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

/** Set a job's FULL crew (multi-assign). The picker sends the complete desired set, so ticking a
 *  SECOND person ADDS them instead of replacing — the "put both me and Brian on it" fix. This is the
 *  #1 item from both the audit and Nort's self-review: the old single-Select silently overwrote the
 *  crew to one person. De-duped; empty = unassigned. Same guards/revalidation as setJobAssignee.
 *  Newly ADDED members are notified (bell + push) via the shared diff helper — every caller
 *  (crew picker, /timeclock assignment list, registry verb) gets it for free. */
export async function setJobCrew(id: string, employeeIds: string[]): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const ids = Array.from(new Set((employeeIds ?? []).map(String).filter(Boolean)));
  // Old crew first (diff base) — also proves the job is visible to the caller.
  const { data: prev } = await supabase
    .from("jobs")
    .select("assigned_to, org_id, job_number, name")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabase.from("jobs").update({ assigned_to: ids }).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  if (prev) {
    const p = prev as { assigned_to: string[] | null; org_id: string | null; job_number: string | null; name: string | null };
    // Awaited (not `void`): serverless can drop an un-awaited promise after the action
    // returns. The helper never throws, so this can't break the crew write.
    await notifyJobCrewAdded({ id, org_id: p.org_id, job_number: p.job_number, name: p.name }, p.assigned_to, ids, ctx.userId);
  }
  revalidatePath("/schedule");
  revalidatePath("/planner");
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
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const clean = slots
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? ""))
    .map((s) => ({ date: s.date, time: /^\d{2}:\d{2}/.test(s.time ?? "") ? (s.time as string) : "" }))
    .slice(0, 3);
  if (!clean.length) return { ok: false, error: "Pick at least one date." };

  // One pending proposal per job — replace any existing one.
  await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending");

  const { data, error } = await supabase
    .from("schedule_proposals")
    .insert({ job_id: jobId, dates: clean, time_note: timeNote || null, created_by: ctx.userId })
    .select("token")
    .single();
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, token: data.token };
}

export async function cancelScheduleProposal(id: string, jobId: string): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

// setJobSchedule (raw scheduled_start/end writer) is GONE: it never touched
// job_schedule_segments, so the calendar (segments-first) kept drawing a moved
// multi-range job on its old days — the stale-schedule trap. Day moves go
// through moveJobDay/placeJobOnDay below; range edits through setJobScheduleRanges.

export type DateRange = { start: string; end: string }; // yyyy-mm-dd each

/** Canonical writer for a job's schedule as one or more date ranges. Replaces
 *  all segments, and mirrors the overall min start / max end onto
 *  jobs.scheduled_start/end (the org's work-day window, default 8am–4pm local)
 *  so every legacy reader still works.
 *
 *  `startTime` ("HH:MM", optional) refines ONLY the single primary
 *  scheduled_start mirror — a real time-of-day the calendar renders instead of
 *  the all-day window. Segments stay date-only (a time refines the primary start,
 *  not each span). When omitted, any explicit time already on the job is
 *  preserved (so a day-move keeps it) and otherwise the 8 AM default is used. */
export async function setJobScheduleRanges(
  jobId: string,
  ranges: DateRange[],
  startTime?: string | null,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Keep only well-formed ranges; default a missing end to the start.
  const clean = ranges
    .map((r) => ({ start: r.start, end: r.end || r.start }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end))
    .map((r) => (r.end < r.start ? { start: r.start, end: r.start } : r))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Mirror the overall window onto the job FIRST — this is what every legacy
  // reader uses, and it must succeed even if the segments table isn't there.
  // Build the org's work-day window (default 8am–4pm) in the ORG timezone (this
  // runs server-side in UTC, so a bare `new Date("…T08:00")` would store 8am
  // UTC = ~midnight Pacific and disagree with the client-side writers — the
  // root of the "wrong time" bug).
  const { tz, dayStartHm, dayEndHm } = await orgSchedulePrefs(supabase);
  const minStart = clean.length ? clean[0].start : null;
  const maxEnd = clean.length ? clean.reduce((m, r) => (r.end > m ? r.end : m), clean[0].end) : null;

  // Decide the primary start's time-of-day, with THREE distinct intents:
  //  • startTime === undefined (movers, undo, registry verb): PRESERVE whatever
  //    real time the job already carries so a day-move doesn't snap it to 8 AM.
  //  • startTime "HH:MM": use it (an explicit time-of-day the editor set).
  //  • startTime null/"" (the editor cleared the time input): back to all-day.
  let clock: string | null;
  if (/^\d{2}:\d{2}/.test(startTime ?? "")) {
    clock = (startTime as string).slice(0, 5);
  } else if (startTime === undefined && minStart) {
    const { data: prior } = await supabase.from("jobs").select("scheduled_start").eq("id", jobId).maybeSingle();
    clock = localHmInTz((prior as any)?.scheduled_start ?? null, tz, dayStartHm);
  } else {
    clock = null; // explicit clear (null/"") or no start → the all-day default window
  }
  const startIso = minStart ? tzDateTimeUtc(minStart, clock ?? dayStartHm, tz) : null;

  const patch: Record<string, unknown> = {
    scheduled_start: startIso,
    scheduled_end: maxEnd ? tzDateTimeUtc(maxEnd, dayEndHm, tz) : null,
    updated_at: new Date().toISOString(),
  };
  // The mirror update must PROVE it touched a row: an RLS-invisible or nonexistent
  // job matches zero rows (no error), and without this guard we'd fall through to the
  // segment insert below, which org-stamps to the CALLER — writing an orphan segment
  // for a foreign job id. Guarding here (the choke point) covers every caller: the
  // movers, the calendar undo, the schedule control, the registry verb, and a direct
  // server-action POST (audit cn-v328 — the loadJobDaySegments guard only caught the
  // wrappers). See also the belt-and-suspenders note in that audit.
  const { data: upd, error } = await supabase.from("jobs").update(patch).eq("id", jobId).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!upd?.length) return { ok: false, error: "Job not found." };
  // A scheduled date advances early-stage status (consistent with the other writers).
  if (minStart) await advanceToScheduled(supabase, jobId);

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

  // Live Google push — THE choke point covers every schedule writer (movers,
  // tray place, undo, registry verb, schedule control). Fire-safe: a Google
  // failure reports to error_events and never fails the schedule write.
  // Awaited (not `void`) — serverless can drop an un-awaited promise.
  await pushCalendarItem("job", jobId);

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);

  // Surface ANY segment-write failure (not just multi-range) so the editor
  // never silently shows a stale range while the mirror moved underneath it.
  if (!segOk && clean.length > 1) {
    return { ok: false, error: "Multiple date ranges need a quick database update (migration 0040). The first range was saved." };
  }
  if (!segOk && clean.length === 1) {
    return { ok: false, error: "Couldn't save the date range — please try again. The job's overall window was updated." };
  }
  return { ok: true };
}

/** A job's schedule as date-only segments, for read-modify-write math. Legacy
 *  fallback: a job scheduled before segments existed (migration 0040) may carry
 *  only the scheduled_start/end mirror — synthesize that window (org-tz dates)
 *  so a move/place computed from "no segments" can't drop it. */
async function loadJobDaySegments(
  supabase: SupabaseClient,
  jobId: string,
): Promise<{ segments: DateRange[]; error?: string }> {
  const { data: segRows, error } = await supabase
    .from("job_schedule_segments")
    .select("start_date, end_date")
    .eq("job_id", jobId)
    .order("start_date");
  if (error) return { segments: [], error: dbError(error) };
  const segments = (segRows ?? []).map((s: any) => ({ start: s.start_date as string, end: s.end_date as string }));
  if (segments.length) return { segments };
  const { data: job } = await supabase.from("jobs").select("scheduled_start, scheduled_end").eq("id", jobId).maybeSingle();
  // No segments AND no visible job = the id isn't ours (RLS) or doesn't exist. Bail
  // so movers/placers can't write an orphan segment row against a foreign job id
  // (audit cn-v328: the insert would org-stamp to the CALLER and pass WITH CHECK).
  if (!job) return { segments: [], error: "Job not found." };
  if (job?.scheduled_start) {
    const tz = await orgTimezone(supabase);
    const start = todayStrInTz(tz, new Date(job.scheduled_start));
    const end = job.scheduled_end ? todayStrInTz(tz, new Date(job.scheduled_end)) : start;
    segments.push({ start, end: end < start ? start : end });
  }
  return { segments };
}

/** MOVE one of a job's scheduled ranges to start on a new day, preserving its
 *  length and every OTHER range. Read-modify-write by construction: it loads ALL
 *  segments, shifts only the one covering fromDate (null = the earliest/only),
 *  and writes the FULL set back through setJobScheduleRanges — never just the
 *  tapped day, which would silently erase multi-range schedules. A pending
 *  customer date-pick link blocks the move (needsProposalConfirm) until the
 *  caller confirms withdrawing it, so a later customer tap on an OLD option
 *  can't silently overwrite the move. */
export async function moveJobDay(
  jobId: string,
  fromDate: string | null,
  toDate: string,
  opts?: { cancelProposals?: boolean },
): Promise<Result & { needsProposalConfirm?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return { ok: false, error: "Pick a day to move it to." };
  const from = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? fromDate : null;

  const { data: pending } = await supabase
    .from("schedule_proposals")
    .select("id")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .limit(1);
  if (pending?.length) {
    if (!opts?.cancelProposals) {
      return {
        ok: false,
        needsProposalConfirm: true,
        error: "A date-pick link is out to the customer for this job — moving it withdraws that link.",
      };
    }
    // Withdraw it the same way createScheduleProposal replaces a pending one.
    await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending");
  }

  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  // setJobScheduleRanges revalidates /schedule, /planner, /jobs, and the job page.
  return setJobScheduleRanges(jobId, shiftSegmentCovering(segments, from, toDate));
}

/** PLACE a job on a day without touching anything already scheduled — the tray
 *  gesture. UNION, not replace: a needs-return job keeps its worked-history
 *  segments on the calendar instead of collapsing to the tapped day. */
export async function placeJobOnDay(
  jobId: string,
  dateISO: string,
  /** "HH:MM" in the org's timezone. Omitted preserves whatever real time the job already carries —
   *  the branch a plain day-move relies on. A FLOATER carries none, so without this it silently
   *  fell back to the all-day window and landed at 8am on an afternoon he had just chosen. */
  startHHMM?: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: "Pick a day." };
  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };

  /* AS MANY DAYS AS IT TAKES. A job sized at three days used to land on one, leaving the next two
     looking free — the exact overbooking the sizes exist to prevent. The day he tapped is always
     day one; the rest skip the weekend (see workingDaysFrom). */
  const { data: sizeRow } = await supabase
    .from("jobs")
    .select("planned_minutes, status") // PROJECTION LAW: both columns are read below
    .eq("id", jobId)
    .maybeSingle();
  const row = sizeRow as { planned_minutes?: number | null; status?: string | null } | null;
  const days = workingDaysFrom(dateISO, daysNeeded(row?.planned_minutes));
  const withDays = days.reduce((acc, d) => addDaySegment(acc, d), segments);

  /* GIVING SOMETHING A DAY IS THE OPPOSITE OF PARKING IT. An on-hold job now appears on the rail
     even when it carries a stale date (Erik: "we need everything on hold to pop up on that list"),
     so placing one has to take it off hold — otherwise it lands on the calendar AND stays on the
     board forever, which is a loop rather than a decision. advanceToScheduled deliberately only
     promotes to_be_scheduled/estimate, so this is its own explicit write. */
  if (row?.status === "on_hold") {
    await supabase.from("jobs").update({ status: "scheduled" }).eq("id", jobId).eq("status", "on_hold");
  }
  // setJobScheduleRanges revalidates /schedule, /planner, /jobs, and the job page.
  // undefined (not null) when no time was given, so the preserve-the-job's-own-time branch stands.
  return setJobScheduleRanges(
    jobId,
    withDays,
    /^\d{2}:\d{2}$/.test(startHHMM ?? "") ? startHHMM : undefined,
  );
}


/**
 * HOW LONG WILL THIS FLOATER TAKE.
 *
 * Erik: "floaters are jobs with no date that i squeeze in that's right, just like all the leads on
 * the board now ready to go on the calendar, i just need to be able to mark how much time they are
 * going to take o the lead and schedule page."
 *
 * A floater is the squeeze-it-in work — and squeezing it in is precisely the decision that needs
 * the number. A 1h floater fits after Thursday's 6h job in the same town; a full-day one does not,
 * and no amount of map-staring answers that. 0230 put this on the lead; this is its twin for jobs,
 * callable from the rail so the number can be set at the moment it is wanted.
 *
 * A job has no KIND to pick — a job is a job. Duration is the only question.
 */
export async function sizeJob(jobId: string, plannedMinutes: number | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const m = Number(plannedMinutes) || 0;
  if (m < 0 || m > 60 * 24 * 30) return { ok: false, error: "That duration isn't sensible." };
  // 0 means "not sure yet" and clears it — never a zero-length job. Blank is not zero.
  const { data, error } = await ctx.supabase
    .from("jobs")
    .update({ planned_minutes: m > 0 ? m : null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .select("id"); // THE SILENT-WRITE LAW: a zero-row update is a 204, not an error.
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That job isn't available." };
  revalidatePath("/schedule");
  revalidatePath("/jobs");
  return { ok: true };
}

/**
 * PUT AN ALREADY-BOOKED WALK-THROUGH ON A DAY.
 *
 * Found while wiring the calendar as the day picker, and it was a live dead end. The rail carries
 * three things: leads, dateless jobs, and appointments that exist but have no start — Erik's "i
 * have a couple inspections that already link to the leads i inputted". All three were labelled
 * `lead` on the way in, because all three book like one. So picking one of those inspections and
 * tapping a day ran its APPOINTMENT id through convertInquiry, which looks for an inquiry, finds
 * nothing, and reports a failure he could do nothing about. The one item on the board that was
 * already decided was the one item that could not be placed.
 *
 * Delegates to rescheduleAppointment rather than writing starts_at here — that writer also cancels
 * any pending pick-a-time link (or the customer could tap a stale option and move it back
 * underneath us) and pushes to Google. A second UPDATE next to it would skip both.
 */
export async function placeAppointmentOnDay(
  id: string,
  dateISO: string,
  startHHMM: string,
  plannedMinutes?: number | null,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: "Pick a day." };
  const hm = /^\d{2}:\d{2}$/.test(startHHMM) ? startHHMM : "09:00";

  // THE ORG'S CLOCK, NOT THE SERVER'S. `new Date("2026-08-27T08:00")` on Vercel is 8am UTC — which
  // is midnight in Truckee. Through the same orgTimezone helper every other writer in this file
  // uses, rather than a second copy of the settings read that could drift from it.
  const tz = await orgTimezone(ctx.supabase);
  const startsAt = tzDateTimeUtc(dateISO, hm, tz);
  if (!startsAt) return { ok: false, error: "I couldn't read that day." };

  // An END only when somebody actually sized it. Blank is not zero, and a fake 90 minutes would put
  // a block on the calendar that no human chose.
  //
  // CLAMPED TO ONE WORKING DAY, because planned_minutes is a WORK-LOAD figure and this is WALL
  // CLOCK. The rail sells 960 as "2 days"; spending it as 960 real minutes from 08:00 ends the
  // visit at midnight, and 1440 ("3 days") ends it at 8am tomorrow. The day grid can't draw a block
  // that crosses midnight, so it would silently shrink to an hour while every occupancy reader
  // marked tomorrow busy. A multi-day visit is a span of days, not one very long appointment.
  // Multi-day sizes run to the same hour on the last WORKING day (spanEnd) rather than being
  // clamped to one day or spent as wall clock across midnight.
  const span = spanEnd(dateISO, hm, plannedMinutes);
  const endsAt = span ? tzDateTimeUtc(span.lastYmd, span.endHHMM, tz) : null;

  const res = await rescheduleAppointment(id, startsAt, endsAt);
  return res.ok ? { ok: true } : res;
}

/**
 * SIZE (and re-tag) AN ALREADY-BOOKED VISIT from the rail.
 *
 * The twin of sizeJob/sizeLead for the third kind. Without it the rail's duration dropdown sent an
 * APPOINTMENT id to sizeLead, which updates `inquiries` — zero rows, and the SILENT-WRITE LAW says
 * that is a 204 and not an error, so it would have reported "That lead isn't available" for an
 * appointment that was sitting right there. Same shape of hole as the placement one, two rows down.
 *
 * The kind is writable too, through the one WorkKind→appointments.type mapping the whole app uses
 * (appointmentTypeFor). An inspection that turns out to be a service call is a thing that happens
 * on the phone, and making him leave the board to say so is the round trip this rail exists to kill.
 */
export async function sizeAppointment(
  id: string,
  patch: { workKind?: string; plannedMinutes?: number | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("plannedMinutes" in patch) {
    const m = Number(patch.plannedMinutes ?? 0);
    if (m < 0 || m > 60 * 24 * 30) return { ok: false, error: "That duration isn't sensible." };
    update.planned_minutes = m > 0 ? m : null; // blank is not zero
  }
  if (patch.workKind) update.type = appointmentTypeFor(patch.workKind);
  if (Object.keys(update).length === 1) return { ok: true }; // nothing but the timestamp — no-op

  /* A SIZE THE CALENDAR CANNOT DRAW IS NOT A SIZE. The grid reads ends_at, so writing
     planned_minutes alone leaves the block at its default hour — the number is entered, saved, and
     invisible, which is the shape of the Matt Warren bug. If this visit already has a day, its
     drawn length moves with the number. (Clamped: planned_minutes is work load, not wall clock.) */
  if ("plannedMinutes" in patch) {
    const { data: cur } = await ctx.supabase
      .from("appointments")
      .select("starts_at") // THE PROJECTION LAW: read the column the decision below turns on
      .eq("id", id)
      .maybeSingle();
    const startsAt = (cur as { starts_at?: string | null } | null)?.starts_at ?? null;
    if (startsAt) {
      const span = Math.min(Number(update.planned_minutes ?? 0), WORK_DAY_MINUTES);
      update.ends_at = span > 0 ? new Date(new Date(startsAt).getTime() + span * 60_000).toISOString() : null;
    }
  }

  const { data, error } = await ctx.supabase
    .from("appointments")
    .update(update)
    .eq("id", id)
    .select("id"); // a zero-row UPDATE is a 204, not an error
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That visit isn't available." };
  revalidatePath("/schedule");
  revalidatePath("/inspections");
  return { ok: true };
}

/**
 * WHEN DOES THE NEXT ONE ACTUALLY START.
 *
 * Erik: "when im filling in the next job after nora i choose morning then it should fill in the gap
 * inbetween not put it at the same time."
 *
 * Placing always started at 8am (or 1pm) and spread from there as though the day were empty. It
 * never was: Nora's service call already had Friday 8–10, so the next thing he added to Friday
 * morning landed at 8 too — two pills stacked, two customers told the same hour, and a day drawn as
 * half empty while being double-booked.
 *
 * "Morning" is a REGION, not an instant. The honest reading is "the first place in the morning this
 * fits", which is exactly what he'd work out himself in two seconds by looking at the day — and the
 * day is right there.
 *
 * ON THE SERVER ON PURPOSE. The client's copy of the calendar can be a page-load old, and a stale
 * picture is what puts two people in one slot. This reads the day at the moment of the write.
 */
export async function planDayTimes(
  dateISO: string,
  items: { minutes: number | null; pinned?: boolean }[],
  fromHHMM: string,
): Promise<{ ok: boolean; times: string[]; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, times: [], error: ctx.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, times: [], error: "Pick a day." };

  const { tz, dayStartHm, dayEndHm } = await orgSchedulePrefs(ctx.supabase);
  const dayStart = tzDayStartUtc(dateISO, tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);

  // Everything already holding time on this day. A CALL is excluded — it is pinned to the top and
  // costs the route nothing, so it must not push a real visit later.
  const { data: appts } = await ctx.supabase
    .from("appointments")
    .select("starts_at, ends_at, type, status") // PROJECTION LAW: all four are read below
    .gte("starts_at", dayStart.toISOString())
    .lt("starts_at", dayEnd.toISOString())
    .limit(200);

  const busy: Busy[] = [];
  for (const a of (appts ?? []) as { starts_at: string; ends_at: string | null; type: string | null; status: string | null }[]) {
    if (a.status === "cancelled" || a.type === "call") continue;
    const startMin = tzMinutesOfDay(a.starts_at, tz);
    // An appointment with no end is drawn as an hour, so it occupies an hour. Reading it as a point
    // would let the next visit land inside a block he can see on his screen.
    const endMin = a.ends_at && new Date(a.ends_at) > new Date(a.starts_at)
      ? Math.min(24 * 60, tzMinutesOfDay(a.ends_at, tz) || 24 * 60)
      : startMin + 60;
    busy.push({ startMin, endMin: Math.max(startMin + 15, endMin) });
  }

  // Bounded by HIS working day. Past the end it still lands (never silently refused) — just after
  // everything else, where he can see it ran long.
  const from = hmToMinutes(fromHHMM) ?? hmToMinutes(dayStartHm) ?? 8 * 60;
  const starts = fitIntoDay(busy, items, {
    fromMin: from,
    endOfDayMin: hmToMinutes(dayEndHm) ?? 17 * 60,
    gapMin: 0,
  });
  return { ok: true, times: starts.map((m) => (m === PINNED_TO_TOP ? fromHHMM : minutesToHm(m))) };
}
