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
 *  the prod sentry_events sink caught exactly that crash class (null.replace) on a
 *  job page 2026-07-13; one bad row must never take down an RSC tree. */
export const jobStatusLabel = (s: string | null | undefined): string => String(s ?? "").replace(/_/g, " ");
