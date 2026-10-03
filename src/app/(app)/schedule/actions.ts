"use server";
import { dbError } from "@/lib/db-error";
import { formatPhone } from "@/lib/utils";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { pushCalendarItem } from "@/lib/calendar-sync";
import { notifyJobCrewAdded } from "@/lib/crew-notify";
import { applyCrewChange, type CrewChange } from "@/lib/crew-change";
import { requireStaff } from "@/lib/staff-guard";
import { customerForInquiry } from "@/lib/actions/win-customer";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";
import { matchOrCreateCustomer, typedNewCustomer } from "@/lib/crm/new-customer";
import { readUsualBillingKind, statusFromDate } from "@/lib/schedule-options";
import { jobNameFrom, typedNameMayBeATag } from "@/lib/job-name";
import { JOB_STATUSES } from "@/lib/job-status";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { todayStrInTz, tzDateTimeUtc, tzDayStartUtc, tzMinutesOfDay } from "@/lib/tz";
import { resolveComeBack, type ComeBackWhen } from "@/lib/come-back-days";
import { isMissingColumn } from "@/lib/job-tasks";
import {
  addDaySegment,
  carryHours,
  coversDay,
  hoursOnDay,
  keepWorkedDays,
  moveKeepingWorkedDays,
  removeDaySegment,
  segmentDays,
  setDayHours,
  workedDaysFrom,
  type DayHours,
} from "@/lib/schedule-math";
import { actualSpans } from "@/lib/schedule/plan-vs-actual";
import { jobWords } from "@/lib/action-items/words";
import { dayHoursOf, freezeDrawnDays, nextDayHours, readDayHours } from "@/lib/schedule/day-hours";
import { ownHoursByJobDay, segmentCols, withDayHours, type SegmentRow } from "@/lib/schedule/segment-hours";
import { ACTIVE_JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";
import { rescheduleAppointment, unscheduleAppointment } from "../appointments/actions";
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
  isWorkKind,
  spanEnd,
  WORK_DAY_MINUTES,
  workingDaysFrom,
} from "@/lib/schedule/work-shape";
import {
  dayWords,
  DEFAULT_JOB_MINUTES,
  endAfter,
  hmWords,
  jobDayBlock,
  planJobTimes,
  readHm,
  workDayMinutes,
  type JobLength,
} from "@/lib/schedule/job-block";
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

export async function createJob(formData: FormData): Promise<Result & { /** The name the job was saved under (a sent name that was only a tag is not it). */ name?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // A JOB IS NEVER BORN ON HOLD (NY-hold, 0366). A hold is a reason and the day it comes back, and
  // the new-job form asks neither: made on hold it would park with no reason and a day nobody chose.
  // The job page's status control and the schedule rail put a job on hold, and both ask. Refused
  // before anything is written (no customer is minted for a job that isn't made).
  if (String(formData.get("status") ?? "").trim() === "on_hold") {
    return { ok: false, error: "Make the job first, then put it on hold. It asks why and for a day." };
  }

  const address = emptyToNull(formData.get("address"));
  // THE COMPANY'S CLOCK (W1-22): its timezone, its today, and its work-day start (a day with no time
  // starts there: workDayWindowHm, never a hard-coded 08:00). Server actions run in UTC,
  // so a bare `new Date("…T08:00")` would be 8 AM UTC.
  const { tz, dayStartHm } = await orgSchedulePrefs(supabase);
  const todayStr = todayStrInTz(tz);

  // THE DAY. New Job sends the day (YYYY-MM-DD, or "" for Not Scheduled Yet) and an optional time,
  // and the instant is built here on the company's clock. An older caller may still send an instant
  // (scheduled_start); a caller that sends neither sent no date at all.
  const sentDay = formData.has("scheduled_date");
  let startIso: string | null = null;
  // THE FORM ASKS NO LENGTH, SO A DATED JOB GETS THE DEFAULT: two hours from its start on the company's
  // clock (lib/schedule/job-block DEFAULT_JOB_MINUTES), the block the calendar draws and the job page
  // shows as "2 hours — change it". No end at all read as the rest of the work day.
  let endIso: string | null = null;
  let dayOfStart: string | null = null;
  if (sentDay) {
    const day = String(formData.get("scheduled_date") ?? "").trim();
    const time = String(formData.get("scheduled_time") ?? "").trim();
    if (day) {
      const hm = /^\d{2}:\d{2}$/.test(time) ? time : dayStartHm;
      startIso = /^\d{4}-\d{2}-\d{2}$/.test(day) ? tzDateTimeUtc(day, hm, tz) : null;
      if (!startIso) return { ok: false, error: "That date doesn't look right. Pick it again, or tap Not Scheduled Yet." };
      endIso = tzDateTimeUtc(day, endAfter(hm, DEFAULT_JOB_MINUTES), tz);
      dayOfStart = day;
    }
  } else {
    const legacy = String(formData.get("scheduled_start") ?? "").trim();
    const d = legacy ? new Date(legacy) : null;
    if (d && !isNaN(d.getTime())) {
      startIso = d.toISOString();
      endIso = new Date(d.getTime() + DEFAULT_JOB_MINUTES * 60_000).toISOString();
      dayOfStart = todayStrInTz(tz, d);
    }
  }
  const dateSent = sentDay || formData.has("scheduled_start");

  // Optionally create a customer inline (when no existing one is selected): the one shared
  // match-then-insert door, so no job form mints a twin (lib/crm/new-customer).
  // A phone typed with no name is refused in words (the helper's refusal), never dropped while the
  // job is made with no customer.
  let customerId = emptyToNull(formData.get("customer_id"));
  const typedCustomer = typedNewCustomer(formData);
  if (!customerId && typedCustomer) {
    const made = await matchOrCreateCustomer(supabase, ctx.userId, typedCustomer);
    if (!made.ok) return { ok: false, error: made.error };
    customerId = made.id;
  }

  // THE NAME (W1-22; Erik 2026-09-28, "street number and name as always"). A name that was sent is
  // a name a person typed (the Timeclock's quick add and Nort send one) and is kept exactly as sent.
  // With none, the same line the form showed live: the street number and name (" #56" with a unit),
  // else the customer as written, else "New Job · Sep 27" on the company's today (the one namer,
  // lib/job-name, over lib/schedule-options defaultJobName). Fragment-first: nobody invents a name.
  //
  // NEVER ONLY A SOURCE TAG (Erik 2026-09-27). A sent name that is only a tag, or a tag and the
  // person or the street ("Site inspection: Rita Moss"), is no name: it gets the default above.
  const sentName = String(formData.get("name") ?? "").trim();
  let name = sentName;
  if (typedNameMayBeATag(sentName)) {
    const { data: cust } = customerId
      ? await supabase.from("customers").select("name, company_name, type").eq("id", customerId).maybeSingle()
      : { data: null };
    name = jobNameFrom({
      typed: sentName,
      customer: (cust as { name?: string | null; company_name?: string | null; type?: string | null } | null) ?? null,
      street: address,
      unit: emptyToNull(formData.get("unit")),
      todayStr,
    });
  }

  // THE STATUS (W1-22). An explicit status on the spine wins (the Timeclock's quick add sends In
  // Progress; Nort sends its own). With none, the date decides, on the company's today: today or
  // earlier is In Progress (he's usually already working it, Erik 2026-07), a later day Scheduled,
  // no day To Be Scheduled. A caller that sends no date field at all keeps In Progress, as it always
  // did. Never on_hold (refused above), never a retired enum value or garbage.
  const rawStatus = String(formData.get("status") ?? "").trim();
  const status = (JOB_STATUSES as readonly string[]).includes(rawStatus)
    ? rawStatus
    : dateSent
      ? statusFromDate(dayOfStart, todayStr)
      : "in_progress";

  // THE BILLING (W1-22): what was sent, else the kind most of this company's jobs use (Time &
  // Material with none yet) — never one company's habit written into code.
  const rawBilling = String(formData.get("billing_type") ?? "").trim();
  const billingType = rawBilling === "tm" || rawBilling === "fixed" ? rawBilling : await readUsualBillingKind(supabase);

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      name,
      customer_id: customerId,
      description: emptyToNull(formData.get("description")),
      status,
      billing_type: billingType,
      address,
      // The parts the picker resolved. A fixed form is no help if the insert has nowhere to put
      // them — same shape updateJob has used all along.
      unit: emptyToNull(formData.get("unit")),
      city: emptyToNull(formData.get("city")),
      state: emptyToNull(formData.get("state")),
      zip: emptyToNull(formData.get("zip")),
      scheduled_start: startIso,
      scheduled_end: endIso,
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbError(error) };

  // Live Google push (fire-safe: never throws, no-op when not connected).
  if (startIso) await pushCalendarItem("job", data.id);

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  // The name it was SAVED under, so a caller that echoes it (the Timeclock's quick add) never says
  // one name while the job carries another.
  return { ok: true, id: data.id, name };
}

// setJobStatus lived here as an UNGUARDED copy (no requireStaff / no status whitelist) — the job-page
// status dropdown imported THIS one, silently bypassing the guard on the canonical jobs/actions copy.
// Removed to kill the name-collision footgun; the single caller now imports the guarded jobs/actions one
// (which revalidates /schedule + /planner so the calendar stays fresh).

/** Assign a job to a single employee (or clear). */
/** Keep only ids that are profiles the caller can see — i.e. in their own org (RLS scopes
 *  profiles_read). A job's assigned_to must never carry a foreign-org profile (audit v921):
 *  setJobCrew/setJobAssignee took any uuid and the crew-added push then reached across tenants. */
async function orgMemberIds(
  supabase: SupabaseClient,
  ids: string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const { data } = await supabase.from("profiles").select("id").in("id", ids);
  const ok = new Set((data ?? []).map((r: { id: string }) => r.id));
  return ids.filter((x) => ok.has(x));
}

export async function setJobAssignee(
  id: string,
  employeeId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const ids = await orgMemberIds(supabase, employeeId ? [employeeId] : []);
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
  const ids = await orgMemberIds(supabase, Array.from(new Set((employeeIds ?? []).map(String).filter(Boolean))));
  // Old crew first (diff base) — also proves the job is visible to the caller.
  const { data: prev } = await supabase
    .from("jobs")
    .select("assigned_to, org_id, job_number, name")
    .eq("id", id)
    .maybeSingle();
  // SILENT-WRITE LAW: the Overview's crew chips roll back on a refusal, so a zero-row write (a job
  // gone, or not this company's) has to come back as one, never as a saved crew.
  const { data: saved, error } = await supabase.from("jobs").update({ assigned_to: ids }).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!saved?.length) return { ok: false, error: "That job isn't available, so the crew didn't change." };
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

