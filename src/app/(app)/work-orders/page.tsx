import { ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { DataTable } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";
import { listActiveTechs } from "@/lib/schedule-options";
import { NewWorkOrderButton } from "./new-wo-button";
import { viewerSwitches } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";

export const dynamic = "force-dynamic";

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job } = await searchParams;
  const supabase = await createClient();

  const [{ data: wos }, { data: jobs }, { data: techs }, sw] = await Promise.all([
    supabase
      .from("work_orders")
      .select("*, jobs(job_number, name), customers(name)")
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
    listActiveTechs(supabase),
    // The switch board (0352): work orders are part of Estimates.
    viewerSwitches(),
  ]);
  const estimatesOn = featureOn(sw.features, "estimates");

  const workOrders = wos ?? [];

  return (
    <div>
      <PageHeader
        title="Work orders"
        description="Field work orders, scopes, and assignments."
      >
        {estimatesOn && (
          <NewWorkOrderButton
            jobs={jobs ?? []}
            techs={techs ?? []}
            defaultJob={job}
          />
        )}
      </PageHeader>

      {workOrders.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No work orders yet"
          description={estimatesOn ? "Create a work order with the button above to dispatch field work." : "Work orders are part of Estimates, which is off."}
        />
      ) : (
        <Card className="overflow-hidden">
          <DataTable<any>
            rows={workOrders}
            rowKey={(w) => w.id}
            rowHref={(w) => `/work-orders/${w.id}`}
            mobileCols={2}
            columns={[
              { header: "WO #", span: 2, className: "font-medium text-slate-900", cell: (w) => w.wo_number },
              { header: "Title", span: 4, className: "text-sm text-slate-700", cell: (w) => w.title },
              { header: "Job / Customer", span: 3, className: "text-sm text-slate-500", cell: (w) => w.jobs?.name ?? w.customers?.name ?? "—" },
              { header: "Scheduled", span: 2, className: "text-sm text-slate-500", cell: (w) => (w.scheduled_for ? formatDateTime(w.scheduled_for) : "—") },
              { header: "Status", span: 1, align: "right", cell: (w) => <Badge tone={statusTone(w.status)}>{jobStatusLabel(w.status)}</Badge> },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
