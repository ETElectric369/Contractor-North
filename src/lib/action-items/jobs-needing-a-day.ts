import { shortDay } from "@/lib/come-back-days";
import { todayStrInTz } from "@/lib/tz";

/**
 * JOBS NEEDING A DAY (Wave 1, NY-feeders): ONE rule where there were two.
 *
 * Needs You used to ask twice. "To schedule" was a job with no scheduled_start, and "nothing
 * scheduled next" was a job worked in the last three days with nothing on the calendar. A job worked
 * four days ago with nothing ahead fell between them, and a job whose date had passed without
 * anyone working it was in neither. The one question is: IS ANYTHING AHEAD OF THIS JOB? A job that
 * is still being done (to be scheduled, scheduled or in progress, never on hold: a hold waits with its
 * own day) needs a day when nothing is ahead of it:
 *   · no scheduled_start or scheduled_end today or later,
 *   · no schedule segment ending today or later,
 *   · no visit booked for it today or later (the caller reads those: scheduled, not absorbed),
 *   · nobody clocked in on it right now (the crew is standing on it),
 * and it isn't already on Needs You as a Won estimate (one won job, one line). No three-day window:
 * a job doesn't stop needing a day because a week went by.
 *
 * The why line says what is behind it, in at most 140 characters:
 *   "Never had a day"            never dated, never worked
 *   "Dated Sep 2, never worked"  a day came and went and nobody clocked in on it
 *   "Last day Jun 12"            its schedule ran past the last day anyone worked it
 *   "Worked Sep 25"              the crew was there this week and nothing is next
 *   "Quiet since Sep 11"         worked, but not for over a week
 * plus "· 6 to buy" when its materials list still has lines to buy (materials_needed then skips the
 * job: one job, one row).
 *
 * Pure: every day is the COMPANY's day (`tz`), so the build and the tests read one rule.
 */

/** The statuses a job needing a day can be in. Never on_hold (a hold waits with its own day). */
export const NEEDS_A_DAY_STATUSES: readonly string[] = ["to_be_scheduled", "scheduled", "in_progress"];

/** Worked within this many days reads "Worked Sep 25"; longer ago, "Quiet since Sep 11". */
export const RECENT_WORK_DAYS = 7;

/** The why line's ceiling (the why-line law). */
export const WHY_MAX = 140;

export type NeedDayJob = {
  id: string;
  job_number?: string | null;
  name?: string | null;
  status?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  created_at?: string | null;
  customers?: { name?: string | null } | { name?: string | null }[] | null;
  job_schedule_segments?: { start_date?: string | null; end_date?: string | null }[] | null;
  /** The job's latest time entry (the read embeds one, newest first); more are fine. */
  time_entries?: { clock_in?: string | null }[] | null;
};