/** Put ONE person on a job or take ONE off, against the crew as it is saved NOW (the job page's crew
 *  chips). The chips never send a whole list: a list built on a page that has gone stale would take off,
 *  with no word to anyone, whoever a foreman, the schedule board or Nort put on in the meantime. Reads
 *  the stored crew fresh, applies the one change, and writes through setJobCrew, the one crew writer
 *  (the same shape the time clock's assignMemberToJob uses). Returns the crew as written. */
export async function changeJobCrew(id: string, change: CrewChange): Promise<Result & { crew?: string[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: job, error } = await ctx.supabase.from("jobs").select("assigned_to").eq("id", id).maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!job) return { ok: false, error: "That job isn't available, so the crew didn't change." };
  const next = applyCrewChange((job as { assigned_to: string[] | null }).assigned_to, change);
  const res = await setJobCrew(id, next);
  return res.ok ? { ...res, crew: next } : res;
}

/** Offer the customer up to 3 date+time slots; returns the public pick token.
 *  The customer's pick (choose_schedule_slot, 0370) lands at the slot's time, or the company's
 *  work-day start when it has none, for the job's length (else two hours), beside the job's other days. */
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
  // SILENT-WRITE LAW: a zero-row update is a 204, so the id comes back or the withdraw says it didn't.
  const { data, error } = await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That link isn't here any more. Reload the job to see where it stands." };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

// setJobSchedule (raw scheduled_start/end writer) is GONE: it never touched
// job_schedule_segments, so the calendar (segments-first) kept drawing a moved
// multi-range job on its old days — the stale-schedule trap. Day moves go
// through moveJobDay/placeJobOnDay below; range edits through setJobScheduleRanges.

/** yyyy-mm-dd each. `hours` (0370): the days' own hours, null for the job's usual hours, absent for
 *  "not said" (the writer carries over whatever those days already had; lib/schedule-math). */
export type DateRange = { start: string; end: string; hours?: DayHours | null };

/** Canonical writer for a job's schedule as one or more date ranges. Replaces
 *  all segments, and mirrors the overall min start / max end onto
 *  jobs.scheduled_start/end so every legacy reader still works.
 *
 *  The mirror carries the job's BLOCK (lib/schedule/job-block planJobTimes): the start on the first
 *  day and the block's real end, never the closing-time stamp it used to write whatever the length.
 *  Segments stay date-only. `startTime` and `length` each have three intents: undefined keeps what the
 *  job has (a day-move keeps its start and its length), a value sets it, and startTime null/"" is all
 *  day. With no length anywhere, a job getting its first day lands as two hours (DEFAULT_JOB_MINUTES),
 *  planned_minutes left blank. */
export async function setJobScheduleRanges(
  jobId: string,
  ranges: DateRange[],
  startTime?: string | null,
  length?: JobLength,
): Promise<Result & { defaulted?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const bad = lengthProblem(length);
  if (bad) return { ok: false, error: bad };
  return writeScheduleRanges(ctx.supabase, jobId, ranges, startTime, undefined, length);
}

/** A length a writer can store, or the words for why not. */
function lengthProblem(length: JobLength | undefined): string | null {
  if (length === undefined || length === "full") return null;
  const n = Number(length);
  if (!Number.isFinite(n) || n < 1 || n > 60 * 24 * 30) return "That length isn't one a job can have. Pick 1h, 2h, 4h, Full Day or an end time.";
  return null;
}

/** The body of setJobScheduleRanges, for callers that already passed requireStaff. `mirror`
 *  (optional) sets the jobs.scheduled_start/end span on its own instead of the segments' overall
 *  span: the reschedule verbs pass the PLAN, so a kept worked day stays on the calendar as history
 *  without dragging the job's listed start back onto it (moveJobDay, scheduleJobWindow). "none" clears
 *  the listed day while the segments stay (Clear The Date keeps the worked days). Not exported: a
 *  "use server" export is callable from the client, and the mirror should never be set apart from
 *  the segments by anyone but this file. */
