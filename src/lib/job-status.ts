/**
 * THE job-status spine — one definition so the filter strip, the sort, the "active jobs"
 * reads, and the clock-in promotion can't drift (they had: jobs/page omitted 'cancelled',
 * timeclock/voice carried dead 'lead'/'quoted' that are customer/quote statuses, not jobs).
 * Mirrors the Postgres `job_status` enum (0001_init).
 */
export const JOB_STATUSES = [
  "estimate",
  "scheduled",
  "in_progress",
  "on_hold",
  "complete",
  "invoiced",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Not-yet-finished, not-cancelled — a job that's still "in flight". Used by the jobs list,
 *  schedule/My-Day reads, and the clock-in "this job is now started" promotion. */
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["estimate", "scheduled", "in_progress", "on_hold"];

/** Sort weight for the jobs list: active up top, finished/cancelled sink. */
export const JOB_STATUS_PRIORITY: Record<string, number> = {
  in_progress: 0,
  scheduled: 1,
  on_hold: 2,
  estimate: 3,
  invoiced: 4,
  complete: 5,
  cancelled: 6,
};

/** Human label for a status (the UI's "in_progress" → "in progress"). */
export const jobStatusLabel = (s: string): string => s.replace(/_/g, " ");
