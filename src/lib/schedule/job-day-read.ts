/**
 * A JOB'S DAY AS THE CALENDAR DRAWS IT, ONE RULE FOR EVERY READER THAT IS NOT THE GRID (cn-v1165).
 *
 * 2026-11-16: the owner booked tomorrow by voice. Nort made visits of type Job, gave no job a day, and
 * said the jobs were scheduled with the crew; what he read (schedule_overview) could not show a job's
 * later days, its hours on a day or its crew, and what he said after a write was what was asked, not
 * what was stored. Two readers now ask THIS file, so they cannot disagree with each other:
 * schedule_overview (lib/assistant-tools) and the read-back after job.scheduleDay (readJobDay).
 *
 * Nothing here is a new rule. It composes the calendar's own:
 *   WHICH DAYS  lib/schedule/booked-days bookedKeys: segments first (a job with any segment is on its
 *               segments' days only), else its listed scheduled_start..scheduled_end span, each end on
 *               the company's day. The grid's jobDayRanges (app/(app)/calendar/calendar-view.tsx) is
 *               the same rule over the same dayRange; bookedKeys' header says so. Called with no
 *               visits, so a visit on a job never makes a job day.
 *   WHAT HOURS  lib/schedule/job-block jobDayBlock, the function the grid's jobBlockOn calls, with the
 *               day's own start_time/end_time (0370) read by segment-hours ownHoursByJobDay, and the
 *               company's work day (org-settings workDayWindowHm through job-block workDayMinutes).
 *   THE GUARD   the grid's jobBlockOn draws a block with an end not after its start as an hour from the
 *               start; the same guard is here (endAfterStart), so a reader never says a zero-length day
 *               the grid would draw as an hour.
 *   THE EDGE    a block that runs to midnight is SAID as 23:59 on that day, its start/end and its
 *               instant alike (blockEndMin): the company's last minute, as job-block's readJobBlock
 *               and the time controls say it, and an "HH:MM" that the writers accept back (fit-day
 *               hmToMinutes refuses "24:00"). Only the said end is clamped; the order uses the real one.
 *
 * bookedKeys is only as true as the segments it is handed: a job counts as having segments only if one
 * is in the list, so every caller hands it EVERY segment of each job it asks about.
 *
 * Pure but for readJobDay, which reads and never throws. No words catalog; not a "use server" file.
 */
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { tzDateTimeUtc } from "@/lib/tz";
import { bookedKeys } from "./booked-days";
import { jobDayBlock, workDayMinutes } from "./job-block";
import { ownHoursByJobDay, segmentCols, withDayHours, type SegmentRow } from "./segment-hours";
import { minutesToHm } from "./fit-day";

/** One job's block on one day. start/end are 24-hour "HH:MM" on the company's wall clock. */
export type JobDayBlock = { day: string; start: string; end: string; all_day: boolean; own_hours: boolean };

/** block null = the job is not on that day. */
export type JobDayAnswer = { ok: true; block: JobDayBlock | null } | { ok: false; error: string };

/** The fields of a job the rule reads. */
export type DayJobRow = {
  id: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  planned_minutes?: number | null;
};

/** One (job, day) as minutes past the company's midnight; endMin is already guarded (after startMin). */
export type JobDayMinutes<J extends DayJobRow> = { job: J; day: string; startMin: number; endMin: number; allDay: boolean; ownHours: boolean };

const LAST_MINUTE = 23 * 60 + 59;
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The grid's guard, its twin is jobBlockOn in app/(app)/calendar/calendar-view.tsx: an end not after
 *  the start draws as an hour from the start. */
export function endAfterStart(startMin: number, endMin: number): number {
  return endMin > startMin ? endMin : startMin + 60;
}

/** The end as it is SAID: never past the company's last minute of the day (see THE EDGE above). */
export function blockEndMin(endMin: number): number {
  return Math.min(LAST_MINUTE, endMin);
}

