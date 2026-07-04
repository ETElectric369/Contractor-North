import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Briefcase, User, Calendar, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { WoStatusControl } from "./wo-status-control";
import { WoEditButton } from "./wo-edit-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { workOrderSectionTree } from "@/lib/nav-tree";
import { deleteWorkOrder } from "../actions";

export const dynamic = "force-dynamic";

export default async function WorkOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: wo, error: woErr } = await supabase
    .from("work_orders")
    .select(
      "*, jobs(id, job_number, name), customers(id, name), assignee:assigned_to(full_name)",
    )
    .eq("id", id)
    .maybeSingle();

  if (woErr) throw woErr; // a real failure shouldn't masquerade as 404
  if (!wo) notFound();
  const w = wo as any;

  const [{ data: jobs }, { data: techs }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .in("status", ["estimate", "scheduled", "in_progress", "on_hold"])
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/work-orders"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Work Orders
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{w.wo_number}</h1>
            <Badge tone={statusTone(w.status)}>
              {w.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="mt-1 text-lg text-slate-700">{w.title}</p>
        </div>
        {/* Impulse verbs stay visible (Print / advance status); the ⋯ Actions menu
            rides LAST as the seek door — Edit (modal-owning menu row), the source
            estimate, and Delete (danger, last). Job/Customer links live in the
            cards below, so they're not duplicated here. */}
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/print/work-order/${w.id}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-4 w-4 shrink-0" /> Print / PDF
          </Link>
          <WoStatusControl id={w.id} status={w.status} />
          <SectionActionsMenu
            tree={workOrderSectionTree(
              w.wo_number,
              { quoteId: (w as any).quote_id ?? null },
              {
                run: deleteWorkOrder.bind(null, w.id),
                confirm: `Delete work order ${w.wo_number}?`,
              },
            )}
          >
            <WoEditButton menuItem wo={w} jobs={jobs ?? []} techs={techs ?? []} />
          </SectionActionsMenu>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Briefcase className="h-4 w-4" /> Job
            </div>
            <div className="mt-1 text-sm font-medium text-slate-900">
              {w.jobs ? (
                <Link href={`/jobs/${w.jobs.id}`} className="hover:text-brand">
                  {w.jobs.name}
                </Link>
              ) : (
                "—"
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <User className="h-4 w-4" /> Assigned to
            </div>
            <div className="mt-1 text-sm font-medium text-slate-900">
              {w.assignee?.full_name ?? "Unassigned"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Calendar className="h-4 w-4" /> Scheduled
            </div>
            <div className="mt-1 text-sm font-medium text-slate-900">
              {w.scheduled_for ? formatDateTime(w.scheduled_for) : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      {w.description && (
        <Card className="mt-6">
          <CardContent className="py-5">
            <h3 className="mb-1 text-sm font-semibold text-slate-900">Scope</h3>
            <p className="whitespace-pre-wrap text-sm text-slate-600">
              {w.description}
            </p>
          </CardContent>
        </Card>
      )}

      {w.customers && (
        <Card className="mt-6">
          <CardContent className="py-4">
            <Link
              href={`/crm/${w.customers.id}`}
              className="flex items-center gap-2 text-sm text-slate-700 hover:text-brand"
            >
              <User className="h-4 w-4 text-slate-400" /> {w.customers.name}
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
