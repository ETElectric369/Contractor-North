import Link from "next/link";
import { Stamp } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { AddPermitButton } from "./add-permit-button";
import { EditPermitButton } from "./edit-permit-button";

export const dynamic = "force-dynamic";

function statusTone(s: string): "green" | "red" | "amber" | "slate" {
  if (["issued", "passed", "closed"].includes(s)) return "green";
  if (s === "failed") return "red";
  if (["applied", "scheduled"].includes(s)) return "amber";
  return "slate";
}

export default async function PermitsPage() {
  const supabase = await createClient();
  const { data: permits } = await supabase
    .from("permits")
    .select("id, permit_number, type, authority, status, applied_date, issued_date, expires_date, inspection_date, inspector, inspection_result, notes, job_id, portal_url, jobs(job_number, name)")
    .order("inspection_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  const rows = permits ?? [];

  const { data: jobsData } = await supabase
    .from("jobs")
    .select("id, job_number, name")
    .order("created_at", { ascending: false })
    .limit(200);
  const jobOpts = (jobsData ?? []).map((j: any) => ({ id: j.id, label: `${j.job_number} · ${j.name}` }));

  return (
    <div>
      <PageHeader title="Permits & Inspections" description="Every permit and inspection across your jobs.">
        <AddPermitButton jobs={jobOpts} />
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState icon={Stamp} title="No permits yet" description="Add a permit here (the job is optional) or from a job's Permits tab.">
          <AddPermitButton jobs={jobOpts} />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-2">Type</div>
            <div className="col-span-2">Permit #</div>
            <div className="col-span-3">Job</div>
            <div className="col-span-2">Inspection</div>
            <div className="col-span-3 text-right">Status</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map((p: any) => (
              <li key={p.id} className="grid grid-cols-2 gap-2 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-3">
                <div className="col-span-2 text-sm font-medium text-slate-900">{p.type}</div>
                <div className="col-span-2 font-mono text-xs text-slate-500">{p.permit_number ?? "—"}</div>
                <div className="col-span-3 text-sm text-slate-600">
                  {p.job_id ? (
                    <Link href={`/jobs/${p.job_id}`} className="hover:text-brand">{p.jobs?.name ?? "Job"}</Link>
                  ) : (
                    "—"
                  )}
                  {p.authority ? <span className="block text-xs text-slate-400">{p.authority}</span> : null}
                  {p.portal_url && (
                    <a
                      href={p.portal_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                    >
                      Check with city ↗
                    </a>
                  )}
                </div>
                <div className="col-span-2 text-sm text-slate-600">{p.inspection_date ? formatDate(p.inspection_date) : "—"}</div>
                <div className="col-span-3 flex items-center justify-end gap-2">
                  <Badge tone={p.inspection_result === "passed" ? "green" : p.inspection_result === "failed" ? "red" : "slate"}>{p.inspection_result}</Badge>
                  <Badge tone={statusTone(p.status)}>{p.status.replace("_", " ")}</Badge>
                  <EditPermitButton permit={p} jobId={p.job_id} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
