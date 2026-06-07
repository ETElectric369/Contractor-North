import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatDateTime, formatDate } from "@/lib/utils";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function WorkOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: wo } = await supabase
    .from("work_orders")
    .select(
      "*, jobs(job_number, name, address), customers(name, company_name, address, city, state, zip, phone), assignee:assigned_to(full_name)",
    )
    .eq("id", id)
    .maybeSingle();

  if (!wo) notFound();
  const { data: org } = await supabase.from("organizations").select("*").maybeSingle();
  const company = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "work_order");
  const w = wo as any;
  const customer = w.customers;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <Link href={`/work-orders/${id}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PrintButton />
      </div>

      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        <DocHeader
          co={company}
          template={template}
          meta={{
            docType: "Work Order",
            number: w.wo_number,
            rows: [
              { label: "Date", value: formatDate(w.created_at) },
              ...(w.scheduled_for
                ? [{ label: "Scheduled", value: formatDateTime(w.scheduled_for) }]
                : []),
            ],
          }}
        />

        <div className="mt-6 grid grid-cols-2 gap-6 text-sm">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Customer</div>
            {customer ? (
              <div className="mt-1 text-slate-700">
                <div className="font-medium text-slate-900">{customer.name}</div>
                {customer.address && <div>{customer.address}</div>}
                {(customer.city || customer.state || customer.zip) && (
                  <div>{[customer.city, customer.state, customer.zip].filter(Boolean).join(", ")}</div>
                )}
                {customer.phone && <div>{customer.phone}</div>}
              </div>
            ) : (
              <div className="mt-1 text-slate-400">—</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Job site</div>
            <div className="mt-1 text-slate-700">
              {w.jobs?.name ?? "—"}
              {w.jobs?.address ? <div className="text-slate-500">{w.jobs.address}</div> : null}
            </div>
            <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Assigned to</div>
            <div className="mt-1 text-slate-700">{w.assignee?.full_name ?? "Unassigned"}</div>
          </div>
        </div>

        <div className="mt-6 text-lg font-semibold text-slate-900">{w.title}</div>

        <div className="mt-2 border-t border-slate-200 pt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Scope of work
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
            {w.description || "—"}
          </p>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-8 text-sm">
          <div>
            <div className="h-10 border-b border-slate-400" />
            <div className="mt-1 text-xs text-slate-500">Technician / date</div>
          </div>
          <div>
            <div className="h-10 border-b border-slate-400" />
            <div className="mt-1 text-xs text-slate-500">Customer sign-off / date</div>
          </div>
        </div>
      </div>
    </div>
  );
}
