import { hoursBetween } from "@/lib/utils";

/**
 * THE T&M REPORT-BACK (cn-v1069). "I'll let you know when I get into it far enough" is a promise a
 * time-and-materials job makes at the start and nothing in the app ever brought back: no screen
 * compared the hours clocked to the guess (jobs.planned_minutes), and on Erik's book every finished
 * T&M job with both numbers ran past its guess. This is the ONE rule that says when the office owes
 * the customer a word, and the one sentence that says where the job stands.
 *
 * DUE when the job bills by time (billing_type tm), is in progress, nobody has told the customer
 * yet (report_back_at null), and the first clocked DAY has closed — at least one closed entry whose
 * day, on the company's clock, is before today (a day still being worked is too early to report on).
 * BOUNDED (the badge law): only while the latest closed entry is within `windowDays` of today; a
 * job he has not touched for a while stops asking, and asks again on the next day worked. ONCE per
 * job: Told Them stamps report_back_at and the ask is gone (the Text door stays).
 *
 * The SHAPE is the app's; the explanation (the guess was his labor only? scope grew?) is Erik's.
 */
export interface ReportBackJob {
  id: string;
  status?: string | null;
  billing_type?: string | null;
  /** Total work-load minutes (480 = a day); null = never sized. */
  planned_minutes?: number | null;
  report_back_at?: string | null;
}

export interface ClockedEntry {
  job_id?: string | null;
  status?: string | null;
  clock_in: string;
  clock_out?: string | null;
  lunch_minutes?: number | null;
}

export interface ReportBackStanding {
  /** Closed hours on the job, lunch deducted, to a tenth. */
  hoursIn: number;
  /** The guess in hours, or null when the job was never sized. */
  guessHours: number | null;
  /** The latest closed clock-out (ISO), or null with no closed time. */
  lastWorked: string | null;
  /** "6h in · guess was 8h" / "6h in, no guess". */
  sentence: string;
}

/** Hours to one decimal, "6" not "6.0", "6.5" as is. */
export function tenthHours(h: number): string {
  const r = Math.round(h * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** The standing sentence, from the two figures (shared by the row and the job page's card). */
export function standingSentence(hoursIn: number, plannedMinutes: number | null | undefined): string {
  const guess = plannedMinutes && plannedMinutes > 0 ? plannedMinutes / 60 : null;
  return guess === null ? `${tenthHours(hoursIn)}h in, no guess` : `${tenthHours(hoursIn)}h in · guess was ${tenthHours(guess)}h`;
}

/** Where a job stands: its closed hours against its guess. */
export function reportBackStanding(job: Pick<ReportBackJob, "planned_minutes">, entries: ClockedEntry[], jobId: string): ReportBackStanding {
  let hours = 0;
  let lastWorked: string | null = null;
  for (const e of entries) {
    if (e.job_id !== jobId || e.status === "open" || !e.clock_out) continue;
    hours += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes ?? 0);
    if (!lastWorked || e.clock_out > lastWorked) lastWorked = e.clock_out;
  }
  hours = Math.round(hours * 100) / 100;
  const guessHours = job.planned_minutes && job.planned_minutes > 0 ? job.planned_minutes / 60 : null;
  return { hoursIn: hours, guessHours, lastWorked, sentence: standingSentence(hours, job.planned_minutes) };
}

/** yyyy-mm-dd `days` before `todayStr` (the same cut the leak detectors use). */
function daysBefore(todayStr: string, days: number): string {
  const d = new Date(`${todayStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface ReportBackVerdict {
  due: boolean;
  /** Why not, when not: one word for the tests and the Why line. */
  because: "not_tm" | "not_in_progress" | "told" | "no_closed_day" | "quiet" | null;
  standing: ReportBackStanding;
}

/**
 * Is the office due to tell the customer where this job stands?
 * `dayOf` maps an ISO instant to its yyyy-mm-dd on the company's clock (the caller's timezone).
 */
export function reportBackDue(
  job: ReportBackJob,
  entries: ClockedEntry[],
  opts: { todayStr: string; dayOf: (iso: string) => string; windowDays: number },
): ReportBackVerdict {
  const standing = reportBackStanding(job, entries, job.id);
  if (job.billing_type !== "tm") return { due: false, because: "not_tm", standing };
  if (job.status !== "in_progress") return { due: false, because: "not_in_progress", standing };
  if (job.report_back_at) return { due: false, because: "told", standing };
  const closedBeforeToday = entries.some(
    (e) => e.job_id === job.id && e.status !== "open" && !!e.clock_out && opts.dayOf(e.clock_out) < opts.todayStr,
  );
  if (!closedBeforeToday) return { due: false, because: "no_closed_day", standing };
  if (!standing.lastWorked || opts.dayOf(standing.lastWorked) < daysBefore(opts.todayStr, opts.windowDays)) {
    return { due: false, because: "quiet", standing };
  }
  return { due: true, because: null, standing };
}

/** The text the Text <First> door opens with: a heads-up in plain words, the figures as they stand. */
export function reportBackText(first: string | null, jobName: string, standing: Pick<ReportBackStanding, "hoursIn" | "guessHours">): string {
  const hi = first ? `Hi ${first}, ` : "Hi, ";
  const guess = standing.guessHours === null ? "" : ` of the ${tenthHours(standing.guessHours)} we figured`;
  return `${hi}quick update on ${jobName}: we're about ${tenthHours(standing.hoursIn)} hours in${guess}. I'll have a better read on the total as we go.`;
}
