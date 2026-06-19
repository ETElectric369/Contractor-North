import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatDate } from "@/lib/utils";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A materials pick list with NO prices — for the field crew to pull/buy, or to
 *  send a supplier for a quote, without exposing cost or markup. */
export default async function MaterialListPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: list } = await supabase
    .from("material_lists")
    .select("name, created_at, jobs(job_number, name, address)")
    .eq("id", id)
    .maybeSingle();
  if (!list) notFound();

  const { data: items } = await supabase
    .from("material_list_items")
    .select("description, part_number, quantity, unit, vendor")
    .eq("list_id", id)
    .order("sort_order");

  const { data: org } = await supabase.from("organizations").select("*").maybeSingle();
  const company = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "material_list");
  const l = list as any;
  const job = l.jobs;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <Link href={`/materials/${id}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PrintButton label="Print pick list" />
      </div>

      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
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
              {job.address ? <span className="text-slate-500"> · {job.address}</span> : null}
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
              <th className="py-2">Vendor</th>
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
                <td className="py-2.5 text-slate-500">{it.vendor || "—"}</td>
              </tr>
            ))}
            {!(items ?? []).length && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-400">No items on this list.</td>
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
