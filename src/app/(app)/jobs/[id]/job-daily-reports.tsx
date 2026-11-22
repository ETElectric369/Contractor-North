import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDuration } from "@/lib/utils";
import { fillText, translator } from "@/lib/i18n";
import type { JobDailyReportsRead } from "./daily-reports";

/** The anchor the bell's link and My Day land on: /jobs/<id>?tab=time#daily-reports. */
export const DAILY_REPORTS_ANCHOR = "daily-reports";

/**
 * THE JOB'S DAILY REPORTS, on its Time tab under the shifts (cn-v1174; daily-reports.ts reads them).
 * Drawn only when the Daily Reports switch is on (the page reads nothing otherwise) AND at least one
 * report names this job: no heading over nothing. A failed read is said in the section's place, never
 * drawn as "none". Each row: the day, who wrote it, this job's hours from the report's own frozen
 * summary, What got done and Materials for tomorrow (each only when it has words), and Reviewed or
 * Waiting for review. No price anywhere: a tech reads his own reports here.
 */
export function JobDailyReports({ read, lang }: { read: JobDailyReportsRead | null; lang: string | null }) {
  const t = translator(lang);
  if (!read || read.state === "absent") return null;
  if (read.state === "failed") {
    return (
      <Card id={DAILY_REPORTS_ANCHOR} className="scroll-mt-24 px-5 py-3 text-sm text-red-700">
        {t("jb_drReadFailed")}
      </Card>
    );
  }
  if (read.rows.length === 0) return null;
  return (
    <Card id={DAILY_REPORTS_ANCHOR} className="scroll-mt-24 overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">{t("jb_dailyReports")}</div>
      <ul className="divide-y divide-slate-100">
        {read.rows.map((r) => (
          <li key={r.id} className="space-y-1 px-5 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="text-slate-700">{r.day ? formatDate(r.day, undefined, lang) : "—"}</span>
                <span className="ml-2 text-slate-500">{r.who ?? t("jb_drSomeone")}</span>
                {r.hours !== null && (
                  <span className="ml-2 text-slate-500">· {fillText(t("jb_drHoursHere"), { hours: formatDuration(r.hours) })}</span>
                )}
              </span>
              <Badge tone={r.reviewed ? "green" : "slate"}>{r.reviewed ? t("jb_drReviewed") : t("jb_drWaiting")}</Badge>
            </div>
            {r.didToday && (
              <p className="whitespace-pre-line text-slate-700">
                <span className="font-medium text-slate-900">{t("jb_drWhatGotDone")}</span> {r.didToday}
              </p>
            )}
            {r.materialsTomorrow && (
              <p className="whitespace-pre-line text-slate-700">
                <span className="font-medium text-slate-900">{t("jb_drMaterialsTomorrow")}</span> {r.materialsTomorrow}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
