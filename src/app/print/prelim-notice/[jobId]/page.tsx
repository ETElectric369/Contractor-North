import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { buildPrelimNotice } from "@/lib/prelim-notice";

export const dynamic = "force-dynamic";

function csz(x: any): string {
  const cs = [x?.city, x?.state].filter(Boolean).join(", ");
  return [cs, x?.zip].filter(Boolean).join(" ").trim();
}

export default async function PrelimNoticePage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await createClient();
  // Staff-only (defense-in-depth beyond the lien_records RLS): a non-staff member
  // should never render another's lien notice.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin", "office"].includes((me as any).role)) notFound();

  const { data: job } = await supabase
    .from("jobs")
    .select("name, address, city, state, zip, description, customer_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) notFound();
  const j = job as any;

  const [{ data: lien }, { data: customer }, { data: org }, { data: quotes }] = await Promise.all([
    supabase.from("lien_records").select("*").eq("job_id", jobId).maybeSingle(),
    j.customer_id
      ? supabase.from("customers").select("name, address, city, state, zip").eq("id", j.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("organizations").select("name, license, address_line1, address_line2, city, state, zip, phone, email").maybeSingle(),
    supabase.from("quotes").select("total, status").eq("job_id", jobId),
  ]);
  const o = org as any;
  const cu = customer as any;
  const l = lien as any;

  // Estimated total = the lien record's figure, else the ACCEPTED quote(s) only —
  // never the sum of unaccepted/draft quotes (which would overstate a legal figure).
  const acceptedTotal = (quotes ?? [])
    .filter((q: any) => q.status === "accepted")
    .reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  const estimated = l?.estimated_amount && Number(l.estimated_amount) > 0 ? Number(l.estimated_amount) : acceptedTotal;

  const notice = buildPrelimNotice({
    claimant: {
      name: o?.name ?? "Contractor",
      address: [o?.address_line1, o?.address_line2, csz(o)].filter(Boolean).join(", ") || undefined,
      license: o?.license || undefined,
    },
    owner: {
      name: l?.owner_name || cu?.name || undefined,
      address: l?.owner_address || [cu?.address, csz(cu)].filter(Boolean).join(", ") || undefined,
    },
    hiredBy: { name: l?.hired_by_name || cu?.name || undefined },
    gc: l?.gc_name ? { name: l.gc_name } : undefined,
    lender: l?.lender_name ? { name: l.lender_name, address: l?.lender_address || undefined } : undefined,
    propertyAddress: [j.address, csz(j)].filter(Boolean).join(", ") || undefined,
    description: j.description || undefined,
    estimatedAmount: estimated,
  });

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end px-4">
        <PrintButton label="Print / Save PDF" />
      </div>
      <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-900">{notice}</div>
        <div className="mt-10 grid grid-cols-2 gap-8 text-sm">
          <div>
            <div className="border-b border-slate-400 pb-8" />
            <div className="mt-1 text-xs text-slate-500">Signature of claimant</div>
          </div>
          <div>
            <div className="border-b border-slate-400 pb-8" />
            <div className="mt-1 text-xs text-slate-500">Date</div>
          </div>
        </div>
      </div>
    </div>
  );
}
