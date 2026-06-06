import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { NewWorkOrderButton } from "./new-wo-button";

export const dynamic = "force-dynamic";

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job } = await searchParams;
  const supabase = await createClient();

  const [{ data: wos }, { data: jobs }, { data: techs }] = await Promise.all([
    supabase
      .from("work_orders")
      .select("*, jobs(job_number, name), customers(name)")
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("profiles").select("id, full_name").eq("active", true),
  ]);

  const workOrders = wos ?? [];

  return (
    <div>
      <PageHeader
        title="Work Orders"
        description="Field work orders, scopes, and assignments."
      >
        <NewWorkOrderButton
          jobs={jobs ?? []}
          techs={techs ?? []}
          defaultJob={job}
        />
      </PageHeader>

      {workOrders.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No work orders yet"
          description="Create a work order to dispatch field work."
        >
          <NewWorkOrderButton jobs={jobs ?? []} techs={techs ?? []} defaultJob={job} />
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-2">WO #</div>
            <div className="col-span-4">Title</div>
            <div className="col-span-3">Job / Customer</div>
            <div className="col-span-2">Scheduled</div>
            <div className="col-span-1 text-right">Status</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {workOrders.map((w: any) => (
              <li key={w.id}>
                <Link
                  href={`/work-orders/${w.id}`}
                  className="grid grid-cols-2 gap-2 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-4"
                >
                  <div className="col-span-2 font-medium text-slate-900">
                    {w.wo_number}
                  </div>
                  <div className="col-span-4 text-sm text-slate-700">{w.title}</div>
                  <div className="col-span-3 text-sm text-slate-500">
                    {w.jobs?.name ?? w.customers?.name ?? "—"}
                  </div>
                  <div className="col-span-2 text-sm text-slate-500">
                    {w.scheduled_for ? formatDateTime(w.scheduled_for) : "—"}
                  </div>
                  <div className="col-span-1 md:text-right">
                    <Badge tone={statusTone(w.status)}>
                      {w.status.replace("_", " ")}
                    </Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
