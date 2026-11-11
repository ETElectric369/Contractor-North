import { notFound } from "next/navigation";
import { pickSite, siteLines, SITE_COLS, type ResolvedSite, type SiteParts } from "@/lib/site-address";
import { bornFromEstimateCandidates } from "@/lib/quote-site";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatDateTime, formatDate, formatCityStateZip } from "@/lib/utils";
import { docTitle } from "@/lib/doc-title";
import { reportError } from "@/lib/observe";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * WHERE THE WORK IS (cn-v1160). A work order owns no address: it prints its own job's site. One
 * made from an estimate that has no job yet printed none at all, while the estimate it came from
 * printed the building the work is in. It now prints the place the estimate prints, by the one
 * order every paper born from an estimate follows (lib/quote-site bornFromEstimateCandidates): the
 * job's site, then the estimate's own, then that estimate's lead's, then its customer's.
 *
 * THE ESTIMATE IS ASKED ONLY WHEN THE JOB GAVE NO ADDRESS, in a read of its own by the work order's
 * quote_id (0049), so a work order on a job that has an address makes the reads it always made and
 * prints what it always printed. Address columns only: never a price. A work order made from no
 * estimate has nobody to ask and prints its job's site or none, as before. A read that fails is
 * filed and prints no site: a blank a person can see, never another record's address.
 */
async function siteOf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  w: { id?: string | null; quote_id?: string | null; jobs?: SiteParts | null },
): Promise<ResolvedSite | null> {
  const fromJob = pickSite(bornFromEstimateCandidates({ job: w.jobs }));
  if (fromJob || !w.quote_id) return fromJob;
  const { data, error } = await supabase
    .from("quotes")
    .select(`${SITE_COLS}, inquiries(${SITE_COLS}), customers(${SITE_COLS})`)
    .eq("id", w.quote_id)
    .maybeSingle();
  if (error) {
    reportError("print.workOrder.estimateSite", error, { workOrderId: w.id ?? null, quoteId: w.quote_id });
    return null;
  }
  const estimate = data as (SiteParts & { inquiries?: SiteParts | null; customers?: SiteParts | null }) | null;
  return pickSite(bornFromEstimateCandidates({ job: w.jobs, quote: estimate, lead: estimate?.inquiries, customer: estimate?.customers }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("work_orders").select("wo_number, jobs(name)").eq("id", id).maybeSingle();
  return { title: docTitle(data ? `Work Order ${(data as any).wo_number}` : "Work Order", (data as any)?.jobs?.name) };
}

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
      `*, jobs(job_number, name, ${SITE_COLS}), customers(name, company_name, address, city, state, zip, phone), assignee:assigned_to(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!wo) notFound();
  const { data: org } = await supabase.from("organizations").select("*").maybeSingle();
  const company = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "work_order");
  const w = wo as any;
  const customer = w.customers;
  const siteRows = siteLines(await siteOf(supabase, w));

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <BackLink fallback={`/work-orders/${id}`} fallbackLabel="Back" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800" />
        <PrintButton />
      </div>

      <div className="print-page mx-auto bg-white shadow-sm">
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
                  <div>{formatCityStateZip(customer.city, customer.state, customer.zip)}</div>
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
              {/* The dash stands for "no job and no place". With no job but a place (the estimate's,
                  siteOf above) the address is the answer, and a dash over it would say there is none. */}
              {w.jobs?.name ?? (siteRows.length ? null : "—")}
              {/* The whole address, not the street. The customer block beside this one has
                  printed a full address all along; this said "Job site" and gave a street. */}
              {siteRows.map((l) => (
                <div key={l} className="text-slate-500">{l}</div>
              ))}
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
