import { notFound } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { buildPrelimNotice } from "@/lib/prelim-notice";
import { type SiteParts, pickSite, siteLines } from "@/lib/site-address";
import { formatCityStateZip } from "@/lib/utils";

export const dynamic = "force-dynamic";

const csz = (x: any) => formatCityStateZip(x?.city, x?.state, x?.zip);

/**
 * THE ADDRESS ON THE LIEN NOTICE, through the one resolver (cn-v711).
 *
 * Built by hand here, so it predated `unit` — and a preliminary notice that names the building but
 * not the dwelling is the one document where that ambiguity has consequences. Four TTP jobs share
 * 300 W Lake Blvd. It also had no fallback: a job with no address of its own served a notice
 * reading "(address — fill in before serving)" while the customer's address sat one query away.
 *
 * COMMA-joined, unlike the contract's block. Every line of this notice is `LABEL: value` and the
 * parties are one-per-line, so a newline inside a value would leave an orphan floating flush-left
 * between two headings. siteLines still decides the ORDER — the dwelling lands after the street and
 * before the city, which is the whole reason not to concatenate these by hand.
 */
const siteText = (...candidates: { source: string; parts?: SiteParts | null }[]): string | undefined =>
  siteLines(pickSite(candidates)).join(", ") || undefined;

export default async function PrelimNoticePage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const supabase = await createClient();
  // Staff-only (defense-in-depth beyond the lien_records RLS): a non-staff member
  // should never render another's lien notice.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !isStaffRole((me as any).role)) notFound();

  const { data: job } = await supabase
    .from("jobs")
    .select("name, address, unit, city, state, zip, description, customer_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) notFound();
  const j = job as any;

  const [{ data: lien }, { data: customer }, { data: org }, { data: quotes }] = await Promise.all([
    supabase.from("lien_records").select("*").eq("job_id", jobId).maybeSingle(),
    j.customer_id
      ? supabase.from("customers").select("name, address, unit, city, state, zip").eq("id", j.customer_id).maybeSingle()
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
    owner: (() => {
      /**
       * A DIFFERENT OWNER DOESN'T LIVE AT THE CUSTOMER'S ADDRESS (audit 8).
       *
       * When staff record a landlord or property manager as the property owner and leave the
       * address blank, this printed the TENANT'S mailing address beside the owner's name —
       * a served notice asserting something false about who owns what. The fallback is only
       * honest when the owner IS the customer (the common case: staff type the same name).
       */
      const ownerName = l?.owner_name || cu?.name || undefined;
      const ownerIsCustomer =
        !l?.owner_name ||
        (!!cu?.name && String(l.owner_name).trim().toLowerCase() === String(cu.name).trim().toLowerCase());
      return {
        name: ownerName,
        address:
          l?.owner_address ||
          (ownerIsCustomer ? siteText({ source: "customer", parts: cu }) : "(owner's address — fill in before serving)"),
      };
    })(),
    hiredBy: { name: l?.hired_by_name || cu?.name || undefined },
    gc: l?.gc_name ? { name: l.gc_name, address: l?.gc_address || undefined } : undefined,
    lender: l?.lender_name ? { name: l.lender_name, address: l?.lender_address || undefined } : undefined,
    /**
     * A PRELIMINARY NOTICE WITH THE WRONG PROPERTY IS LEGALLY DEFECTIVE (audit 8).
     *
     * When the job carries no address of its own — every job started from a fragment — this
     * fell back to the CUSTOMER'S MAILING address and printed it under PROJECT / JOBSITE with
     * nothing to say it had. For a landlord or property-manager customer that is a different
     * building entirely, and a 20-day notice naming the wrong property protects nothing.
     *
     * The marker goes IN the document text, not in a banner: the only route into this page is
     * the PDF preview, and the PDF render strips .no-print, so a screen-only warning would
     * never be seen by the person about to serve it. Same inline convention the template
     * already uses for its other must-fill blanks.
     */
    propertyAddress: (() => {
      const site = pickSite([{ source: "job", parts: j }, { source: "customer", parts: cu }]);
      const text = siteLines(site).join(", ") || undefined;
      if (!text) return undefined;
      return site?.source === "customer"
        ? `${text} (from customer on file — VERIFY THE JOBSITE BEFORE SERVING)`
        : text;
    })(),
    description: j.description || undefined,
    estimatedAmount: estimated,
  });

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end px-4">
        <PrintButton label="Print / Save PDF" />
      </div>
      <div className="print-page mx-auto bg-white shadow-sm">
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
