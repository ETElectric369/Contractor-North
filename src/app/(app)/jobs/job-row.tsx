import Link from "next/link";
import { MapPin } from "lucide-react";
import { Badge, statusTone, type Tone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { formatDate } from "@/lib/utils";
import { JOB_BILLING_STATUS_LABEL, type JobBillingStatus } from "@/lib/analytics/money-metrics";

/** Badge tone per billing tag — amber "go bill it", blue "waiting on money",
 *  purple "part paid", green "settled". Pulls from the ONE Badge tone palette. */
const BILLING_TONE: Record<JobBillingStatus, Tone> = {
  to_be_invoiced: "amber",
  pending: "blue",
  partial: "purple",
  paid_in_full: "green",
};

/** Serializable row shape — page.tsx (server) builds these; the client
 *  CompletedJobsSection receives them across the RSC boundary. */
export type JobRowData = {
  id: string;
  name: string | null;
  job_number: string | null;
  status: string;
  address: string | null;
  scheduled_start: string | null;
  customer: string | null;
  /** Billing tag for a COMPLETED job — derived by jobBillingStatus (the AR-shared
   *  SSOT in analytics/money-metrics). Absent = no tag (active rows / no data). */
  billing?: JobBillingStatus | null;
};

/**
 * THE /jobs list row, shared by the active list, the collapsed Completed section,
 * and the ?status= filtered views so they can never drift. The job info links to
 * the job; the billing tag (when present) links to the job's Invoices tab — the
 * same money deep-link the /billing board uses (`?tab=invoices`).
 * `hideStatus` drops the redundant green "complete" badge inside the Completed
 * section, where the section header already says it.
 */
export function JobRow({ job, hideStatus = false }: { job: JobRowData; hideStatus?: boolean }) {
  return (
    <li className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50">
      <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1">
        <div className="font-medium text-slate-900">{job.name}</div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>{job.job_number}</span>
          {job.customer && <span>· {job.customer}</span>}
          {job.address && (
            <span className="flex items-center gap-0.5">
              <MapPin className="h-3 w-3" /> {job.address}
            </span>
          )}
          {job.scheduled_start && <span>· {formatDate(job.scheduled_start)}</span>}
        </div>
      </Link>
      {!hideStatus && <Badge tone={statusTone(job.status)}>{jobStatusLabel(job.status)}</Badge>}
      {job.billing && (
        <Link
          href={`/jobs/${job.id}?tab=invoices`}
          title="Open this job's invoices"
          className="shrink-0 rounded-full transition-transform hover:scale-105"
        >
          <Badge tone={BILLING_TONE[job.billing]}>{JOB_BILLING_STATUS_LABEL[job.billing]}</Badge>
        </Link>
      )}
    </li>
  );
}
