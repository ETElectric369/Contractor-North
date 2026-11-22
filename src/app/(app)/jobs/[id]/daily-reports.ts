import { tolerateMissingColumns } from "@/lib/inspection/schema";
import { reportError } from "@/lib/observe";

/**
 * THE JOB'S FILE HOLDS ITS DAILY REPORTS (cn-v1174, the owner: "Daily reports should be stored with
 * each job's file so it reflects the days work are is recorded where it applies").
 *
 * A report belongs to ONE job: daily_reports.job_id (0411). The Time tab lists the reports whose
 * job_id is this job, newest first. RLS already scopes the read: the office reads every report, a
 * tech reads his own. No write door here: a report is written at clock-out, and Mark Reviewed stays
 * on My Day.
 *
 * THE DEPLOY CAN LAND BEFORE 0411. A select naming a column that is not there yet fails the whole
 * query, so the read goes through the house's tolerateMissingColumns: a missing column (or table)
 * reads as "absent" (no report can name a job yet, so the section is not drawn); any other failure
 * is "failed", which the section SAYS in its place, never drawn as "none".
 */

/** The report's frozen day summary, as far as this page reads it (timeclock's DailyReportSummary). */
type FrozenSummary = { jobs?: readonly { job_id?: string | null; hours?: number | string | null }[] | null } | null;

export type DailyReportRaw = {
  id: string;
  report_date: string | null;
  did_today?: string | null;
  materials_tomorrow?: string | null;
  gps_summary?: FrozenSummary;
  status?: string | null;
  created_at?: string | null;
  profiles?: { full_name?: string | null } | null;
};

export type JobDailyReportRow = {
  id: string;
  day: string | null;
  /** Who wrote it; null when the name could not be read (the section says a stand-in word). */
  who: string | null;
  /** This job's hours out of the report's own frozen summary; null when the summary names none. */
  hours: number | null;
  /** Each only when it has words. */
  didToday: string | null;
  materialsTomorrow: string | null;
  reviewed: boolean;
};

export type JobDailyReportsRead =
  | { state: "ok"; rows: JobDailyReportRow[] }
  | { state: "absent" }
  | { state: "failed" };

/** The select, one place (THE PROJECTION LAW: the section shows nothing this does not carry). */
export const JOB_DAILY_REPORT_COLUMNS =
  "id, report_date, did_today, materials_tomorrow, gps_summary, status, created_at, profiles:profile_id(full_name)";

function said(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/** This job's hours in a report's frozen summary: the sum of its entries for this job (a summary
 *  can name several jobs). null when none names it: nothing is guessed. */
export function hoursForJob(summary: FrozenSummary | undefined, jobId: string): number | null {
  const mine = (summary?.jobs ?? []).filter((j) => j && String(j.job_id ?? "") === String(jobId));
  if (!mine.length) return null;
  const sum = mine.reduce((s, j) => s + (Number(j.hours) || 0), 0);
  return Math.round(sum * 100) / 100;
}

/** THE PURE ROW BUILDER: the reports as the section draws them, newest day first (then newest
 *  filed). */
export function jobDailyReportRows(raw: readonly DailyReportRaw[], jobId: string): JobDailyReportRow[] {
  return [...raw]
    .sort(
      (a, b) =>
        String(b.report_date ?? "").localeCompare(String(a.report_date ?? "")) ||
        String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
    )
    .map((r) => ({
      id: String(r.id),
      day: r.report_date ?? null,
      who: said(r.profiles?.full_name),
      hours: hoursForJob(r.gps_summary, jobId),
      didToday: said(r.did_today),
      materialsTomorrow: said(r.materials_tomorrow),
      reviewed: r.status === "reviewed",
    }));
}

/** The one read: daily_reports.job_id = this job. Never throws. */
export async function readJobDailyReports(
  supabase: { from: (t: string) => any },
  jobId: string,
): Promise<JobDailyReportsRead> {
  try {
    const data = await tolerateMissingColumns<DailyReportRaw[]>(() =>
      supabase
        .from("daily_reports")
        .select(JOB_DAILY_REPORT_COLUMNS)
        .eq("job_id", jobId)
        .order("report_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(200),
    );
    if (data === null) return { state: "absent" };
    return { state: "ok", rows: jobDailyReportRows(data, jobId) };
  } catch (e) {
    reportError("jobs.[id].dailyReports", e, { jobId });
    return { state: "failed" };
  }
}
