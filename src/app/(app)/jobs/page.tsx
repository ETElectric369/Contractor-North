import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { Briefcase, MapPin, X } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { ACTIVE_JOB_STATUSES, JOB_STATUS_PRIORITY, jobStatusLabel } from "@/lib/job-status";
import { listNewJobCustomerOptions, toNewJobCustomerOptions } from "@/lib/schedule-options";
import { formatDate } from "@/lib/utils";
import { NewJobButton } from "../schedule/new-job-button";
import { JobImportButton } from "./job-import-button";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";

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
  const [{ data: jobsData }, { data: customerRows }, { data: me }] = await Promise.all([
    query,
    listNewJobCustomerOptions(supabase),
    user ? supabase.from("profiles").select("role").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const isStaff = isStaffRole((me as { role?: string } | null)?.role ?? "");
  // id/name + the one-line address so picking a customer prefills the site address.
  const customers = toNewJobCustomerOptions(customerRows);
  const allJobs = (jobsData ?? []) as (Job & { customers: { name: string } | null })[];

  // Default (unfiltered) view: ACTIVE jobs only — finished/cancelled hide behind a
  // quiet footer count that links to their ?status= filters (the pills still show
  // everything when chosen). Within the active set: priority sort (in_progress up
  // top), newest-first inside a status (stable sort).
  let jobs = allJobs;
  let completedCount = 0;
  let cancelledCount = 0;
  if (!status) {
    const active = new Set<string>(ACTIVE_JOB_STATUSES);
    completedCount = allJobs.filter((j) => j.status === "complete").length;
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
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50">
                  <div className="flex-1">
                    <div className="font-medium text-slate-900">{j.name}</div>
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span>{j.job_number}</span>
                      {j.customers?.name && <span>· {j.customers.name}</span>}
                      {j.address && (
                        <span className="flex items-center gap-0.5">
                          <MapPin className="h-3 w-3" /> {j.address}
                        </span>
                      )}
                      {j.scheduled_start && <span>· {formatDate(j.scheduled_start)}</span>}
                    </div>
                  </div>
                  <Badge tone={statusTone(j.status)}>{jobStatusLabel(j.status)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Finished jobs don't clutter the working list — a quiet count line keeps
          them one tap away (the status pills/rail still show everything when chosen). */}
      {!status && (completedCount > 0 || cancelledCount > 0) && (
        <p className="mt-3 text-center text-xs text-slate-400">
          {completedCount > 0 && (
            <Link href="/jobs?status=complete" className="hover:text-brand hover:underline">
              {completedCount} completed
            </Link>
          )}
          {completedCount > 0 && cancelledCount > 0 && " · "}
          {cancelledCount > 0 && (
            <Link href="/jobs?status=cancelled" className="hover:text-brand hover:underline">
              {cancelledCount} cancelled
            </Link>
          )}
          {" — "}
          <Link
            href={completedCount > 0 ? "/jobs?status=complete" : "/jobs?status=cancelled"}
            className="font-medium text-brand hover:underline"
          >
            view
          </Link>
        </p>
      )}
    </div>
  );
}