/** Every (job, day) inside [firstDay, lastDay] that the calendar draws, with that day's block. */
export function jobDaysInWindow<J extends DayJobRow>(p: {
  jobs: readonly J[];
  segments: readonly SegmentRow[];
  firstDay: string;
  lastDay: string;
  tz: string;
  workDay: { start: string; end: string };
}): JobDayMinutes<J>[] {
  const segs = p.segments.filter((s): s is SegmentRow & { job_id: string } => !!s?.job_id);
  const keys = bookedKeys({ segments: segs, jobs: p.jobs, appointments: [], tz: p.tz });
  const byId = new Map(p.jobs.map((j) => [j.id, j]));
  const own = ownHoursByJobDay(segs);
  const wd = workDayMinutes(p.workDay);
  const out: JobDayMinutes<J>[] = [];
  for (const key of keys) {
    const bar = key.lastIndexOf("|");
    const id = key.slice(0, bar);
    const day = key.slice(bar + 1);
    if (day < p.firstDay || day > p.lastDay) continue;
    const job = byId.get(id);
    if (!job) continue;
    const dayHours = own.get(id)?.get(day) ?? null;
    const b = jobDayBlock({
      day,
      scheduledStart: job.scheduled_start,
      scheduledEnd: job.scheduled_end,
      plannedMinutes: job.planned_minutes ?? null,
      tz: p.tz,
      wd,
      dayHours,
    });
    out.push({ job, day, startMin: b.startMin, endMin: endAfterStart(b.startMin, b.endMin), allDay: b.allDay, ownHours: !!dayHours });
  }
  return out;
}

/** A (job, day) in the words every reader hands on: start/end "HH:MM", the end as said (blockEndMin). */
export function toJobDayBlock(d: Pick<JobDayMinutes<DayJobRow>, "day" | "startMin" | "endMin" | "allDay" | "ownHours">): JobDayBlock {
  return { day: d.day, start: minutesToHm(d.startMin), end: minutesToHm(blockEndMin(d.endMin)), all_day: d.allDay, own_hours: d.ownHours };
}

/** The block's start and its said end as instants (ISO, UTC): the same moments as start/end. */
export function jobDayInstants(d: Pick<JobDayMinutes<DayJobRow>, "day" | "startMin" | "endMin">, tz: string): { starts_at: string | null; ends_at: string | null } {
  return {
    starts_at: tzDateTimeUtc(d.day, minutesToHm(d.startMin), tz),
    ends_at: tzDateTimeUtc(d.day, minutesToHm(blockEndMin(d.endMin)), tz),
  };
}

/** A job's ranges are read up to this many; a job with more is said, never half-read. */
const READ_SEGS_CAP = 1000;

const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? "unknown error");

/**
 * WHAT IS STORED FOR ONE JOB ON ONE DAY, by the rule above: the job, ALL of its ranges (with their own
 * hours when the database has them) and the company's settings. Never throws: a failed read is
 * { ok: false, error }, and block null means the job is not on that day. `supabase` is the caller's
 * own RLS-scoped client, typed as lib/assistant-tools types its own.
 */
export async function readJobDay(supabase: any, jobId: string, day: string): Promise<JobDayAnswer> {
  try {
    if (!jobId) return { ok: false, error: "No job id to read." };
    if (!isYmd(day)) return { ok: false, error: "The day must be YYYY-MM-DD." };
    const [jobRes, segRes, orgRes] = await Promise.all([
      supabase.from("jobs").select("id, scheduled_start, scheduled_end, planned_minutes").eq("id", jobId).maybeSingle(),
      withDayHours((h) =>
        supabase
          .from("job_schedule_segments")
          .select(segmentCols("job_id, start_date, end_date", h))
          .eq("job_id", jobId)
          .limit(READ_SEGS_CAP),
      ),
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);
    if (jobRes?.error) return { ok: false, error: `The job could not be read: ${errText(jobRes.error)}` };
    if (!jobRes?.data) return { ok: false, error: "Job not found." };
    if (segRes?.error) return { ok: false, error: `The job's days could not be read: ${errText(segRes.error)}` };
    if (orgRes?.error) return { ok: false, error: `The company's settings could not be read: ${errText(orgRes.error)}` };
    const segs = ((segRes.data ?? []) as SegmentRow[]).filter((s) => s?.job_id === jobId);
    if (segs.length >= READ_SEGS_CAP) return { ok: false, error: `The job has ${READ_SEGS_CAP} or more date ranges; its day could not be read whole.` };
    const settings = (orgRes?.data as { settings?: unknown } | null)?.settings;
    const tz = getOrgSettings(settings).timezone || "America/Los_Angeles";
    const job = jobRes.data as DayJobRow;
    const [hit] = jobDaysInWindow({ jobs: [{ ...job, id: jobId }], segments: segs, firstDay: day, lastDay: day, tz, workDay: workDayWindowHm(settings) });
    return { ok: true, block: hit ? toJobDayBlock(hit) : null };
  } catch (e) {
    return { ok: false, error: `The job's day could not be read: ${errText(e)}` };
  }
}
