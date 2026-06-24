import Link from "next/link";
import { Briefcase, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
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
  const [{ data: jobsData }, { data: customers }, { data: me }] = await Promise.all([
    query,
    supabase.from("customers").select("id, name").order("name"),
    user ? supabase.from("profiles").select("role").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const isStaff = ["owner", "admin", "office"].includes((me as { role?: string } | null)?.role ?? "");
  const jobs = (jobsData ?? []) as (Job & { customers: { name: string } | null })[];

  // Default (unfiltered) view: active jobs up top, completed/invoiced sink to the
  // bottom. Within a group the query's newest-first order is preserved (stable sort).
  if (!status) {
    const PRIORITY: Record<string, number> = {
      in_progress: 0, scheduled: 1, on_hold: 2, estimate: 3, invoiced: 4, complete: 5,
    };
    jobs.sort((a, b) => (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9));
  }

  const STATUSES = ["estimate", "scheduled", "in_progress", "on_hold", "complete", "invoiced"];

  return (
    <div>
      <PageHeader title="Jobs" description="All jobs across the business.">
        <div className="flex items-center gap-2">
          {isStaff && <JobImportButton />}
          <NewJobButton customers={customers ?? []} />
        </div>
      </PageHeader>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <Link
          href="/jobs"
          className={`rounded-lg px-3 py-1.5 text-xs font-medium ${!status ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
        >
          All
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/jobs?status=${s}`}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize ${status === s ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {s.replace("_", " ")}
          </Link>
        ))}
      </div>

      {jobs.length === 0 ? (
        <EmptyState icon={Briefcase} title="No jobs" description="Create a job to get started.">
          <NewJobButton customers={customers ?? []} />
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
                  <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
