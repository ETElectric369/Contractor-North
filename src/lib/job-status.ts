/**
 * THE job-status spine — one definition so the filter strip, the sort, the "active jobs"
 * reads, and the clock-in promotion can't drift (they had: jobs/page omitted 'cancelled',
 * timeclock/voice carried dead 'lead'/'quoted' that are customer/quote statuses, not jobs).
 * Mirrors the Postgres `job_status` enum (0001_init + 0126).
 *
 * LIFECYCLE REWORK (Erik's yellow pad, 2026-07): an approved estimate becomes a job
 * "to be scheduled" and the ESTIMATE files away — so "estimate" is no longer a job status
 * (estimates live at /quotes), and "invoiced" is no longer a job status (money owed lives
 * in Accounts Receivable, fed by invoices — a job just gets DONE). The DB enum still
 * carries the retired values (Postgres can't drop enum values); a data migration moved
 * every row off them, and this spine is what the app recognizes.
 */
export const JOB_STATUSES = [
  "to_be_scheduled",
  "scheduled",
  "in_progress",
  "on_hold",
  "complete",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Not-yet-finished, not-cancelled — a job that's still "in flight". Used by the jobs list,
 *  schedule/My-Day reads, and the clock-in "this job is now started" promotion. */
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["to_be_scheduled", "scheduled", "in_progress", "on_hold"];

/**
 * WHICH DOOR A STATUS IS WRITTEN THROUGH (M2, Tao J-002).
 *
 *   "set"    the plain status write: the word, and nothing else follows from it (setJobStatus).
 *   "finish" FINISHING, which BILLS THE UNBILLED WORK FIRST (jobs/actions finishJob) — the T&M
 *            Final built as a draft, the nothing-new check, and the hours-and-receipts-off-a-bill
 *            warning. Writing the word alone is the Tao J-002 failure: his job went complete, 19.5
 *            hours were billed nowhere, and they dropped off every screen with nobody told.
 *
 * ONE RULE, ONE PLACE: every door that moves a job's status reads this table instead of carrying its
 * own "if it's complete…", and a NEW job status will not compile until someone says which door it
 * goes through. Erik's laws: one rule, one place; nothing silent.
 */
export const JOB_STATUS_DOOR: Record<JobStatus, "set" | "finish"> = {
  to_be_scheduled: "set",
  scheduled: "set",
  in_progress: "set",
  on_hold: "set",
  complete: "finish",
  cancelled: "set", // a job called off is not a job billed: nothing is drafted, and it never was
};

/** A status that ENDS the job, so it may only be written by finishing it (which bills first). */
export const finishesTheJob = (status: string | null | undefined): boolean =>
  JOB_STATUS_DOOR[String(status ?? "") as JobStatus] === "finish";

/** The statuses a plain status write may set — every one that isn't a finish (the typed table above). */
export const SETTABLE_JOB_STATUSES: JobStatus[] = JOB_STATUSES.filter((s) => JOB_STATUS_DOOR[s] === "set");

/** A job somebody has BEEN on — in progress, or paused after starting. A job still to be
 *  scheduled, or booked for a day ahead, has not started, whatever its bills say: a bill paid
 *  ahead of the visit must never end it (lib/complete-job-when-paid). */
export const STARTED_JOB_STATUSES: JobStatus[] = ["in_progress", "on_hold"];

/** Sort weight for the jobs list: active up top, finished/cancelled sink. Retired enum
 *  values keep a weight so a stray legacy row still sorts sanely instead of NaN-ing. */
export const JOB_STATUS_PRIORITY: Record<string, number> = {
  in_progress: 0,
  scheduled: 1,
  to_be_scheduled: 2,
  on_hold: 3,
  complete: 4,
  cancelled: 5,
  // retired (rows migrated off; kept for stray-row sort safety)
  estimate: 2,
  invoiced: 4,
};

/** Human label for a status (the UI's "in_progress" → "in progress"). Null-tolerant:
 *  a stray null status renders as "" instead of crashing the whole page render —
 *  the prod error_events sink caught exactly that crash class (null.replace) on a
 *  job page 2026-07-13; one bad row must never take down an RSC tree. */
export const jobStatusLabel = (s: string | null | undefined): string => String(s ?? "").replace(/_/g, " ");

/** The row shape the "which job is this person on today" picks need. */
export interface TodayJobPick {
  id: string;
  status?: string | null;
  scheduled_start?: string | null;
  created_at?: string | null;
}

/**
 * Tier 1 of "which job is <person> on today": among their ASSIGNED active jobs, the one
 * scheduled TODAY — a job_schedule_segments row covering the org-local day (multi-range
 * jobs; pass those job ids as `segTodayJobIds`) or a scheduled_start inside the day's
 * bounds (the single-day mirror) — earliest scheduled_start first. SHARED by the
 * clock-in job resolution (timeclock/actions resolveTechJobToday) and the /timeclock
 * crew-assignment board, so the punch and the office's board can't drift (SSOT).
 */
export function pickJobScheduledToday<T extends TodayJobPick>(
  jobs: T[],
  segTodayJobIds: ReadonlySet<string>,
  dayStart: Date,
  dayEnd: Date,
): T | null {
  const today = jobs
    .filter((j) => {
      if (segTodayJobIds.has(j.id)) return true;
      if (!j.scheduled_start) return false;
      const t = new Date(j.scheduled_start).getTime();
      return t >= dayStart.getTime() && t < dayEnd.getTime();
    })
    .sort((a, b) => (a.scheduled_start ?? "9999").localeCompare(b.scheduled_start ?? "9999"));
  return today[0] ?? null;
}

/**
 * The crew board's full pick — where the office sees a member "at" right now:
 *   0. the member's explicit CREW DAY-ASSIGNMENT for the org-local today
 *      (crew_day_assignments, migration 0139) — pass its job_id as
 *      `assignedJobId`. THE PRECEDENCE LAW (Erik, 2026-07-20): when a
 *      day-assignment differs from what any other surface says, the
 *      day-assignment WINS — the board, the job-less clock-in resolution, and
 *      (via the clock-in default) My Day's current job all follow it.
 *   1. an assigned job scheduled TODAY (pickJobScheduledToday — the shared tier),
 *   2. else an assigned job already in_progress,
 *   3. else any other active assigned job,
 * deterministic inside a tier (earliest scheduled today; otherwise most recently
 * created). Tier 0 only fires when the assigned job is actually IN `jobs` (the
 * caller's active set) — a day-assignment pointing at a finished/cancelled job
 * falls through instead of resurrecting it. The clock-in resolution deliberately
 * does NOT take tiers 2–3 per member — a punch never guesses beyond the
 * day-assignment, today's schedule, or the org's one unambiguous in_progress
 * job — but the board must always point somewhere if the member is assigned
 * anywhere, which is why the fallbacks live here.
 */
export function pickMemberCurrentJob<T extends TodayJobPick>(
  jobs: T[],
  segTodayJobIds: ReadonlySet<string>,
  dayStart: Date,
  dayEnd: Date,
  /** Tier 0: the member's crew_day_assignments.job_id for the org-local today (if any). */
  assignedJobId?: string | null,
  /**
   * Tier 0b (0170): the day carries an explicit OFF row — vacation, sick, a day off. This
   * SHORT-CIRCUITS every tier below. Without it there is no answer of "nobody": the fallbacks end
   * in a catch-all that returns the newest job the member is rostered on, so clearing a day just
   * put the same job back one refresh later. That was the whole of "can't unassign Brian".
   */
  isOff?: boolean,
): T | null {
  if (isOff) return null;
  if (assignedJobId) {
    const assigned = jobs.find((j) => j.id === assignedJobId);
    if (assigned) return assigned;
  }
  const today = pickJobScheduledToday(jobs, segTodayJobIds, dayStart, dayEnd);
  if (today) return today;
  const byNewest = [...jobs].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return byNewest.find((j) => j.status === "in_progress") ?? byNewest[0] ?? null;
}
