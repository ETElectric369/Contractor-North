import { COMPANY_FIELD } from "@/lib/vendor-words";
import { notFound } from "next/navigation";
import { pickSite, siteLines, SITE_COLS, type SiteParts } from "@/lib/site-address";
import { bornFromEstimateCandidates } from "@/lib/quote-site";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatDate } from "@/lib/utils";
import { docTitle } from "@/lib/doc-title";
import { reportError } from "@/lib/observe";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("material_lists").select("name").eq("id", id).maybeSingle();
  return { title: docTitle("Materials", (data as any)?.name) };
}

/** A materials pick list with NO prices — for the field crew to pull/buy, or to
 *  send a supplier for a quote, without exposing cost or markup. The vendor column is
 *  the office's as well (one of the three money fields the crew never sees — see
 *  MONEY_FIELDS in materials/actions.ts: where it's bought is half of what it cost),
 *  so it is selected and printed for staff only. A tech's sheet is the same list minus
 *  that column, never a locked door: a pick list is a field convenience. */
export default async function MaterialListPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Viewer role rides alongside the list read — the same shape as /materials/[id]. RLS is
  // the boundary on the rows; the role only decides whether vendor is asked for at all.
  const [{ data: list }, { data: { user } }] = await Promise.all([
    supabase
      .from("material_lists")
      // quote_id (0049): the estimate the list was taken off, asked below for where the work is.
      .select(`name, created_at, quote_id, jobs(job_number, name, ${SITE_COLS})`)
      .eq("id", id)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);
  if (!list) notFound();
  const l = list as any;
  const job = l.jobs as (SiteParts & { name?: string | null }) | null;

  /**
   * WHERE THE WORK IS (cn-v1160). A list owns no address: it prints its own job's site. One taken off
   * an estimate that has no job yet printed no place at all, on a sheet that is handed to a supply
   * house, while the estimate it came from printed the building the work is in. It now prints the
   * place the estimate prints, by the one order every paper born from an estimate follows
   * (lib/quote-site bornFromEstimateCandidates): the job's site, then the estimate's own, then that
   * estimate's lead's, then its customer's.
   *
   * THE ESTIMATE IS ASKED ONLY WHEN THE JOB GAVE NO ADDRESS, in a read of its own by the list's
   * quote_id, so a list on a job that has an address prints what it always printed. ADDRESS COLUMNS
   * ONLY: this sheet is the crew's too, and no price is asked for (the projection law). An estimate
   * and a lead are the office's to read (0056), so the crew's own read of them comes back empty and
   * their sheet is as it was. A read that fails is filed and prints no place: a blank a person can
   * see, never another record's address.
   */
  const fromJob = pickSite(bornFromEstimateCandidates({ job }));
  const [{ data: meRow }, { data: org }, estimateRead] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("organizations").select("*").maybeSingle(),
    !fromJob && l.quote_id
      ? supabase.from("quotes").select(`${SITE_COLS}, inquiries(${SITE_COLS}), customers(${SITE_COLS})`).eq("id", l.quote_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");
  if (estimateRead.error) reportError("print.materialList.estimateSite", estimateRead.error, { listId: id, quoteId: l.quote_id });
  const estimate = (estimateRead.error ? null : estimateRead.data) as (SiteParts & { inquiries?: SiteParts | null; customers?: SiteParts | null }) | null;
  const site = fromJob ?? pickSite(bornFromEstimateCandidates({ job, quote: estimate, lead: estimate?.inquiries, customer: estimate?.customers }));

  // PROJECTION LAW: a column never selected cannot leak — the crew's sheet never asks for
  // vendor, so it can't ride the RSC payload to a phone either.
  const { data: items } = await supabase
    .from("material_list_items")
    .select(viewerIsStaff ? "description, part_number, quantity, unit, vendor" : "description, part_number, quantity, unit")
    .eq("list_id", id)
    .order("sort_order");

  const company = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "material_list");

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <BackLink fallback={`/materials/${id}`} fallbackLabel="Back" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800" />
        <PrintButton label="Print Pick List" />
      </div>

      <div className="print-page mx-auto bg-white shadow-sm">
        <DocHeader
          co={company}
          template={template}
          meta={{
            docType: "Materials List",
            number: l.name,
            rows: [{ label: "Date", value: formatDate(l.created_at) }],
          }}
        />

        {/* A list with no job but a place (the estimate's, above) says "Job site": there is no job to
            name, and the address is what the supply house needs. */}
        {(job || site) && (
          <div className="mt-6 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{job ? "Job" : "Job site"}</div>
            <div className="mt-1 text-slate-700">
              {job?.name}
              {/* A street with no city is not a deliverable address, and this sheet is handed
                  to a supply house. */}
              {/* Its OWN lines, not a comma join: these job rows are blobs ending in ", Tahoe City,
                  CA 96145, USA", so joining would print the dwelling AFTER the ZIP — the exact
                  thing the own-line rule exists to stop. This sheet goes to a supply house. */}
              {siteLines(site).map((l) => (
                <div key={l} className="text-slate-500">{l}</div>
              ))}
            </div>
          </div>
        )}

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="w-8 py-2"></th>
              <th className="py-2">Item</th>
              <th className="py-2">Part #</th>
              <th className="w-16 py-2 pr-3 text-right">Qty</th>
              <th className="w-16 py-2">Unit</th>
              {viewerIsStaff && <th className="py-2">{COMPANY_FIELD.material_line.label}</th>}
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((it: any, i: number) => (
              <tr key={i} className="border-b border-slate-100 align-top">
                <td className="py-2.5">
                  <span className="inline-block h-4 w-4 rounded border border-slate-400" />
                </td>
                <td className="py-2.5 pr-3 font-medium text-slate-800">{it.description}</td>
                <td className="py-2.5 pr-3 text-slate-500">{it.part_number || "—"}</td>
                <td className="py-2.5 pr-3 text-right text-slate-800">{Number(it.quantity ?? 0)}</td>
                <td className="py-2.5 text-slate-500">{it.unit || "ea"}</td>
                {viewerIsStaff && <td className="py-2.5 text-slate-500">{it.vendor || "—"}</td>}
              </tr>
            ))}
            {!(items ?? []).length && (
              <tr>
                <td colSpan={viewerIsStaff ? 6 : 5} className="py-6 text-center text-slate-400">No items on this list.</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="mt-4 text-xs text-slate-400">
          {(items ?? []).length} {(items ?? []).length === 1 ? "item" : "items"} · prices intentionally omitted
        </div>
      </div>
    </div>
  );
}
