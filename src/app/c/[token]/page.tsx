import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { companyFromOrg } from "@/components/doc-letterhead";
import { DocHeader, templateFor } from "@/components/doc-templates";
import { formatDate, formatCityStateZip } from "@/lib/utils";
import { ContractSign } from "./sign";
import { NO_INDEX } from "@/lib/no-index";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_contract", { p_token: token });
  const num = data?.contract?.contract_number;
  // NEVER indexed — permanent bearer token + a signable customer contract. See @/lib/no-index.
  return { title: num ? `Contract ${num}` : "Contract", robots: NO_INDEX };
}

export default async function PublicContractPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_contract", { p_token: token });
  if (!data || !data.contract) notFound();

  const ct = data.contract;
  const c = data.customer;
  const org = data.org as any;
  const co = companyFromOrg(org);
  const template = templateFor(org, "contract");
  const signed = ct.status === "signed";
  // A signed contract always shows the exact text that was signed (frozen snapshot),
  // never the live body — so the record reflects what the customer agreed to.
  const displayBody = signed ? ct.signed_body || ct.body : ct.body;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end px-4">
        <PrintButton label="Print / Save PDF" />
      </div>

      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        <DocHeader
          co={co}
          template={template}
          meta={{
            docType: "Contract",
            number: ct.contract_number,
            rows: [{ label: "Date", value: formatDate(ct.created_at) }],
          }}
        />

        <div className="mt-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Prepared for</div>
          {c ? (
            <div className="mt-1 text-sm text-slate-700">
              <div className="font-medium text-slate-900">{c.name}</div>
              {c.company_name && <div>{c.company_name}</div>}
              {c.address && <div>{c.address}</div>}
              {(c.city || c.state || c.zip) && <div>{formatCityStateZip(c.city, c.state, c.zip)}</div>}
            </div>
          ) : null}
        </div>

        {ct.title && <h1 className="mt-5 text-lg font-semibold text-slate-900">{ct.title}</h1>}

        <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{displayBody}</div>

        <div className="mt-8 border-t border-slate-200 pt-6">
          {signed ? (
            <div className="rounded-xl bg-green-50 px-5 py-4 text-sm text-green-800">
              <div className="font-semibold">Signed</div>
              <div className="mt-1">
                Signed by <span className="font-medium">{ct.signed_name}</span>
                {ct.signed_at ? ` on ${formatDate(ct.signed_at)}` : ""}. A copy has been recorded.
              </div>
            </div>
          ) : ct.status === "sent" ? (
            <ContractSign token={token} brand={co.brand} />
          ) : (
            <div className="rounded-xl bg-slate-50 px-5 py-4 text-sm text-slate-500">
              This contract isn&apos;t available to sign yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
