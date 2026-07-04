import Link from "next/link";
import { Stamp } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { formatDate } from "@/lib/utils";
import { AddPermitButton } from "./add-permit-button";
import { EditPermitButton } from "./edit-permit-button";
import { permitStatusTone as statusTone, permitResultTone } from "@/lib/permit-options";

export const dynamic = "force-dynamic";

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
      <PageHeader title="Permits & inspections" description="Every permit and inspection across your jobs.">
        <AddPermitButton jobs={jobOpts} />
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState icon={Stamp} title="No permits yet" description="Add a permit here (the job is optional) or from a job's Permits tab.">
          <AddPermitButton jobs={jobOpts} />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <DataTable<any>
            rows={rows}
            rowKey={(p) => p.id}
            mobileCols={2}
            columns={[
              { header: "Type", span: 2, className: "text-sm font-medium text-slate-900", cell: (p) => p.type },
              { header: "Permit #", span: 2, className: "font-mono text-xs text-slate-500", cell: (p) => p.permit_number ?? "—" },
              {
                header: "Job",
                span: 3,
                className: "text-sm text-slate-600",
                cell: (p) => (
                  <>
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
                        Check with City ↗
                      </a>
                    )}
                  </>
                ),
              },
              { header: "Inspection", span: 2, className: "text-sm text-slate-600", cell: (p) => (p.inspection_date ? formatDate(p.inspection_date) : "—") },
              {
                header: "Status",
                span: 3,
                align: "right",
                className: "flex items-center justify-end gap-2",
                cell: (p) => (
                  <>
                    <Badge tone={permitResultTone(p.inspection_result)}>{p.inspection_result}</Badge>
                    <Badge tone={statusTone(p.status)}>{p.status.replace("_", " ")}</Badge>
                    <EditPermitButton permit={p} jobId={p.job_id} />
                  </>
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
