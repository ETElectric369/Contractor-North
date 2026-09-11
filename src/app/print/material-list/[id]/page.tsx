import { notFound } from "next/navigation";
import { pickSite, siteLines, SITE_COLS } from "@/lib/site-address";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatDate } from "@/lib/utils";
import { docTitle } from "@/lib/doc-title";
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
      .select(`name, created_at, jobs(job_number, name, ${SITE_COLS})`)
      .eq("id", id)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);
  if (!list) notFound();

  const [{ data: meRow }, { data: org }] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("organizations").select("*").maybeSingle(),
  ]);
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");

  // PROJECTION LAW: a column never selected cannot leak — the crew's sheet never asks for
  // vendor, so it can't ride the RSC payload to a phone either.
  const { data: items } = await supabase
    .from("material_list_items")
    .select(viewerIsStaff ? "description, part_number, quantity, unit, vendor" : "description, part_number, quantity, unit")
    .eq("list_id", id)
    .order("sort_order");

  const company = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "material_list");
  const l = list as any;
  const job = l.jobs;

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

        {job && (
          <div className="mt-6 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Job</div>
            <div className="mt-1 text-slate-700">
              {job.name}
              {/* A street with no city is not a deliverable address, and this sheet is handed
                  to a supply house. */}
              {/* Its OWN lines, not a comma join: these job rows are blobs ending in ", Tahoe City,
                  CA 96145, USA", so joining would print the dwelling AFTER the ZIP — the exact
                  thing the own-line rule exists to stop. This sheet goes to a supply house. */}
              {siteLines(pickSite([{ source: "job", parts: job }])).map((l) => (
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
              {viewerIsStaff && <th className="py-2">Vendor</th>}
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
