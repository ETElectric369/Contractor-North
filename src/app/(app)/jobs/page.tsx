import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { Briefcase, X } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { ACTIVE_JOB_STATUSES, JOB_STATUS_PRIORITY, jobStatusLabel } from "@/lib/job-status";
import { listNewJobCustomerOptions, toNewJobCustomerOptions } from "@/lib/schedule-options";
import { jobBillingStatus, type JobBillingInvoice, type JobBillingStatus } from "@/lib/analytics/money-metrics";
import { NewJobButton } from "../schedule/new-job-button";
import { JobImportButton } from "./job-import-button";
import { JobRow, type JobRowData } from "./job-row";
import { CompletedJobsSection } from "./completed-section";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Newest-first cap on the collapsed Completed shelf — the section stays honest
 *  ("showing latest N of M") instead of rendering an unbounded history. */
const COMPLETED_CAP = 100;

type JobWithCustomer = Job & { customers: { name: string } | null };

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("jobs")
    .select("*, customers(name)")
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Billing tags show wherever COMPLETED rows show: the default view's Completed
  // shelf + the ?status=complete view. ONE org-wide batched fetch of the job-linked
  // invoices (the same 4 fields the AR/billing SSOT math reads — RLS scopes the
  // org), fired in parallel with the jobs query: no N+1, no jobs→invoices waterfall.
  const needBillingTags = !status || status === "complete";
  const [{ data: jobsData }, { data: customerRows }, { data: me }, invoiceRes] = await Promise.all([
    query,
    listNewJobCustomerOptions(supabase),
    user ? supabase.from("profiles").select("role").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    needBillingTags
      ? supabase.from("invoices").select("job_id, status, total, amount_paid").not("job_id", "is", null)
      : Promise.resolve({ data: null }),
  ]);
  const isStaff = isStaffRole((me as { role?: string } | null)?.role ?? "");
  // id/name + the one-line address so picking a customer prefills the site address.
  const customers = toNewJobCustomerOptions(customerRows);
  const allJobs = (jobsData ?? []) as JobWithCustomer[];

  // Group the invoices per job, then derive each completed job's tag through
  // jobBillingStatus — THE shared definition in analytics/money-metrics (built on
  // invoiceBalance, the same math /billing/ar ages), never an inline recompute.
  const invoicesByJob = new Map<string, JobBillingInvoice[]>();
  for (const i of ((invoiceRes?.data ?? []) as ({ job_id: string } & JobBillingInvoice)[])) {
    const list = invoicesByJob.get(i.job_id) ?? [];
    list.push(i);
    invoicesByJob.set(i.job_id, list);
  }
  const billingOf = (jobId: string): JobBillingStatus => jobBillingStatus(invoicesByJob.get(jobId) ?? []);
  const toRow = (j: JobWithCustomer, billing?: JobBillingStatus): JobRowData => ({
    id: j.id,
    name: j.name,
    job_number: j.job_number,
    status: j.status,
    address: j.address,
    scheduled_start: j.scheduled_start,
    customer: j.customers?.name ?? null,
    billing,
  });

  // Default (unfiltered) view: ACTIVE jobs in the main list — priority sort
  // (in_progress up top), newest-first inside a status (stable sort). COMPLETED
  // jobs don't hide behind a link anymore (owner spec 2026-07-20): they sit in a
  // collapsed shelf at the bottom, each wearing its billing tag. Cancelled stays
  // a quiet footer count.
  let jobs = allJobs;
  let completedJobs: JobWithCustomer[] = [];
  let completedCount = 0;
  let cancelledCount = 0;
  if (!status) {
    const active = new Set<string>(ACTIVE_JOB_STATUSES);
    const completed = allJobs.filter((j) => j.status === "complete"); // already newest-first
    completedCount = completed.length;
    completedJobs = completed.slice(0, COMPLETED_CAP);
    cancelledCount = allJobs.filter((j) => j.status === "cancelled").length;
    jobs = allJobs.filter((j) => active.has(j.status));
    jobs.sort((a, b) => (JOB_STATUS_PRIORITY[a.status] ?? 9) - (JOB_STATUS_PRIORITY[b.status] ?? 9));
  }

  return (
    <div>
      <PageHeader title="Jobs" description="All jobs across the business.">
        <div className="flex items-center gap-2">
          {isStaff && <JobImportButton />}
          <NewJobButton customers={customers} />
        </div>
      </PageHeader>

      {/* Status nav lives in ONE place per breakpoint now — the desktop rail / the mobile
          SectionSubnav strip, both generated from JOB_STATUSES via the dock. The page keeps
          reading ?status= and shows just a dismissible chip so the filter is visible + clearable. */}
      {status && (
        <div className="mb-4">
          <Link
            href="/jobs"
            title="Clear filter"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-sm"
          >
            Filtered: {jobStatusLabel(status)}
            <X className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title={!status && allJobs.length > 0 ? "No active jobs" : "No jobs"}
          description="Create a job to get started."
        >
          <NewJobButton customers={customers} />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {jobs.map((j) => (
              // ?status=complete rows wear the same billing tags as the shelf (shared row).
              <JobRow key={j.id} job={toRow(j, status === "complete" ? billingOf(j.id) : undefined)} />
            ))}
          </ul>
        </Card>
      )}

      {/* The collapsed Completed shelf — count + chevron, billing tag per row. */}
      {!status && (
        <CompletedJobsSection
          jobs={completedJobs.map((j) => toRow(j, billingOf(j.id)))}
          total={completedCount}
        />
      )}

      {/* Cancelled jobs stay out of the way — a quiet count line keeps them one
          tap away (the status pills/rail still show everything when chosen). */}
      {!status && cancelledCount > 0 && (
        <p className="mt-3 text-center text-xs text-slate-400">
          <Link href="/jobs?status=cancelled" className="hover:text-brand hover:underline">
            {cancelledCount} cancelled
          </Link>
        </p>
      )}
    </div>
  );
}