async function writeScheduleRanges(
  supabase: SupabaseClient,
  jobId: string,
  ranges: DateRange[],
  startTime?: string | null,
  mirror?: DateRange | null | "none",
  length?: JobLength,
  /** `freshBlock`: the job has no live plan (no day, or a stale one from before a hold), so the block
   *  it lands with is the start and length given here, never a length kept from that old block.
   *  `promote: false`: the status never moves (a worked day booked after the fact, an Undo putting a
   *  placement back): advanceToScheduled is skipped. Private to this file, like the mirror.
   *  `listedAt`: the listed start and end exactly as they were (an Undo), instead of the block the
   *  write would work out; the length column is left alone. */
  opts?: { freshBlock?: boolean; promote?: boolean; listedAt?: { start: string | null; end: string | null } },
): Promise<Result & { defaulted?: boolean }> {
  // Keep only well-formed ranges; default a missing end to the start. A range's hours ride with it.
  const clean: DateRange[] = ranges
    .map((r) => ({ start: r.start, end: r.end || r.start, ...(r.hours !== undefined ? { hours: r.hours } : {}) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end))
    .map((r) => (r.end < r.start ? { ...r, end: r.start } : r))
    .sort((a, b) => a.start.localeCompare(b.start));

  /* EACH DAY KEEPS ITS OWN HOURS (0370) THROUGH THIS REWRITE. The segments are deleted and written
     again below, so the hours each day has now are read FIRST, before anything is written, and carried
     onto every day still on the schedule (carryHours); a range that says its hours (a moved range, the
     day being added, a day given its own time) keeps what it says. Never dropped: a read that fails
     stops the write here, with nothing changed. Before 0370 the columns aren't there: the days are
     written exactly as before, without hours. */
  const priorRead = await withDayHours((h) =>
    supabase.from("job_schedule_segments").select(segmentCols("start_date, end_date", h)).eq("job_id", jobId),
  );
  // A missing TABLE (42P01 / PostgREST PGRST205, a database before 0040) is the legacy path below.
  const priorCode = String((priorRead.error as { code?: unknown } | null)?.code ?? "");
  if (priorRead.error && priorCode !== "42P01" && priorCode !== "PGRST205") {
    return { ok: false, error: "Couldn't read the job's days, so nothing changed. Try again." };
  }
  const perDayHours = priorRead.perDayHours && !priorRead.error;

  // Mirror the overall window onto the job FIRST — this is what every legacy
  // reader uses, and it must succeed even if the segments table isn't there.
  // Every instant is built in the ORG timezone (this runs server-side in UTC, so a bare
  // `new Date("…T08:00")` would store 8am UTC = ~midnight Pacific — the root of the "wrong time" bug).
  const { tz, dayStartHm, dayEndHm } = await orgSchedulePrefs(supabase);
  const span = mirror === "none" ? [] : mirror && clean.length ? [mirror] : clean;
  const minStart = span.length ? span[0].start : null;
  const maxEnd = span.length ? span.reduce((m, r) => (r.end > m ? r.end : m), span[0].end) : null;

  // THE BLOCK AS IT STANDS is what a move keeps: its start time, its length, its size. PROJECTION LAW:
  // all three columns planJobTimes reads are in the select list.
  const { data: prior } = minStart
    ? await supabase.from("jobs").select("scheduled_start, scheduled_end, planned_minutes").eq("id", jobId).maybeSingle()
    : { data: null };
  const was = (prior ?? {}) as { scheduled_start?: string | null; scheduled_end?: string | null; planned_minutes?: number | null };

  // The days as they will be written: each day's hours carried (read above, before any write).
  let days: DateRange[] = clean;
  /* A JOB'S ONE DAY RUNS ON ITS TIME. When the plan written is ONE day and that day keeps hours of its
     own (a day added and then taken off again, a day moved onto another, a leftover), those hours ARE
     the job's block as it stands: this write keeps them (their start, their clock length) or changes
     them as asked, and the day goes back to the job's usual hours, which are now the same. Every time,
     whatever the caller passed: a plan that shrinks back to one day never leaves its only day drawn
     one way while the job's time (the Jobs list, Nort, the tile sheet, the job page) says another, and
     the next length tap never moves the block away from where it's drawn. The size (planned_minutes)
     is left alone. */
  let soleOwn: { day: string; hours: DayHours } | null = null;
  if (perDayHours) {
    const priorDays = ((priorRead.data ?? []) as unknown as SegmentRow[]).map(
      (s) => ({ start: s.start_date, end: s.end_date, hours: readDayHours(s.start_time, s.end_time) }),
    );
    days = carryHours(clean, priorDays);
    // An Undo (listedAt) puts the days back exactly as they were, their own hours included.
    const own = minStart && minStart === maxEnd && !opts?.listedAt ? hoursOnDay(days, minStart) : null;
    if (minStart && own) {
      soleOwn = { day: minStart, hours: own };
      days = setDayHours(days, minStart, null);
    }
  }

  const times = planJobTimes({
    firstDay: minStart,
    lastDay: maxEnd,
    tz,
    workDay: { start: dayStartHm, end: dayEndHm },
    startTime,
    length,
    prior: soleOwn
      ? {
          // The one day's own hours: the block as it is drawn, which is what this write keeps.
          scheduledStart: tzDateTimeUtc(soleOwn.day, soleOwn.hours.start, tz),
          scheduledEnd: tzDateTimeUtc(soleOwn.day, soleOwn.hours.end, tz),
          plannedMinutes: was.planned_minutes ?? null,
        }
      : {
          scheduledStart: opts?.freshBlock ? null : (was.scheduled_start ?? null),
          scheduledEnd: opts?.freshBlock ? null : (was.scheduled_end ?? null),
          plannedMinutes: was.planned_minutes ?? null,
        },
  });

  // The start, the end and a chosen length land TOGETHER, in one row write: a length is never saved
  // apart from the block it draws. An Undo puts the listed start and end back exactly as they were.
  const patch: Record<string, unknown> = opts?.listedAt
    ? { scheduled_start: opts.listedAt.start, scheduled_end: opts.listedAt.end, updated_at: new Date().toISOString() }
    : {
        scheduled_start: times.startIso,
        scheduled_end: times.endIso,
        ...(times.plannedMinutes !== undefined ? { planned_minutes: times.plannedMinutes } : {}),
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
  // A scheduled date advances early-stage status (consistent with the other writers), unless the
  // caller said the status never moves (promote: false).
  if (minStart && opts?.promote !== false) await advanceToScheduled(supabase, jobId);

  // Replace segments wholesale. If the table is missing (migration 0040 not yet
  // applied) a single range is already fully saved via the mirror above; only
  // multi-range needs the table, so surface a clear message in that case.
  const { error: delErr } = await supabase.from("job_schedule_segments").delete().eq("job_id", jobId);
  let segOk = !delErr;
  if (segOk && days.length) {
    const rows = days.map((r) => ({
      job_id: jobId,
      start_date: r.start,
      end_date: r.end,
      ...(perDayHours ? { start_time: r.hours?.start ?? null, end_time: r.hours?.end ?? null } : {}),
    }));
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
    return { ok: false, error: "Multiple date ranges can't be saved yet. The first range was saved." };
  }
  if (!segOk && clean.length === 1) {
    return { ok: false, error: "Couldn't save the date range — please try again. The job's overall window was updated." };
  }
  // `defaulted`: nobody gave it a length, so it went down as two hours; the caller can say so.
  return times.defaulted ? { ok: true, defaulted: true } : { ok: true };
}

/** A job's schedule as date-only segments, for read-modify-write math. Legacy
 *  fallback: a job scheduled before segments existed (migration 0040) may carry
 *  only the scheduled_start/end mirror — synthesize that window (org-tz dates)
 *  so a move/place computed from "no segments" can't drop it. */
async function loadJobDaySegments(
  supabase: SupabaseClient,
  jobId: string,
): Promise<{ segments: DateRange[]; perDayHours: boolean; error?: string }> {
  // Each day's own hours ride along (0370); before the migration they can't, and every day is the
  // job's usual hours (null), exactly as before.
  const read = await withDayHours((h) =>
    supabase
      .from("job_schedule_segments")
      .select(segmentCols("start_date, end_date", h))
      .eq("job_id", jobId)
      .order("start_date"),
  );
  const perDayHours = read.perDayHours;
  if (read.error) return { segments: [], perDayHours, error: dbError(read.error) };
  const segments: DateRange[] = ((read.data ?? []) as unknown as SegmentRow[]).map(
    (s) => ({ start: s.start_date, end: s.end_date, hours: perDayHours ? readDayHours(s.start_time, s.end_time) : null }),
  );
  if (segments.length) return { segments, perDayHours };
  const { data: job } = await supabase.from("jobs").select("scheduled_start, scheduled_end").eq("id", jobId).maybeSingle();
  // No segments AND no visible job = the id isn't ours (RLS) or doesn't exist. Bail
  // so movers/placers can't write an orphan segment row against a foreign job id
  // (audit cn-v328: the insert would org-stamp to the CALLER and pass WITH CHECK).
  if (!job) return { segments: [], perDayHours, error: "Job not found." };
  if (job?.scheduled_start) {
    const tz = await orgTimezone(supabase);
    const start = todayStrInTz(tz, new Date(job.scheduled_start));
    const end = job.scheduled_end ? todayStrInTz(tz, new Date(job.scheduled_end)) : start;
    segments.push({ start, end: end < start ? start : end, hours: null });
  }
  return { segments, perDayHours };
}

/** MOVE one of a job's scheduled ranges to start on a new day, preserving every
 *  OTHER range. Read-modify-write by construction: it loads ALL segments, shifts
 *  only the one covering fromDate (null = the earliest one with a day not yet
 *  worked). The range's WORKED days stay where they happened and only its
 *  unworked remainder moves (moveKeepingWorkedDays), so a 3-day range with 2
 *  days worked lands as 1 day, and the note says which days stayed. It
 *  writes the FULL set back through writeScheduleRanges — never just the
 *  tapped day, which would silently erase multi-range schedules. A pending
 *  customer date-pick link blocks the move (needsProposalConfirm) until the
 *  caller confirms withdrawing it, so a later customer tap on an OLD option
 *  can't silently overwrite the move. */
export async function moveJobDay(
  jobId: string,
  fromDate: string | null,
  toDate: string,
  opts?: { cancelProposals?: boolean },
): Promise<Result & { needsProposalConfirm?: boolean; note?: string; kept?: string[] }> {
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

  // A job with NO PLAN (its date cleared, only worked days left as history) has nothing to move:
  // "move it to Friday" from its history tile is a placement, the new day its plan and the history
  // left where it happened. Moving the history day itself would stretch the plan from it.
  const { data: planRow } = await supabase.from("jobs").select("scheduled_start").eq("id", jobId).maybeSingle();
  if (planRow && !(planRow as { scheduled_start?: string | null }).scheduled_start) {
    return placeOnDays(supabase, jobId, toDate);
  }

  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  // The range's worked days stay where they happened; only its unworked remainder moves.
  const tz = await orgTimezone(supabase);
  const w = segments.length ? await workedDaysForJob(supabase, jobId, tz) : { days: [] };
  if ("error" in w) return { ok: false, error: w.error };
  const plan = moveKeepingWorkedDays(segments, from, toDate, w.days, todayStrInTz(tz));
  const res = await writeScheduleRanges(supabase, jobId, plan.segments, undefined, plan.mirror);
  if (!res.ok || !plan.kept.length) return res;
  const span = plan.moved.start === plan.moved.end ? dayList([plan.moved.start]) : `${dayList([plan.moved.start])} to ${dayList([plan.moved.end])}`;
  const rest =
    plan.workedInRange >= plan.rangeDays
      ? `Every day of that range was worked, so ${span} is added as a new day.`
      : `The ${plan.rangeDays - plan.workedInRange === 1 ? "day not yet worked" : `${plan.rangeDays - plan.workedInRange} days not yet worked`} moved to ${span}.`;
  return { ...res, kept: plan.kept, note: `${keptLine(plan.kept)} ${rest}` };
}

/** The days this job's work actually happened, up to now (workedDaysFrom says what counts). A
 *  read that fails is an error, never "no days worked": that would erase the history this guard
 *  exists to keep. */
async function workedDaysForJob(
  supabase: SupabaseClient,
  jobId: string,
  tz: string,
): Promise<{ days: string[] } | { error: string }> {
  const nowIso = new Date().toISOString();
  const [entriesRes, visitsRes] = await Promise.all([
    supabase.from("time_entries").select("clock_in").eq("job_id", jobId).lte("clock_in", nowIso),
    supabase.from("appointments").select("starts_at, status").eq("job_id", jobId).lte("starts_at", nowIso),
  ]);
  if (entriesRes.error) return { error: dbError(entriesRes.error) };
  if (visitsRes.error) return { error: dbError(visitsRes.error) };
  return {
    days: workedDaysFrom(
      (entriesRes.data ?? []) as { clock_in: string | null }[],
      (visitsRes.data ?? []) as { starts_at: string | null; status: string | null }[],
      tz,
    ),
  };
}

/** "Sep 22", "Sep 22 and Sep 23", "Sep 18, Sep 22 and Sep 23". */
function dayList(days: string[]): string {
  const f = days.map((d) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  );
  return f.length <= 1 ? (f[0] ?? "") : `${f.slice(0, -1).join(", ")} and ${f[f.length - 1]}`;
}

/** The first half of the note both reschedule verbs return when they kept a worked day. */
function keptLine(kept: string[]): string {
  return `Kept ${dayList(kept)} on the calendar: work was done ${kept.length > 1 ? "on those days" : "that day"}.`;
}

/** Schedule a job's work window (Nort's job.scheduleDay). Used to be a bare
 *  setJobScheduleRanges([window]), which replaced the whole schedule and so erased the days
 *  already worked (Honeysuckle, 2026-09-24).
 *
 *  A RESCHEDULE MOVES THE PLAN, NOT THE HISTORY. The window still replaces the plan, but every
 *  day that was on the old schedule and was WORKED stays on the calendar, and the result says
 *  which, so nobody wonders why the job still shows on the 22nd. The job's listed start
 *  (jobs.scheduled_start, read by the Jobs list, Nort's schedule overview and the Google event)
 *  follows the new window, not the kept day. The range editor on the job page stays a raw
 *  whole-set edit: a person deleting a range there is choosing to, and the calendar undo must
 *  restore exactly what it saved. */
export async function scheduleJobWindow(
  jobId: string,
  start: string,
  end?: string | null,
): Promise<Result & { note?: string; kept?: string[]; defaulted?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "")) return { ok: false, error: "Pick a day to schedule it on." };
  const win = { start, end: end && /^\d{4}-\d{2}-\d{2}$/.test(end) && end >= start ? end : start };
  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  const tz = await orgTimezone(supabase);
  const w = segments.length ? await workedDaysForJob(supabase, jobId, tz) : { days: [] };
  if ("error" in w) return { ok: false, error: w.error };
  const plan = keepWorkedDays(segments, [win], w.days, todayStrInTz(tz));
  // writeScheduleRanges revalidates /schedule, /planner, /jobs, and the job page.
  const res = await writeScheduleRanges(supabase, jobId, plan.segments, undefined, plan.mirror);
  if (!res.ok || !plan.kept.length) return res;
  const span = win.start === win.end ? dayList([win.start]) : `${dayList([win.start])} to ${dayList([win.end])}`;
  return { ...res, kept: plan.kept, note: `${keptLine(plan.kept)} The job is now scheduled ${span}.` };
}

/** PLACE a job on a day — the rail's and the tray's gesture. A needs-return job keeps its
 *  worked-history segments on the calendar, but they stay HISTORY: the job's listed span (its
 *  start, its end, its length) is the newly placed day(s) alone, the way moveJobDay and
 *  scheduleJobWindow write it. Unioning the history into the span made a Clear The Date job put back
 *  on Oct 5 at 9:00 one block from its Sep 22 worked day to Oct 5 at closing, its chosen time and
 *  length gone. A job with no live plan (dateless, date cleared, or on hold with a stale date) gets
 *  the new day(s) as its plan, its worked days kept and its stale unworked days dropped; a job that
 *  already has a plan gets the day(s) added to it. */
export async function placeJobOnDay(
  jobId: string,
  dateISO: string,
  /** "HH:MM" in the org's timezone. Omitted preserves whatever real time the job already carries —
   *  the branch a plain day-move relies on. A FLOATER carries none, so without this it silently
   *  fell back to the all-day window and landed at 8am on an afternoon he had just chosen. The
   *  length is the job's own (its size, else the block it has); a job with neither lands as two
   *  hours and the answer says so (`defaulted`). */
  startHHMM?: string,
): Promise<Result & { defaulted?: boolean; prior?: PlacePrior }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  return placeOnDays(ctx.supabase, jobId, dateISO, startHHMM);
}

/**
 * WHAT A PLACE CHANGED, READ BEFORE THE WRITE, so the rail's Undo can put it back (W2-05): the days as
 * they stood (their own hours with them), the status, and the listed span (its company days and its
 * exact start and end), plus the days the job has AFTER the place, so an Undo can tell the job has
 * changed since. The tray's old Undo put the days back and left a job 'Scheduled' with no date.
 */
export type PlacePrior = {
  ranges: DateRange[];
  status: string | null;
  listed: { start: string; end: string; startIso: string | null; endIso: string | null } | null;
  days: string[];
};

