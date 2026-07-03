import Link from "next/link";
import { GitPullRequestArrow, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { NewChangeOrderButton } from "./new-co-button";
import { CoStatusControl } from "./co-status-control";
import { CoRowActions } from "./co-row-actions";

export const dynamic = "force-dynamic";

export default async function ChangeOrdersPage() {
  const supabase = await createClient();

  const [{ data: cos }, { data: jobs }] = await Promise.all([
    supabase
      .from("change_orders")
      .select("*, jobs(job_number, name)")
      .order("created_at", { ascending: false }),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const changeOrders = cos ?? [];
  const approvedTotal = changeOrders
    .filter((c: any) => c.status === "approved")
    .reduce((s: number, c: any) => s + Number(c.amount ?? 0), 0);
  const pendingCount = changeOrders.filter(
    (c: any) => c.status === "pending",
  ).length;

  return (
    <div>
      <PageHeader
        title="Change orders"
        description="Track and approve scope changes."
      >
        <NewChangeOrderButton jobs={jobs ?? []} />
      </PageHeader>

      {changeOrders.length === 0 ? (
        <EmptyState
          icon={GitPullRequestArrow}
          title="No change orders yet"
          description="Log a change order when a job's scope grows."
        >
          <NewChangeOrderButton jobs={jobs ?? []} />
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:max-w-md">
            <Card>
              <CardContent className="py-4">
                <div className="text-2xl font-bold text-slate-900">
                  {formatCurrency(approvedTotal)}
                </div>
                <div className="text-xs text-slate-500">Approved changes</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-2xl font-bold text-slate-900">
                  {pendingCount}
                </div>
                <div className="text-xs text-slate-500">Pending approval</div>
              </CardContent>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {changeOrders.map((c: any) => (
                <li key={c.id} className="flex items-start gap-4 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">
                        {c.co_number}
                      </span>
                      {c.jobs?.name && (
                        <span className="text-xs text-slate-400">
                          {c.jobs.job_number} · {c.jobs.name}
                        </span>
                      )}
                      <span className="text-xs text-slate-400">
                        {formatDate(c.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{c.description}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {formatCurrency(c.amount)}
                    </span>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/print/change-order/${c.id}`}
                        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        title="Print / PDF"
                      >
                        <Printer className="h-4 w-4" />
                      </Link>
                      <CoRowActions co={c} jobs={jobs ?? []} />
                      <CoStatusControl id={c.id} status={c.status} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
