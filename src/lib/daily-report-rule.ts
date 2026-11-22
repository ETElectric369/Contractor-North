/**
 * THE DAILY REPORT'S ONE RULE (cn-v1174, migration 0411). The owner, 2026-11-21: "ask which job the
 * report is being made for at the time of the report if not determined or split (part of crew leader
 * responsibilities if one is assigned) on clock out we could have if its not there already a one line
 * entry for what did you do today".
 *
 * Pure, so both doors that open the report after a clock-out (the Time Clock page and My Day's Now
 * card) read the SAME answer, and a table pins it (daily-report-rule.test.ts):
 *
 *   · WHO IS ASKED: a crew lead (profiles.crew_lead), while the Daily Reports switch is on (0352).
 *   · WHICH JOB IT IS FOR: the one job the person's CLOSED punches of that day name. None, or more
 *     than one ("split"), means ASK: the sheet offers that day's jobs first and the house's job list
 *     after them, and filing with no job is allowed. One sheet, one report, one job.
 *   · WHERE A REPORT LIVES once it has a job: that job's Time tab, at the section #daily-reports.
 *
 * Never a word catalog here (a lib under src/lib never imports one): the screens say the words.
 */
import { featureOn, type FeatureMap } from "@/lib/features";

/** Is this person asked for the end-of-day report when he clocks out? */
export function asksForDailyReport(crewLead: unknown, features: FeatureMap | null | undefined): boolean {
  return crewLead === true && featureOn(features, "daily_reports");
}

/** A punch of the day, as the rule reads it. Only closed punches count. */
export type ReportPunch = { job_id: string | null; clock_out: string | null; status?: string | null };

/** Which job the report is for: decided, or asked (with the day's jobs to offer first). */
export type ReportJobAnswer = { kind: "job"; jobId: string } | { kind: "ask"; dayJobIds: string[] };

/** The jobs the day's closed punches name, in the order first seen, each once. */
export function dayJobIds(punches: readonly ReportPunch[] | null | undefined): string[] {
  const out: string[] = [];
  for (const p of punches ?? []) {
    if (!p || !p.clock_out || p.status === "open") continue;
    const id = (p.job_id ?? "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The one job the day names, or ASK when it names none or more than one. */
export function reportJobFor(punches: readonly ReportPunch[] | null | undefined): ReportJobAnswer {
  const ids = dayJobIds(punches);
  return ids.length === 1 ? { kind: "job", jobId: ids[0] } : { kind: "ask", dayJobIds: ids };
}

/** Where a report with a job is read: its job's Time tab, at the section the job page names. */
export function dailyReportJobHref(jobId: string): string {
  return `/jobs/${jobId}?tab=time#daily-reports`;
}

/**
 * Where the bell's link (/planner?report=<id>) lands, for a report that is NOT on My Day's card
 * (the card holds only the ones still waiting for review): its job's file when it has a job AND the
 * job page draws its daily reports (it does only while the Daily Reports switch is on), otherwise the
 * one report drawn on the card. A report the reader cannot read lands on My Day.
 */
export type ReportLanding = { kind: "job"; href: string } | { kind: "draw" } | { kind: "none" };
export function reportLanding(
  report: { job_id?: string | null } | null | undefined,
  dailyReportsOn: boolean,
): ReportLanding {
  if (!report) return { kind: "none" };
  const jobId = (report.job_id ?? "").trim();
  // Switch off: the job page has no Daily Reports section, so the link would land on nothing.
  return jobId && dailyReportsOn ? { kind: "job", href: dailyReportJobHref(jobId) } : { kind: "draw" };
}

/**
 * The write named 0411's key or column and the database does not have it yet (the code landed
 * before the migration): Postgres' no-matching-ON-CONFLICT (42P10) or undefined_column (42703), or
 * PostgREST's "not in the schema cache" (PGRST204). Anything else is a real failure.
 */
export function isReportKeyMissing(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "");
  if (code === "42P10" || code === "42703" || code === "PGRST204") return true;
  return /no unique or exclusion constraint matching|column .*job_id.* does not exist|could not find the 'job_id' column/i.test(String(e?.message ?? ""));
}

/**
 * THE JOB A WAITING REPORT IS FOR, named on its row (skeptic, cn-v1174): a person can have two
 * reports waiting for the same day (one per job), and rows that do not say the job read as twins.
 * The name the frozen summary gave that job when the report was filed, when it names it; otherwise
 * the job's own name, or its number when it has no name (the house's screen label, jobLabel). A
 * report with no job, or one read before 0411, says nothing extra: null.
 */
export function reportJobName(
  report: { job_id?: string | null; gps_summary?: { jobs?: { job_id?: string | null; label?: string | null }[] | null } | null },
  job?: { name?: string | null; job_number?: string | null } | null,
): string | null {
  const jobId = (report.job_id ?? "").trim();
  if (!jobId) return null;
  const jobs = Array.isArray(report.gps_summary?.jobs) ? report.gps_summary!.jobs! : [];
  const frozen = (jobs.find((j) => j && j.job_id === jobId)?.label ?? "").trim();
  if (frozen) return frozen;
  const name = (job?.name ?? "").trim();
  const num = (job?.job_number ?? "").trim();
  return name || num || null;
}