export type NeedDayFinding = {
  job: NeedDayJob;
  /** The why line. */
  why: string;
  /** The day it last had anything (worked, or dated), else the day it was made: a pile's pip age. */
  since: string | null;
  /** The company's day someone last clocked in on it, or null. */
  lastWorked: string | null;
  /** Lines still to buy on its list (0 when none). */
  toBuy: number;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The company's day of a stored value: a date as itself, a timestamp in the company's zone. */
export function companyDay(value: string | null | undefined, tz?: string | null): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (YMD.test(v)) return v;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return tz ? todayStrInTz(tz, new Date(t)) : new Date(t).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to` (both yyyy-mm-dd). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

const maxOf = (days: (string | null | undefined)[]): string | null =>
  days.filter((d): d is string => !!d && YMD.test(d)).sort().at(-1) ?? null;
const minOf = (days: (string | null | undefined)[]): string | null =>
  days.filter((d): d is string => !!d && YMD.test(d)).sort()[0] ?? null;

/** The why line for a job with nothing ahead of it. */
export function needDayWhy(p: {
  lastWorked: string | null;
  /** The first day it was dated for, when that day has passed. */
  firstDated: string | null;
  /** The last day it was dated for (its schedule's end), when that day has passed. */
  lastDated: string | null;
  todayStr: string;
  toBuy?: number;
}): string {
  let why: string;
  if (!p.lastWorked) why = p.firstDated ? `Dated ${shortDay(p.firstDated)}, never worked` : "Never had a day";
  else if (p.lastDated && p.lastDated > p.lastWorked) why = `Last day ${shortDay(p.lastDated)}`;
  else if (daysBetween(p.lastWorked, p.todayStr) <= RECENT_WORK_DAYS) why = `Worked ${shortDay(p.lastWorked)}`;
  else why = `Quiet since ${shortDay(p.lastWorked)}`;
  const n = Math.max(0, Math.floor(p.toBuy ?? 0));
  return (n > 0 ? `${why} · ${n} to buy` : why).slice(0, WHY_MAX);
}

/** Every job in `jobs` with nothing ahead of it, with its why line, in the order given. */
export function jobsNeedingADay(input: {
  jobs: readonly NeedDayJob[] | null | undefined;
  todayStr: string;
  /** The company's timezone: every stored timestamp is read as the company's day. */
  tz?: string | null;
  /** Jobs with a visit booked today or later (status scheduled, not absorbed). */
  futureApptJobIds?: ReadonlySet<string>;
  /** Jobs somebody is clocked in on right now. */
  clockedInJobIds?: ReadonlySet<string>;
  /** Jobs already on Needs You as Won (an accepted estimate with no day yet). */
  wonJobIds?: ReadonlySet<string>;
  /** Jobs with a live (sent or paid, not draft, not void) invoice FOR THE WORK, a standard one or
   *  the final draw: billed is done (0205), and sending or paying an invoice never moves
   *  jobs.status, so the status alone can't say so. The caller leaves out deposit and progress
   *  draws: a deposit is money for work still ahead, and that job still needs its day. */
  billedJobIds?: ReadonlySet<string>;
  /** Lines still to buy, per job (the newest list's open lines). */
  toBuy?: ReadonlyMap<string, number>;
}): NeedDayFinding[] {
  const { todayStr } = input;
  const tz = input.tz ?? null;
  const out: NeedDayFinding[] = [];
  for (const j of input.jobs ?? []) {
    if (!j?.id) continue;
    if (!NEEDS_A_DAY_STATUSES.includes(String(j.status ?? ""))) continue;
    if (input.wonJobIds?.has(j.id)) continue;
    if (input.billedJobIds?.has(j.id)) continue; // billed = done (0205)
    if (input.clockedInJobIds?.has(j.id)) continue;
    if (input.futureApptJobIds?.has(j.id)) continue;

    const start = companyDay(j.scheduled_start, tz);
    const end = companyDay(j.scheduled_end, tz);
    if ((start && start >= todayStr) || (end && end >= todayStr)) continue;
    const segs = (j.job_schedule_segments ?? []).filter(Boolean);
    const segEnds = segs.map((s) => companyDay(s.end_date ?? s.start_date, tz));
    if (segEnds.some((d) => !!d && d >= todayStr)) continue;

    const lastWorked = maxOf((j.time_entries ?? []).map((e) => companyDay(e?.clock_in, tz)));
    const past = (d: string | null) => (d && d < todayStr ? d : null);
    const segStarts = segs.map((s) => companyDay(s.start_date, tz));
    const firstDated = past(start) ?? minOf(segStarts.map(past)) ?? minOf(segEnds.map(past));
    const lastDated = maxOf([past(start), past(end), ...segStarts.map(past), ...segEnds.map(past)]);
    const toBuy = Math.max(0, input.toBuy?.get(j.id) ?? 0);
    out.push({
      job: j,
      why: needDayWhy({ lastWorked, firstDated, lastDated, todayStr, toBuy }),
      since: lastWorked ?? lastDated ?? companyDay(j.created_at, tz),
      lastWorked,
      toBuy,
    });
  }
  return out;
}