/** The body of placeJobOnDay, for callers that already passed requireStaff (moveJobDay's move of a
 *  job with no plan is a placement). */
async function placeOnDays(
  supabase: SupabaseClient,
  jobId: string,
  dateISO: string,
  startHHMM?: string,
): Promise<Result & { defaulted?: boolean; prior?: PlacePrior }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: "Pick a day." };
  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };

  /* AS MANY DAYS AS IT TAKES. A job sized at three days used to land on one, leaving the next two
     looking free — the exact overbooking the sizes exist to prevent. The day he tapped is always
     day one; the rest skip the weekend (see workingDaysFrom). */
  const { data: sizeRow } = await supabase
    .from("jobs")
    .select("planned_minutes, status, scheduled_start, scheduled_end") // PROJECTION LAW: all four are read below
    .eq("id", jobId)
    .maybeSingle();
  const row = sizeRow as {
    planned_minutes?: number | null;
    status?: string | null;
    scheduled_start?: string | null;
    scheduled_end?: string | null;
  } | null;
  const days = workingDaysFrom(dateISO, daysNeeded(row?.planned_minutes));
  // The placed days run on the job's usual hours (the time chosen here), never hours an old day left.
  const placed = days.reduce<DateRange[]>((acc, d) => addDaySegment(acc, d, null), []);
  const newSpan = { start: days[0], end: days[days.length - 1] };

  /* THE NEW DAY(S) ARE THE PLAN; THE HISTORY STAYS HISTORY. */
  const tz = await orgTimezone(supabase);
  let write: { segments: DateRange[]; mirror: DateRange };
  if (!row?.scheduled_start || row.status === "on_hold") {
    // No live plan: the kept worked days stay on the calendar, a stale unworked day goes.
    const w = segments.length ? await workedDaysForJob(supabase, jobId, tz) : { days: [] };
    if ("error" in w) return { ok: false, error: w.error };
    const plan = keepWorkedDays(segments, placed, w.days, todayStrInTz(tz));
    write = { segments: plan.segments, mirror: plan.mirror ?? newSpan };
  } else {
    // A live plan: the day(s) join it, and the listed span grows to cover them, never a history day.
    const first = todayStrInTz(tz, new Date(row.scheduled_start));
    const lastRaw = row.scheduled_end ? todayStrInTz(tz, new Date(row.scheduled_end)) : first;
    const last = lastRaw > first ? lastRaw : first;
    write = {
      segments: days.reduce((acc, d) => addDaySegment(acc, d, null), segments),
      mirror: { start: first < newSpan.start ? first : newSpan.start, end: last > newSpan.end ? last : newSpan.end },
    };
  }

  /* WHAT THIS PLACE CHANGES, READ BEFORE IT WRITES (the rail's Undo). The listed span in company days
     and its exact instants; the days as they stood; the days as they will be. */
  const listed = row?.scheduled_start ? planSpan(row, tz) : null;
  const prior: PlacePrior = {
    ranges: segments,
    status: row?.status ?? null,
    listed: listed ? { ...listed, startIso: row?.scheduled_start ?? null, endIso: row?.scheduled_end ?? null } : null,
    days: segmentDays(write.segments),
  };

  /* GIVING SOMETHING A DAY IS THE OPPOSITE OF PARKING IT. An on-hold job now appears on the rail
     even when it carries a stale date (Erik: "we need everything on hold to pop up on that list"),
     so placing one has to take it off hold — otherwise it lands on the calendar AND stays on the
     board forever, which is a loop rather than a decision. advanceToScheduled deliberately only
     promotes to_be_scheduled/estimate, so this is its own explicit write. */
  if (row?.status === "on_hold") {
    // The reason leaves WITH the hold — same wake rule as setJobHold, or "waiting on the permit"
    // keeps haunting a job that's back on the calendar. The day it was coming back and who held it
    // leave too: the database clears hold_reason, hold_until and hold_by whenever a job comes off
    // hold (jobs_hold_day, 0366), so this door can never leave a stale day behind.
    await supabase
      .from("jobs")
      .update({ status: "scheduled", hold_reason: null })
      .eq("id", jobId)
      .eq("status", "on_hold");
  }
  // writeScheduleRanges revalidates /schedule, /planner, /jobs, and the job page.
  // undefined (not null) when no time was given, so the preserve-the-job's-own-time branch stands.
  const res = await writeScheduleRanges(
    supabase,
    jobId,
    write.segments,
    /^\d{2}:\d{2}$/.test(startHHMM ?? "") ? startHHMM : undefined,
    write.mirror,
  );
  return res.ok ? { ...res, prior } : res;
}

/** The statuses a place moves forward to Scheduled (advanceToScheduled), the only ones an Undo puts back. */
const PLACE_PROMOTES = ["to_be_scheduled", "estimate"];

/** A PlacePrior as the client sent it back, checked: well-formed days, a real status, at most a year of
 *  days. Null when it isn't one. */
function readPlacePrior(p: unknown): PlacePrior | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const ymd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const iso = (v: unknown): string | null => (typeof v === "string" && !isNaN(new Date(v).getTime()) ? v : null);
  if (!Array.isArray(o.ranges) || o.ranges.length > 400 || !Array.isArray(o.days) || o.days.length > 1000) return null;
  const ranges: DateRange[] = [];
  for (const r of o.ranges as Record<string, unknown>[]) {
    if (!r || !ymd(r.start) || !ymd(r.end)) return null;
    const h = r.hours as { start?: unknown; end?: unknown } | null | undefined;
    const hours = h === undefined ? undefined : h === null ? null : readDayHours(h?.start, h?.end);
    ranges.push(hours === undefined ? { start: r.start, end: r.end } : { start: r.start, end: r.end, hours });
  }
  if (!(o.days as unknown[]).every(ymd)) return null;
  const status = typeof o.status === "string" && (JOB_STATUSES as readonly string[]).includes(o.status) ? o.status : null;
  let listed: PlacePrior["listed"] = null;
  if (o.listed) {
    const l = o.listed as Record<string, unknown>;
    if (!ymd(l.start) || !ymd(l.end)) return null;
    listed = { start: l.start, end: l.end, startIso: iso(l.startIso), endIso: iso(l.endIso) };
  }
  return { ranges, status, listed, days: [...(o.days as string[])].sort() };
}

/**
 * UNDO ON THE RAIL'S PLACE (W2-05): the job goes back to exactly where it was: its days (their own
 * hours with them), its listed span (none for a dateless job, whose place also gave it the 2-hour
 * default block: that goes too), and its status when the place moved it to Scheduled. Through the one
 * writer, with the status held still (promote: false) while the days go back.
 *
 * Refused in words, with nothing written, when the job changed since (its days are no longer the days
 * the place left), and for a job the place took off hold (the rail offers no Undo there: putting a
 * hold back needs its reason and its day). A status that moved on since (someone started the job) is
 * left as it is, and the answer says so.
 */
export async function undoPlaceJob(jobId: string, prior: PlacePrior): Promise<Result & { note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const p = readPlacePrior(prior);
  if (!p) return { ok: false, error: "There's nothing to put back." };
  if (p.status === "on_hold") return { ok: false, error: "Undo can't put a job back on hold. Hold it again from its ⋯ on the rail." };

  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  if (segmentDays(segments).join(",") !== p.days.join(",")) return { ok: false, error: "It changed since, so nothing was undone." };

  const res = await writeScheduleRanges(
    supabase,
    jobId,
    p.ranges,
    undefined,
    p.listed ? { start: p.listed.start, end: p.listed.end } : "none",
    undefined,
    { promote: false, listedAt: { start: p.listed?.startIso ?? null, end: p.listed?.endIso ?? null } },
  );
  if (!res.ok) return { ok: false, error: res.error };

  if (p.status && PLACE_PROMOTES.includes(p.status)) {
    const { data: back, error } = await supabase
      .from("jobs")
      .update({ status: p.status, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "scheduled")
      .select("id");
    if (error) return { ok: true, note: "Its days are back, but its status didn't change back. Check it on the job page." };
    if (!back?.length) return { ok: true, note: "Its days are back. Its status had moved on since, so it stays as it is." };
  }
  return { ok: true };
}

/**
 * UNDO ON THE RAIL'S PLACE, FOR A VISIT (W2-05): the visit goes back to Waiting For A Day — but only
 * if it is still where the place put it.
 *
 * unscheduleAppointment alone only asks whether the status is scheduled or proposed, so for the ten
 * seconds the Undo toast lives, anyone moving or resizing that visit (another tab, another device, the
 * second office person) lost their newer time to a tap of Undo that reported "Put back where it was."
 * A job's Undo has refused a changed job since it was written; this is the same promise for a visit.
 *
 * The guard is the WRITE's own WHERE, not a read beside it: one UPDATE that touches nothing a person
 * reads (updated_at), matched on the start the place wrote, and a zero-row answer is the refusal (the
 * silent-write law). The deed itself stays with the one writer that owns it — unscheduleAppointment,
 * which also cancels a pending pick-a-time link, puts "pending pick" back to scheduled, deletes the
 * Google event and revalidates. Idempotent: it finds the start already cleared on the second pass.
 */
export async function undoPlaceVisit(id: string, placedAt: string): Promise<Result & { note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!id || typeof placedAt !== "string" || isNaN(Date.parse(placedAt))) return { ok: false, error: "There's nothing to put back." };

  const { data: still, error } = await ctx.supabase
    .from("appointments")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("starts_at", new Date(placedAt).toISOString())
    .in("status", ["scheduled", "proposed"])
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!still?.length) return { ok: false, error: "It changed since, so nothing was undone." };

  return unscheduleAppointment(id);
}

/**
 * UNDO A PLACEMENT of a job that had no day: the plan leaves again and its worked days stay as
 * history, exactly the state it was placed from. The calendar tray's Undo. It used to write the
 * snapshot back through setJobScheduleRanges, which turned a kept worked day into the job's plan.
 */
export async function unplaceJob(jobId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const res = await clearPlan(ctx.supabase, jobId);
  if (!res.ok) return { ok: false, error: res.error };
  // The placement moved To Be Scheduled to Scheduled; putting it back puts that back too.
  await ctx.supabase.from("jobs").update({ status: "to_be_scheduled" }).eq("id", jobId).eq("status", "scheduled").select("id");
  return { ok: true };
}

/** The plan leaves, the worked days stay as history segments, the listed day goes (mirror "none").
 *  Clear The Date and the tray's Undo. */
async function clearPlan(supabase: SupabaseClient, jobId: string): Promise<Result & { kept?: string[] }> {
  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  const tz = await orgTimezone(supabase);
  const w = segments.length ? await workedDaysForJob(supabase, jobId, tz) : { days: [] };
  if ("error" in w) return { ok: false, error: w.error };
  const plan = keepWorkedDays(segments, [], w.days, todayStrInTz(tz));
  const res = await writeScheduleRanges(supabase, jobId, plan.segments, undefined, "none");
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, kept: plan.kept };
}

