import type { ActionItem } from "./types";
import { AFFORDANCES } from "./types";
import { waitKey } from "./needs-you-waits";
import { jobWords, firstNameOf } from "./words";
import type { ReportBackStanding } from "@/lib/report-back";

/**
 * THE NEEDS YOU ROW FOR A T&M JOB THAT OWES ITS CUSTOMER A WORD (cn-v1069, lib/report-back). One per
 * job, id reportback-<job>: "Tell Dana Where It Stands" · "The kitchen place · J-047 · 6h in · guess
 * was 8h". Opens the job's Report Back card (the Text and Told Them doors live there). An endless
 * row while it stands, so it takes the Snooze that picks a day (needs_you_waits) once 0367 is on the
 * database; Told Them is what ends it.
 */
export function reportBackActionItem(
  job: { id: string; job_number?: string | null; name?: string | null; customer?: { name?: string | null } | null },
  standing: ReportBackStanding,
  waitsReady: boolean,
): Omit<ActionItem, "stream"> {
  const first = firstNameOf(job.customer?.name);
  return {
    id: `reportback-${job.id}`,
    kind: "job_report_back",
    title: first ? `Tell ${first} Where It Stands` : "Tell The Customer Where It Stands",
    subtitle: `${jobWords(job)} · ${standing.sentence}`,
    who: null,
    when: standing.lastWorked,
    urgency: 0,
    done: false,
    href: `/jobs/${job.id}#report-back`,
    affordances: waitsReady ? ["snooze", "open"] : AFFORDANCES.job_report_back,
    ...(waitsReady ? { waitKey: waitKey("job_report_back", job.id) } : {}),
  };
}
