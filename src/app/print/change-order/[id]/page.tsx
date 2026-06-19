import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatCurrency, formatDate } from "@/lib/utils";
import { docTitle } from "@/lib/doc-title";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("change_orders").select("co_number, jobs(name)").eq("id", id).maybeSingle();
  return { title: docTitle(data ? `Change Order ${(data as any).co_number}` : "Change Order", (data as any)?.jobs?.name) };
}

export default async function ChangeOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: co } = await supabase
    .from("change_orders")
    .select("*, jobs(job_number, name, customers(name, company_name, address, city, state, zip))")
    .eq("id", id)
    .maybeSingle();

  if (!co) notFound();
  const { data: org } = await supabase.from("organizations").select("*").maybeSingle();
  const company = companyFromOrg(org as Organization | null);
  const template = templateFor(org as Organization | null, "change_order");
  const customer = (co as any).jobs?.customers;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-between px-4">
        <Link href="/change-orders" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <PrintButton />
      </div>

      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        <DocHeader
          co={company}
          template={template}
          meta={{
            docType: "Change Order",
            number: (co as any).co_number,
            rows: [{ label: "Date", value: formatDate((co as any).created_at) }],
          }}
        />

        <div className="mt-6 grid grid-cols-2 gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">For</div>
            {customer ? (
              <div className="mt-1 text-sm text-slate-700">
                <div className="font-medium text-slate-900">{customer.name}</div>
                {customer.company_name && <div>{customer.company_name}</div>}
                {customer.address && <div>{customer.address}</div>}
                {(customer.city || customer.state || customer.zip) && (
                  <div>{[customer.city, customer.state, customer.zip].filter(Boolean).join(", ")}</div>
                )}
              </div>
            ) : (
              <div className="mt-1 text-sm text-slate-400">—</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Job</div>
            <div className="mt-1 text-sm text-slate-700">
              {(co as any).jobs?.name ?? "—"}
              {(co as any).jobs?.job_number ? ` (${(co as any).jobs.job_number})` : ""}
            </div>
            <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Status</div>
            <div className="mt-1 text-sm capitalize text-slate-700">{(co as any).status}</div>
          </div>
        </div>

        <div className="mt-8 border-t border-slate-200 pt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Description of change
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
            {(co as any).description}
          </p>
        </div>

        <div className="mt-6 flex justify-end">
          <div className="w-64 border-t border-slate-300 pt-2 text-base font-bold text-slate-900">
            <div className="flex justify-between">
              <span>Change total</span>
              <span>{formatCurrency((co as any).amount)}</span>
            </div>
          </div>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-8 text-sm">
          <div>
            <div className="h-10 border-b border-slate-400" />
            <div className="mt-1 text-xs text-slate-500">Customer approval / date</div>
          </div>
          <div>
            <div className="h-10 border-b border-slate-400" />
            <div className="mt-1 text-xs text-slate-500">Contractor / date</div>
          </div>
        </div>
      </div>
    </div>
  );
}