/**
 * A JOB'S START AND LENGTH, ON THE DAYS IT ALREADY HAS: the job page's time controls and the schedule
 * tile's sheet. Erik (2026-09-28): "within the job itself i could only set a start time and no end
 * time and on the schedule itself there should be a time adjustment".
 *
 * `start` "HH:MM" (undefined keeps it); `length` minutes or "full" (undefined keeps it). The days are
 * read fresh here and written back unchanged, so a worked day kept as history stays, and the job's
 * listed span (the plan) stays where it is. Through writeScheduleRanges, the one writer: the start,
 * the end and the chosen length land together in one row write, the Google event follows, and a
 * job that isn't there says so (the silent-write law).
 */
export async function setJobTimes(
  jobId: string,
  times: { start?: string; length?: JobLength },
): Promise<Result & { defaulted?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const start = times?.start;
  const length = times?.length;
  if (start !== undefined && readHm(start) == null) return { ok: false, error: "Pick a start time." };
  const bad = lengthProblem(length);
  if (bad) return { ok: false, error: bad };
  if (start === undefined && length === undefined) return { ok: true };

  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  const { data: job } = await supabase.from("jobs").select("scheduled_start, scheduled_end").eq("id", jobId).maybeSingle();
  const j = (job ?? {}) as { scheduled_start?: string | null; scheduled_end?: string | null };
  // A time belongs to a PLANNED day. A job with none (never placed, or its date cleared with only
  // worked days kept as history) gets a day first; a time written onto a history day would make that
  // past day its plan.
  if (!segments.length || !j.scheduled_start) return { ok: false, error: "Give the job a day first, then its time." };
  const tz = await orgTimezone(supabase);
  const first = todayStrInTz(tz, new Date(j.scheduled_start));
  const last = j.scheduled_end ? todayStrInTz(tz, new Date(j.scheduled_end)) : first;
  const mirror = { start: first, end: last > first ? last : first };
  return writeScheduleRanges(supabase, jobId, segments, start === undefined ? undefined : start.slice(0, 5), mirror, length);
}

/** The job's planned days (its listed span, jobs.scheduled_start/end) as company dates, or null. */
function planSpan(
  j: { scheduled_start?: string | null; scheduled_end?: string | null },
  tz: string,
): DateRange | null {
  if (!j.scheduled_start) return null;
  const first = todayStrInTz(tz, new Date(j.scheduled_start));
  const last = j.scheduled_end ? todayStrInTz(tz, new Date(j.scheduled_end)) : first;
  return { start: first, end: last > first ? last : first };
}

const NEEDS_0370 =
  "A day keeping its own hours needs a quick database update first. Until then, set the time on the job page; it sets every day.";

/**
 * ONE DAY'S TIME, THAT DAY ONLY (0370): the schedule tile's sheet, "This Day". Erik, 2026-09-28: a job
 * over several days had one time of day for all of them, so Honeysuckle's afternoon after Siskin could
 * only land at its usual hours. The job page's time control still sets the job's USUAL hours (every
 * day without its own, setJobTimes); this sets one day's.
 *
 * `start` "HH:MM" (the length stays, the writer's keep rule: lib/schedule/day-hours nextDayHours, the
 * same the Start box predicts), `length` minutes or "full", or `usual` to hand the day back to the
 * job's usual hours. The job's one day (a one-day plan) IS the job's time, so there the job's hours
 * move (setJobTimes' writer), and the Google event, the Jobs list and My Day read the same.
 *
 * Through writeScheduleRanges, the one writer: the day's hours land in its segment, every other day
 * keeps its own, the job's span stays where it is, and a job that isn't there says so. Before 0370 a
 * day can't keep hours of its own, and this says so in words.
 */
export async function setJobDayTimes(
  jobId: string,
  day: string,
  patch: { start?: string; length?: JobLength; usual?: boolean },
): Promise<Result & { defaulted?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return { ok: false, error: "Pick a day." };
  const start = patch?.start;
  const length = patch?.length;
  const usual = patch?.usual === true;
  if (start !== undefined && readHm(start) == null) return { ok: false, error: "Pick a start time." };
  const bad = lengthProblem(length);
  if (bad) return { ok: false, error: bad };
  if (start === undefined && length === undefined && !usual) return { ok: true };

  const { segments, perDayHours, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  if (!coversDay(segments, day)) return { ok: false, error: `That job isn't on ${dayWords(day)} any more. Reload the schedule to see where it is.` };
  // PROJECTION LAW: every column read below.
  const { data: row } = await supabase.from("jobs").select("scheduled_start, scheduled_end, planned_minutes").eq("id", jobId).maybeSingle();
  if (!row) return { ok: false, error: "That job isn't available." };
  const j = row as { scheduled_start: string | null; scheduled_end: string | null; planned_minutes: number | null };
  const { tz, dayStartHm, dayEndHm } = await orgSchedulePrefs(supabase);
  const plan = planSpan(j, tz);

  // THE JOB'S ONE DAY: its time is the job's.
  if (!usual && plan && plan.start === day && plan.end === day) {
    return writeScheduleRanges(supabase, jobId, segments, start === undefined ? undefined : start.slice(0, 5), plan, length);
  }
  if (!perDayHours) return { ok: false, error: NEEDS_0370 };

  let hours: DayHours | null = null;
  if (!usual) {
    const wd = workDayMinutes({ start: dayStartHm, end: dayEndHm });
    const own = hoursOnDay(segments, day) ?? null;
    const before = jobDayBlock({
      day,
      scheduledStart: j.scheduled_start,
      scheduledEnd: j.scheduled_end,
      plannedMinutes: j.planned_minutes,
      tz,
      wd,
      dayHours: own,
    });
    hours = nextDayHours({
      before,
      own: !!own,
      plannedMinutes: j.planned_minutes ?? null,
      patch: start !== undefined ? { start: start.slice(0, 5) } : { length: length as JobLength },
      wd,
    });
    if (!hours) return { ok: false, error: "That time doesn't work. Pick a start and a length." };
  }
  // The job's span stays as it is (none stays none): only this day's hours change.
  return writeScheduleRanges(supabase, jobId, setDayHours(segments, day, hours), undefined, plan ?? "none");
}

/**
 * ADD TO SCHEDULE, FOR ANY JOB, FROM THE SCHEDULE (Erik, 2026-09-28, at night: "im on the schedule page
 * and i want to put honysuckle on the page for the rest of the day after Siskin but theres no way to add
 * to the schedule from the schedule page unless its already scripted"). The rail lists only jobs with
 * no day (or on hold); an in-progress job over several days had no door to another day.
 *
 * ADDS the day to the job, like placeJobOnDay: every other day stays (the worked ones too), and
 *   · a job with a live plan (a day, not on hold) keeps it, the day joins it with ITS OWN HOURS (0370)
 *     and the span grows to cover it; any other day whose drawn block that growth would change keeps the
 *     block it had (lib/schedule/day-hours freezeDrawnDays). Adding a day never moves another.
 *   · a job with no live plan (no day, its date cleared, or on hold with an old one) gets this day as
 *     its plan at these hours; worked days stay as history, stale unworked days go; an on-hold job comes
 *     off hold (its reason with it; the database clears its day and who held it, 0366).
 * `start` "HH:MM" (else the work day's start), `length` minutes or "full" (else the job's size, else two
 * hours, said: `defaulted`), `crew` the people put on and taken off in the sheet, applied to the crew as
 * saved now (setJobCrew rings the bell for someone new).
 *
 * Refused in words: a day of its plan it's already on (its block there is where its time is changed; a
 * day it sits on only as history takes the add), a finished job, a pick-a-date link out (asked first,
 * like a move: `needsProposalConfirm`). Before 0370 the day can't keep its own hours: it's added at the
 * job's usual hours and the note says the hours it draws, and an add that would redraw another of the
 * job's days (its span grows past a day with a timed block) is refused in words. Nothing silent.
 */
export async function addJobDay(
  jobId: string,
  p: { day: string; start?: string; length?: JobLength; crew?: { add?: string[]; remove?: string[] } },
  opts?: { cancelProposals?: boolean },
): Promise<Result & { needsProposalConfirm?: boolean; note?: string; defaulted?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const day = String(p?.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: "Pick a day." };
  const start = p?.start ? String(p.start).slice(0, 5) : undefined;
  if (start !== undefined && readHm(start) == null) return { ok: false, error: "Pick a start time." };
  const bad = lengthProblem(p?.length);
  if (bad) return { ok: false, error: bad };

  // THE JOB AS IT STANDS. PROJECTION LAW: every column read below is in the list.
  const { data: row, error: readErr } = await supabase
    .from("jobs")
    .select("id, name, status, scheduled_start, scheduled_end, planned_minutes, assigned_to")
    .eq("id", jobId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!row) return { ok: false, error: "That job isn't available. It may have been deleted." };
  const job = row as {
    name: string | null;
    status: string | null;
    scheduled_start: string | null;
    scheduled_end: string | null;
    planned_minutes: number | null;
  };
  const called = job.name?.trim() || "That job";
  if (!(ACTIVE_JOB_STATUSES as string[]).includes(String(job.status ?? ""))) {
    return { ok: false, error: `${called} is ${jobStatusLabel(String(job.status ?? ""))}, so it can't take another day. Change its status on the job page first.` };
  }

  const { segments, perDayHours, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  const { tz, dayStartHm, dayEndHm } = await orgSchedulePrefs(supabase);
  const onHold = job.status === "on_hold";
  // THE LIVE PLAN (a day, not on hold): its span, else none.
  const plan = onHold ? null : planSpan(job, tz);
  /* A DAY OF ITS PLAN IT'S ALREADY ON is refused: its block there is the door (This Day's time, the
     crew). A day it sits on only as HISTORY (worked, outside the plan; or any day of a job with no live
     plan) takes the add: that day becomes a planned day at these hours. Refusing it would send the
     office to a block whose sheet says the time belongs to the plan: a dead end. */
  if (plan && day >= plan.start && day <= plan.end && coversDay(segments, day)) {
    return { ok: false, error: `${called} is already on ${dayWords(day)}. Tap its block there to change its time or crew.` };
  }

  // THE DAY'S HOURS, as the sheet showed them: the start (the tapped time, else the work day's start)
  // and the length (chosen; else the job's size; else two hours, said).
  const wd = workDayMinutes({ start: dayStartHm, end: dayEndHm });
  const s = readHm(start ?? dayStartHm) ?? wd.startMin;
  const size = Math.max(0, Number(job.planned_minutes ?? 0) || 0);
  let defaulted = p.length === undefined && size === 0;
  let hours: DayHours =
    p.length === "full"
      ? dayHoursOf(wd.startMin, wd.endMin)
      : typeof p.length === "number"
        ? dayHoursOf(s, s + Math.round(p.length))
        : size >= WORK_DAY_MINUTES
          ? dayHoursOf(s, wd.endMin > s ? wd.endMin : s + 60)
          : dayHoursOf(s, s + (size || DEFAULT_JOB_MINUTES));

  /* A LIVE PLAN: the day joins it with its own hours, the span grows to cover it, and no other day moves
     (a history day taken back into the plan gets these hours in place of the ones it ran). Worked out
     BEFORE anything is written or withdrawn, so a refusal below changes nothing. */
  let live: { mirror: DateRange; days: DateRange[] } | null = null;
  if (plan) {
    const mirror = { start: plan.start < day ? plan.start : day, end: plan.end > day ? plan.end : day };
    // The span as the writer will store it: the same rule, the same inputs (the start and the length kept).
    const after = planJobTimes({
      firstDay: mirror.start,
      lastDay: mirror.end,
      tz,
      workDay: { start: dayStartHm, end: dayEndHm },
      prior: { scheduledStart: job.scheduled_start, scheduledEnd: job.scheduled_end, plannedMinutes: job.planned_minutes },
    });
    const afterMirror = { scheduledStart: after.startIso, scheduledEnd: after.endIso, plannedMinutes: after.plannedMinutes ?? job.planned_minutes };
    const frozen = freezeDrawnDays({
      segments: addDaySegment(segments, day, perDayHours ? hours : null),
      before: { scheduledStart: job.scheduled_start, scheduledEnd: job.scheduled_end, plannedMinutes: job.planned_minutes },
      after: afterMirror,
      tz,
      wd,
      skip: [day],
    });
    if (perDayHours) {
      live = { mirror, days: frozen.segments };
    } else {
      /* BEFORE 0370 NO DAY CAN KEEP ITS BLOCK, so a span that grows would redraw the job's other days
         (Siskin's one day 10 to 12 would draw 10 to 5 the moment Wed joins it, and stay that way after
         0370 runs): refused in words, nothing written. A day that redraws no other day goes on at the
         job's usual hours, and the note says the hours it actually draws there. */
      if (frozen.frozen.length) {
        return {
          ok: false,
          error: `Adding ${dayWords(day)} would redraw ${called} on ${frozen.frozen.map((d) => dayWords(d)).join(", ")} at different hours. A day keeping its own hours needs a quick database update first; until then, set its days and time on the job page.`,
        };
      }
      const drawn = jobDayBlock({ day, ...afterMirror, tz, wd, dayHours: null });
      hours = dayHoursOf(drawn.startMin, drawn.endMin);
      defaulted = false;
      live = { mirror, days: addDaySegment(segments, day, null) };
    }
  }

  // A pick-a-date link out: the customer's later tap would land a day the office didn't choose. Asked
  // first, and withdrawn only once nothing else stands in the way of the day going on.
  const { data: pendingPick } = await supabase.from("schedule_proposals").select("id").eq("job_id", jobId).eq("status", "pending").limit(1);
  let withdrew = false;
  if (pendingPick?.length) {
    if (!opts?.cancelProposals) {
      return { ok: false, needsProposalConfirm: true, error: "A date-pick link is out to the customer for this job — adding a day withdraws that link." };
    }
    const { data: gone } = await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending").select("id");
    withdrew = !!gone?.length;
  }

  const notes: string[] = [];
  let res: Result & { defaulted?: boolean };
  if (!live) {
    // NO LIVE PLAN: this day is the plan, at these hours (the job's own, its usual). Worked days stay.
    const w = segments.length ? await workedDaysForJob(supabase, jobId, tz) : { days: [] };
    if ("error" in w) return { ok: false, error: w.error };
    const plan = keepWorkedDays(segments, [{ start: day, end: day, hours: null }], w.days, todayStrInTz(tz));
    res = await writeScheduleRanges(
      supabase,
      jobId,
      plan.segments,
      hours.start,
      plan.mirror ?? { start: day, end: day },
      p.length === undefined || p.length === "full" ? p.length : (readHm(hours.end) ?? 0) - (readHm(hours.start) ?? 0),
      { freshBlock: true },
    );
    if (!res.ok) return res;
    if (onHold) {
      /* GIVING SOMETHING A DAY IS THE OPPOSITE OF PARKING IT (placeJobOnDay's wake): the reason
         leaves with the hold, and the database clears its day and who held it (jobs_hold_day, 0366). */
      const { data: woke } = await supabase
        .from("jobs")
        .update({ status: "scheduled", hold_reason: null, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "on_hold")
        .select("id");
      notes.push(woke?.length ? "It's off hold now." : "It's still marked on hold. Change that on the job page.");
    }
  } else {
    if (!perDayHours) notes.push("A day keeping its own hours needs a quick database update, so for now it shows the job's usual hours.");
    res = await writeScheduleRanges(supabase, jobId, live.days, undefined, live.mirror);
    if (!res.ok) return res;
  }
  if (withdrew) notes.push("The customer's pick-a-date link was withdrawn.");

  // THE CREW, as the sheet left it: each person put on or taken off, applied to the crew as saved NOW.
  const add = (p.crew?.add ?? []).map(String).filter(Boolean);
  const remove = (p.crew?.remove ?? []).map(String).filter(Boolean);
  if (add.length || remove.length) {
    const { data: fresh } = await supabase.from("jobs").select("assigned_to").eq("id", jobId).maybeSingle();
    const now = ((fresh as { assigned_to?: string[] | null } | null)?.assigned_to ?? []).map(String);
    let crew = now;
    for (const id of remove) crew = applyCrewChange(crew, { remove: id });
    for (const id of add) crew = applyCrewChange(crew, { add: id });
    if (crew.join(",") !== now.join(",")) {
      const c = await setJobCrew(jobId, crew);
      if (!c.ok) notes.push(`The crew didn't change: ${c.error ?? "try again on its block"}`);
    }
  }

  const span = `${hmWords(hours.start)} – ${hmWords(hours.end)}`;
  const note = [`Added ${dayWords(day)}, ${span}${defaulted ? " (2 hours; change it on its block)" : ""}.`, ...notes].join(" ");
  return { ok: true, note, ...(defaulted ? { defaulted: true } : {}) };
}

/**
 * CLEAR THE DATE: the job goes back to waiting for a day (the schedule's rail), from the tile's sheet.
 * The plan leaves; a day already WORKED stays on the calendar as history (the Honeysuckle rule), a
 * Scheduled job is To Be Scheduled again (one already under way keeps its status), a pending
 * pick-a-date link is withdrawn so a customer's later tap can't put back a day the office just
 * cleared, and the Google event goes. What was kept or withdrawn comes back in `note`.
 */
export async function clearJobDate(jobId: string): Promise<Result & { note?: string; kept?: string[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const plan = await clearPlan(supabase, jobId);
  if (!plan.ok) return { ok: false, error: plan.error };
  const kept = plan.kept ?? [];
  await supabase.from("jobs").update({ status: "to_be_scheduled" }).eq("id", jobId).eq("status", "scheduled").select("id");
  const { data: withdrawn } = await supabase
    .from("schedule_proposals")
    .update({ status: "cancelled" })
    .eq("job_id", jobId)
    .eq("status", "pending")
    .select("id");
  const notes = [
    kept.length ? keptLine(kept) : null,
    withdrawn?.length ? "The customer's pick-a-date link was withdrawn." : null,
  ].filter(Boolean);
  return { ok: true, kept, ...(notes.length ? { note: notes.join(" ") } : {}) };
}


/**
 * WHAT WAS WORKED ON A JOB ON ONE PAST DAY, on the company's clock: the earliest in to the latest out of
 * every entry on the job that covers the day (an overnight tail included; a stretch never clocked out
 * counts an hour, the ghost's rule). Null when nobody clocked time on the job that day. A failed read is
 * an error, never "nobody": that would refuse a real worked day.
 */
async function workedSpanOn(
  supabase: SupabaseClient,
  jobId: string,
  day: string,
  tz: string,
): Promise<{ span: { startMin: number; endMin: number } | null } | { error: string }> {
  // From the day before (an overnight shift that ran into this day) to the end of this day.
  const from = tzDayStartUtc(shiftYmd(day, -1), tz).toISOString();
  const to = tzDayStartUtc(shiftYmd(day, 1), tz).toISOString();
  const { data, error } = await supabase
    .from("time_entries")
    .select("profile_id, job_id, clock_in, clock_out") // no pay column
    .eq("job_id", jobId)
    .gte("clock_in", from)
    .lt("clock_in", to);
  if (error) return { error: dbError(error) };
  const spans = actualSpans(
    ((data ?? []) as { profile_id: string; job_id: string | null; clock_in: string; clock_out: string | null }[]).map((r) => ({
      profileId: String(r.profile_id),
      jobId: r.job_id ? String(r.job_id) : null,
      clockIn: r.clock_in,
      clockOut: r.clock_out ?? null,
    })),
    tz,
    todayStrInTz(tz),
  ).filter((s) => s.dayStr === day && s.jobId === jobId);
  if (!spans.length) return { span: null };
  return {
    span: {
      startMin: Math.min(...spans.map((s) => s.startMin)),
      endMin: Math.max(...spans.map((s) => s.endMin ?? s.startMin + 60)),
    },
  };
}

/** YYYY-MM-DD `n` days from `ymd` (date math at UTC noon: a clock change never grows or shrinks a day). */
function shiftYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The guards a worked day's booking (and its undo) share: the office, a well-formed day before today
 *  on the company's clock, a job that is there, and clocked time on it that day (never a back-dating
 *  door). Answers the job, its words, the company's clock and that day's worked span. */
async function workedDayGuards(
  supabase: SupabaseClient,
  jobId: string,
  day: string,
): Promise<
  | { ok: true; job: { scheduled_start: string | null; scheduled_end: string | null }; words: string; tz: string; span: { startMin: number; endMin: number } }
  | { ok: false; error: string }
> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return { ok: false, error: "Pick a day." };
  const tz = await orgTimezone(supabase);
  if (day >= todayStrInTz(tz)) return { ok: false, error: "Only a day already past can be booked from the time worked on it." };
  // PROJECTION LAW: every column read below.
  const { data: row, error: readErr } = await supabase
    .from("jobs")
    .select("id, name, job_number, scheduled_start, scheduled_end")
    .eq("id", jobId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!row) return { ok: false, error: "That job isn't available. It may have been deleted." };
  const job = row as { name: string | null; job_number: string | null; scheduled_start: string | null; scheduled_end: string | null };
  const words = jobWords(job);
  const worked = await workedSpanOn(supabase, jobId, day, tz);
  if ("error" in worked) return { ok: false, error: worked.error };
  if (!worked.span) return { ok: false, error: `Nobody clocked time on ${words} on ${dayWords(day)}, so there's nothing to book.` };
  return { ok: true, job, words, tz, span: worked.span };
}

/**
 * BOOK THIS DAY (Wave 2, SV-ghost): a past day somebody worked on a job with nothing booked (the dashed
 * ghost on the schedule) becomes a real block of that job, at the hours actually worked (the earliest in
 * to the latest out) when a day can keep its own hours (0370), else at the job's usual hours.
 *
 * It ADDS THE DAY AND NOTHING ELSE. Never placeJobOnDay or setJobScheduleRanges: those add days forward
 * for a sized job, pull a held job off hold, promote its status and put the listed start back on the
 * past day. Here, through writeScheduleRanges with the job's listed span as it is (or none) and the
 * status held still (promote: false): the status never moves, the listed start never jumps back, a
 * dateless job stays dateless (and waits on the rail), and no hold flips. The Google push re-sends the
 * unchanged listed span, which is harmless.
 *
 * Refused in words: a day that isn't past, a job that isn't there, and a day nobody clocked time on the
 * job (this is never a back-dating door). A day already on the schedule is left as it is (twice-safe:
 * `added` false, and no Undo is offered for it). No Nort verb (the agent-write freeze).
 */
export async function bookWorkedDay(jobId: string, day: string): Promise<Result & { note?: string; added?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const g = await workedDayGuards(supabase, jobId, day);
  if (!g.ok) return { ok: false, error: g.error };
  const { segments, perDayHours, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  if (coversDay(segments, day)) return { ok: true, added: false, note: `${dayWords(day)} is already on ${g.words}'s schedule.` };
  const hours = perDayHours ? dayHoursOf(g.span.startMin, g.span.endMin) : null;
  const res = await writeScheduleRanges(supabase, jobId, addDaySegment(segments, day, hours), undefined, planSpan(g.job, g.tz) ?? "none", undefined, {
    promote: false,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, added: true, note: `Added ${dayWords(day)} to ${g.words}'s schedule.` };
}

/**
 * THE UNDO OF BOOK THIS DAY: that one day comes off the job's schedule (removeDaySegment splits a range
 * the day sits in the middle of), with the same guards and the same held-still status and listed span.
 * It reads the days fresh and takes off only that day: never a whole set sent back from a snapshot.
 */
export async function unbookWorkedDay(jobId: string, day: string): Promise<Result & { note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const g = await workedDayGuards(supabase, jobId, day);
  if (!g.ok) return { ok: false, error: g.error };
  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  if (!coversDay(segments, day)) return { ok: true, note: `${dayWords(day)} isn't on ${g.words}'s schedule.` };
  const res = await writeScheduleRanges(supabase, jobId, removeDaySegment(segments, day), undefined, planSpan(g.job, g.tz) ?? "none", undefined, {
    promote: false,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, note: `Took ${dayWords(day)} off ${g.words}'s schedule.` };
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
 * PUT AN ALREADY-BOOKED INSPECTION ON A DAY.
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
): Promise<Result & { note?: string; /** The start it wrote: the rail's Undo sends it back, so a visit someone moved since is refused. */ placedAt?: string }> {
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
  // The writer's note (a pick-a-time link it withdrew) rides back: the rail's Undo says it stays
  // withdrawn. So does the start that was written, which the Undo matches on before it puts anything
  // back — the exact instant the writer stored (`new Date(...).toISOString()`).
  return res.ok ? { ok: true, placedAt: new Date(startsAt).toISOString(), ...(res.note ? { note: res.note } : {}) } : res;
}

/**
 * A VISIT'S START AND END, from the schedule tile's sheet: the same time controls a job has
 * (lib/schedule/job-block, components/block-time-controls). Wall-clock in, the instants built here in
 * the company's timezone on that date (daylight saving included), never on the phone's clock. Written
 * through rescheduleAppointment, the visit's one time writer: it withdraws a pending pick-a-time link
 * (a stale tap can't move it back), turns "pending pick" into scheduled, and pushes Google. `endDay`
 * is for a visit over several days; the end then falls on that day.
 */
export async function setVisitTimes(
  id: string,
  t: { day: string; start: string; end: string; endDay?: string | null },
): Promise<Result & { note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const day = String(t?.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: "Pick a day." };
  const s = readHm(t?.start);
  const e = readHm(t?.end);
  if (s == null || e == null) return { ok: false, error: "Pick a start and an end." };
  const endDay = t.endDay && /^\d{4}-\d{2}-\d{2}$/.test(t.endDay) && t.endDay >= day ? t.endDay : day;
  if (endDay === day && e <= s) return { ok: false, error: "The end has to be after the start." };
  const tz = await orgTimezone(ctx.supabase);
  const startsAt = tzDateTimeUtc(day, String(t.start).slice(0, 5), tz);
  const endsAt = tzDateTimeUtc(endDay, String(t.end).slice(0, 5), tz);
  if (!startsAt || !endsAt) return { ok: false, error: "I couldn't read that day." };
  return rescheduleAppointment(id, startsAt, endsAt);
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
  /* A KIND THAT ISN'T ONE IS REFUSED (W2-06), in words and with nothing written: the same rule sizeLead
     keeps. Any known kind is taken (the pickers narrow what's offered; a guard never refuses a row's own
     old kind, so an old Quote or Office can be picked again), and "other". Junk used to fall through
     appointmentTypeFor's default and land as an inspection nobody chose. */
  if (patch?.workKind && !isWorkKind(patch.workKind) && patch.workKind !== "other") {
    return { ok: false, error: "That isn't a kind of work." };
  }

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
      /* THE SAME SPAN RULE AS PLACING. This used to clamp to one day, so re-sizing a booked visit
         to "3 days" from the rail kept a one-day ends_at while placing the identical visit walked
         spanEnd across working days — two doors, two calendars. Start day + hour are read back in
         the ORG's clock (a bare Date getter here would hand spanEnd the UTC day — the third
         timezone bug's shape). */
      const tz = await orgTimezone(ctx.supabase);
      const sizedNow = Number(update.planned_minutes ?? 0);
      const mins = tzMinutesOfDay(startsAt, tz);
      const hm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      const span = spanEnd(todayStrInTz(tz, new Date(startsAt)), hm, sizedNow);
      update.ends_at = span ? tzDateTimeUtc(span.lastYmd, span.endHHMM, tz) : null;
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
  /** The jobs being placed. They are never in their own way: neither the block a job already has
   *  on this day nor a visit belonging to it pushes it later (the calendar hides a job's own visit
   *  behind the job, so a push by it was a jump with nothing on screen to explain it). */
  opts?: { jobIds?: string[] },
): Promise<{ ok: boolean; times: string[]; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, times: [], error: ctx.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, times: [], error: "Pick a day." };
  const own = new Set((opts?.jobIds ?? []).map(String));

  const { tz, dayStartHm, dayEndHm } = await orgSchedulePrefs(ctx.supabase);
  const dayStart = tzDayStartUtc(dateISO, tz);
  // The day ends at the NEXT local midnight, resolved on the calendar: a clock-change day is 23 or 25
  // hours long, and start + 24h cut it or ran an hour into tomorrow.
  const next = new Date(`${dateISO}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEnd = tzDayStartUtc(next.toISOString().slice(0, 10), tz);

  // Everything already holding time on this day. A CALL is excluded — it is pinned to the top and
  // costs the route nothing, so it must not push a real visit later.
  /* OVERLAP, NOT A POINT TEST. A three-day service call booked Monday OCCUPIES Tuesday, but a
     starts_at-within-the-day filter could not see it — so the fitter read Tuesday as empty and
     booked an inspection at 9am inside a day the calendar draws as full. Anything that STARTS
     before the day ends and ENDS after it starts is busy here; rows with no end are caught by the
     second arm (they start within the day and occupy their drawn hour). */
  const { data: appts } = await ctx.supabase
    .from("appointments")
    .select("starts_at, ends_at, type, status, job_id, absorbed") // PROJECTION LAW: every column read below
    .lt("starts_at", dayEnd.toISOString())
    .or(`ends_at.gte.${dayStart.toISOString()},and(ends_at.is.null,starts_at.gte.${dayStart.toISOString()})`)
    .limit(200);

  /* PLACED JOBS ARE BUSY TOO. Three audit lenses independently caught the fitter reading only
     appointments — so the day after the a-service-call-is-a-job ruling, the work it now places as
     JOBS was invisible here, and "morning" would fit a new visit straight on top of a placed job:
     the Nora double-booking, resurrected through the very change that fixed her page. Rules:
       timed job (real clock)      → busy for its real span
       untimed but sized           → busy from open for its size
       bare all-day, unsized       → ELASTIC, not busy: an unsized all-day job is exactly the day
                                     Erik squeezes a visit into ("the visit is on the way"), and
                                     blocking it would fight the workflow the rail exists for.
     A work-type appointment SUPERSEDED by its job is skipped — its job now carries the block, and
     counting both would double-width the day.
     THE SAME BLOCK THE CALENDAR DRAWS (lib/schedule/job-block jobDayBlock): a sized job is busy for its
     size, a timed one for its real span, and an all-day one that nobody sized stays elastic. */
  const wd = workDayMinutes({ start: dayStartHm, end: dayEndHm });
  const { data: dayJobs } = await ctx.supabase
    .from("jobs")
    .select("id, scheduled_start, scheduled_end, planned_minutes, status") // PROJECTION LAW: every column read below
    .lt("scheduled_start", dayEnd.toISOString())
    .or(`scheduled_end.gte.${dayStart.toISOString()},and(scheduled_end.is.null,scheduled_start.gte.${dayStart.toISOString()})`)
    .in("status", ["scheduled", "in_progress"])
    .limit(100);

  /* A DAY'S OWN HOURS (0370) are the block that day holds: Honeysuckle's noon to 5 beside its other
     days is busy noon to 5, never its usual full day. Before 0370 there are none (the read without
     the columns), and every job holds its usual block, as before. */
  const { data: daySegs } = await withDayHours((h) =>
    ctx.supabase
      .from("job_schedule_segments")
      .select(segmentCols("job_id, start_date, end_date", h))
      .lte("start_date", dateISO)
      .gte("end_date", dateISO),
  );
  const ownHere = ownHoursByJobDay((daySegs ?? []) as unknown as SegmentRow[]);

  const busy: Busy[] = [];
  for (const j of (dayJobs ?? []) as { id?: string; scheduled_start: string | null; scheduled_end: string | null; planned_minutes: number | null }[]) {
    if (!j.scheduled_start || own.has(String(j.id ?? ""))) continue;
    const dayHours = ownHere.get(String(j.id ?? ""))?.get(dateISO) ?? null;
    const b = jobDayBlock({
      day: dateISO,
      scheduledStart: j.scheduled_start,
      scheduledEnd: j.scheduled_end,
      plannedMinutes: j.planned_minutes,
      tz,
      wd,
      dayHours,
    });
    // Elastic all-day (unsized, no hours of its own) — open to a squeezed visit.
    if (!dayHours && b.allDay && !(Number(j.planned_minutes ?? 0) > 0)) continue;
    busy.push({ startMin: b.startMin, endMin: Math.max(b.startMin + 15, b.endMin) });
  }

  for (const a of (appts ?? []) as { starts_at: string; ends_at: string | null; type: string | null; status: string | null; job_id?: string | null; absorbed?: boolean }[]) {
    if (a.status === "cancelled" || a.type === "call") continue;
    // Absorbed = its JOB owns the slot now (0237), and the jobs loop above already counted it —
    // reading both would double-book the same block against itself.
    if (a.absorbed) continue;
    // The visit of a job being placed is that job's own, never a reason to push it later.
    if (a.job_id && own.has(String(a.job_id))) continue;
    // CLAMPED TO THIS DAY: a span that started yesterday is busy from midnight; one that runs on
    // past tonight is busy to midnight. Only the middle of a multi-day booking reads as full.
    const startsToday = new Date(a.starts_at) >= dayStart;
    const startMin = startsToday ? tzMinutesOfDay(a.starts_at, tz) : 0;
    // An appointment with no end is drawn as an hour, so it occupies an hour. Reading it as a point
    // would let the next visit land inside a block he can see on his screen.
    const endsToday = a.ends_at ? new Date(a.ends_at) < dayEnd : true;
    const endMin = a.ends_at && new Date(a.ends_at) > new Date(a.starts_at)
      ? endsToday ? Math.min(24 * 60, tzMinutesOfDay(a.ends_at, tz) || 24 * 60) : 24 * 60
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

/**
 * PARK A JOB WITH ITS REASON, OR WAKE IT — from the board itself.
 *
 * Erik: "the tupelo job requires a permit so im thinking that any On Hold job should have a
 * reason and therefore needs an action... with the tupelo ln and others ive had to click out to
 * jobs and find it and change the dropdown to on hold from there."
 *
 * The round trip (rail → Jobs → find it → dropdown → back) is exactly the leaving-page-and-back
 * churn the planner exists to kill. And a hold WITHOUT a reason is a shrug: "on hold — waiting on
 * the permit" is an action wearing a status, so the reason is asked for at the moment of parking,
 * the only moment anybody remembers it.
 *
 * EVERY WAIT HAS A DAY (NY-hold, 0366; Erik: "too quiet gets things lost"). `when` is the day it
 * comes back: a day the door worked out ({ date }), or a chip's name ({ pick }) worked out here in
 * the company's timezone. Left out, the database gives a job entering hold a week (jobs_hold_day),
 * and an edit of a held job's reason keeps its day. A day before today is refused in words. Before
 * 0366 is applied the job parks exactly as it always did, with its reason and no day.
 */
export async function setJobHold(jobId: string, reason: string | null, when?: ComeBackWhen | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };

  if (reason !== null) {
    // A HOLD HAS A REASON (0234) — and " " is not one (audit v921). Refuse rather than parking the
    // job with hold_reason NULL, which is exactly the state the migration was written to end.
    const cleanReason = reason.trim();
    if (!cleanReason) return { ok: false, error: "Say why it's on hold — that's what the crew and the customer will read." };
    let holdUntil: string | null = null;
    if (when) {
      const day = resolveComeBack(todayStrInTz(await orgTimezone(ctx.supabase)), when);
      if (!day.ok) return { ok: false, error: day.error };
      holdUntil = day.day;
    }
    const park = (withDay: boolean) =>
      ctx.supabase
        .from("jobs")
        .update({
          status: "on_hold",
          hold_reason: cleanReason,
          ...(withDay && holdUntil ? { hold_until: holdUntil } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .select("id");
    let { data, error } = await park(true);
    // 0366 not applied yet: park exactly as before (the reason), without the day it can't hold yet.
    if (error && holdUntil && isMissingColumn(error)) ({ data, error } = await park(false));
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "That job isn't available." };
  } else {
    // Waking up: back to where its date says it belongs — scheduled if it has one, the waiting
    // room if it doesn't. The reason clears with the hold; a stale reason is a false alarm. (The
    // database clears the day and who held it as well: jobs_hold_day, 0366.)
    const { data: j } = await ctx.supabase.from("jobs").select("scheduled_start").eq("id", jobId).maybeSingle();
    const { data, error } = await ctx.supabase
      .from("jobs")
      .update({
        status: j?.scheduled_start ? "scheduled" : "to_be_scheduled",
        hold_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("status", "on_hold")
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "That job isn't on hold." };
  }
  revalidatePath("/schedule");
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/planner");
  return { ok: true };
}

/**
 * STILL WAITING: A HELD JOB COMES BACK ON ANOTHER DAY (NY-hold, 0366). Moves hold_until and nothing
 * else about the hold: the job stays on hold, held by whoever held it (the database keeps hold_by,
 * jobs_hold_day). A reason is written only when the job has none saved yet (a hold from before 0234)
 * and one is given: a snooze never rewrites the reason the office wrote. The write is its own check
 * (only a job still on hold), and a zero-row write is said, never assumed landed.
 */
export async function snoozeJobHold(jobId: string, when: ComeBackWhen, reason?: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const day = resolveComeBack(todayStrInTz(await orgTimezone(ctx.supabase)), when);
  if (!day.ok) return { ok: false, error: day.error };

  const { data: job, error: readErr } = await ctx.supabase.from("jobs").select("id, status, hold_reason").eq("id", jobId).maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!job) return { ok: false, error: "That job isn't available." };
  if ((job as { status?: string | null }).status !== "on_hold") return { ok: false, error: "That job isn't on hold." };

  const said = (reason ?? "").trim();
  const saved = String((job as { hold_reason?: string | null }).hold_reason ?? "").trim();
  const { data, error } = await ctx.supabase
    .from("jobs")
    .update({ hold_until: day.day, ...(!saved && said ? { hold_reason: said } : {}), updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "on_hold")
    .select("id");
  if (error) {
    return {
      ok: false,
      error: isMissingColumn(error) ? "This needs a quick database update before a hold can take a day." : dbError(error),
    };
  }
  if (!data?.length) return { ok: false, error: "That job isn't on hold." };
  revalidatePath("/planner");
  revalidatePath("/schedule");
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/**
 * A PHONE FOR A JOB, TYPED WHERE THE GAP IS.
 *
 * Erik, on Rhineland: "im not seeing any phone or email or editable spot." A job's contact lives
 * on its CUSTOMER — and Rhineland has no customer at all (born from a walk-in inspection). So:
 *
 *   customer exists, field empty → fill the gap. FILLED IS NEVER OVERWRITTEN from the board — a
 *     customer's number is shared by every job they have, and correcting it belongs on their card
 *     where the change is seen in context. The refusal says so (nothing silent).
 *   no customer at all → the phone IS the fragment that starts one (fragment-first: never demand
 *     the rest first). But WHO first (audit v921): the lead this job came from, then the book by
 *     that very number — a new card only when neither knows them, and never named after the job.
 */
export async function setJobContact(
  jobId: string,
  patch: { phone?: string; email?: string },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const phone = formatPhone(String(patch.phone ?? "").trim());
  const email = String(patch.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email doesn't look right." };
  if (!phone && !email) return { ok: true };

  const { data: job } = await supabase
    .from("jobs")
    // PROJECTION LAW: inquiry_id is read below — the lead is where a customer-less job's PERSON is.
    .select("id, name, customer_id, inquiry_id, created_by")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "That job isn't available." };

  /* WHO IT IS BEFORE MINTING ANYONE (audit v921). This branch used to insert a card named after the
     JOB — "Site inspection: Karen" — for any job with no customer, ignoring both the lead the job
     was born from and the book. Karen ended up twice: once as herself, once as a calendar entry.
     So: the lead's own contact first (customerForInquiry dedups and carries her name and address),
     then the book by the phone/email just typed, and only then a new card. The job's NAME is never
     a person, so it is never a match key. */
  let customerId = (job.customer_id as string | null) ?? null;
  if (!customerId && job.inquiry_id) {
    customerId = await customerForInquiry(supabase, String(job.inquiry_id), ctx.userId);
  }
  if (!customerId) {
    const { data: book } = await supabase.from("customers").select("id, name, company_name, email, phone");
    customerId = findMatchingCustomerId({ phone, email }, (book ?? []) as DupCustomer[]);
  }
  // A job that had none and just got one: the LINK is the deed, so "already on file" isn't a refusal.
  const linkedNow = !job.customer_id && !!customerId;

  if (customerId) {
    const { data: cust } = await supabase
      .from("customers")
      .select("id, phone, email") // PROJECTION LAW: the fill-only rule reads both below
      .eq("id", customerId)
      .maybeSingle();
    if (!cust) return { ok: false, error: "This job's customer isn't available." };
    if (linkedNow) {
      const { data: linked } = await supabase
        .from("jobs")
        .update({ customer_id: cust.id, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .select("id"); // SILENT-WRITE LAW: a zero-row link is a 204, not a linked job
      if (!linked?.length) return { ok: false, error: "That job isn't available." };
    }
    const fill: Record<string, string> = {};
    if (phone && !String(cust.phone ?? "").trim()) fill.phone = phone;
    if (email && !String(cust.email ?? "").trim()) fill.email = email;
    if (!Object.keys(fill).length) {
      if (linkedNow) {
        revalidatePath("/schedule");
        revalidatePath(`/jobs/${jobId}`);
        return { ok: true };
      }
      return { ok: false, error: "This customer already has that on file — change it on their card, where every job sees it." };
    }
    const { error } = await supabase.from("customers").update({ ...fill, updated_at: new Date().toISOString() }).eq("id", cust.id);
    if (error) return { ok: false, error: dbError(error) };
  } else {
    const { data: cust, error } = await supabase
      .from("customers")
      .insert({
        name: job.name || "Customer",
        status: "active",
        phone: phone || null,
        email: email || null,
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (error || !cust) return { ok: false, error: dbError(error) };
    const { data: linked } = await supabase
      .from("jobs")
      .update({ customer_id: cust.id, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .select("id"); // SILENT-WRITE LAW: the new card is useless if the link didn't land
    if (!linked?.length) return { ok: false, error: "That job isn't available." };
  }
  revalidatePath("/schedule");
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
