import { redirect } from "next/navigation";
import { UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { PageHeader, EmptyState } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { currentLang } from "@/lib/current-lang";
import { InquiryModal } from "./inquiry-modal";
import { InquiryRow } from "./inquiry-row";
import { ReferralTally } from "./referral-tally";
import { NOT_SOLD_FOLD_CAP, NotSoldFold, type NotSoldLine } from "./not-sold-fold";
import type { Inquiry } from "@/lib/types";
import { loadNewIntake, NOT_SOLD_STATUS } from "@/lib/leads/new-intake";
import { reportError } from "@/lib/observe";
import { viewerSwitches } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";
import { readAllPages } from "@/lib/read-all-pages";
import { leadsNotSoldByEstimate, NOT_SOLD_BY_ESTIMATE_COLUMNS } from "@/lib/leads/not-sold-by-estimate";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The lead columns a fold row reads, either kind. */
const FOLD_LEAD_COLUMNS = "id, name, company_name, message";
/** Lead ids per `in` read: a long list in one URL is refused. */
const ID_CHUNK = 50;

/**
 * THE LEADS AN ESTIMATE ENDED (cn-v1172). Erik, 2026-11-19: "if they are Not Sold then the data stays
 * with them in that file for further sales reach out". A lead is never marked Not Sold by hand once an
 * estimate is written for it (saving the estimate converts the lead), so a customer who said no to the
 * price was on no list. lib/leads/not-sold-by-estimate decides which leads those are, from every
 * estimate of the company (read whole: an estimate still in play, for the lead or for its customer,
 * must never be cut out of the read and the lead called Not Sold on a guess). Nothing is stamped on
 * the lead.
 *
 * `skip`: leads already on the page (the hand-marked fold, the open list), each listed once. `want`:
 * how many the fold can still show, plus one so it can say it was cut. Newest answer first.
 */
async function readNotSoldByEstimate(
  supabase: SupabaseClient,
  skip: ReadonlySet<string>,
  want: number,
): Promise<{ leads: NotSoldLine[]; error: unknown }> {
  if (want <= 0) return { leads: [], error: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  // EVERY estimate, with or without a lead (cn-v1172 fixer): a duplicated estimate, or one started
  // from the customer's page, carries no lead, and its customer is what ties it back to one.
  const quotes = await readAllPages<{ inquiry_id: string | null; status: string | null; customer_id: string | null }>((from, to) =>
    sb
      .from("quotes")
      .select(NOT_SOLD_BY_ESTIMATE_COLUMNS)
      .order("updated_at", { ascending: false })
      .order("id")
      .range(from, to),
  );
  if (quotes.error) return { leads: [], error: quotes.error };
  const ids = leadsNotSoldByEstimate(quotes.rows).filter((id) => !skip.has(id)).slice(0, want);
  const byId = new Map<string, NotSoldLine>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await sb.from("inquiries").select(FOLD_LEAD_COLUMNS).in("id", ids.slice(i, i + ID_CHUNK));
    if (error) return { leads: [], error };
    for (const l of (data ?? []) as Omit<NotSoldLine, "byEstimate">[]) byId.set(l.id, { ...l, byEstimate: true });
  }
  // The rule's order (newest answer first), not the read's.
  return { leads: ids.map((id) => byId.get(id)).filter((l): l is NotSoldLine => !!l), error: null };
}

export const dynamic = "force-dynamic";

/**
 * THE LEADS LIST (cn-v1170). Erik, 2026-11-19: "NEW INTAKE ONLY (Remove Follow up-due)", and "if a
 * lead is still on the lead page that IS the reminder ... one badge one list simple". The list is
 * lib/leads/new-intake's (open, and no visit from it still stands: the badge reads the same rule),
 * newest first, one card per lead. Not Sold leads wait in a fold under it, kept on file: the ones
 * marked Not Sold by hand, then (cn-v1172, Estimates on) the ones whose estimate was declined.
 */
export default async function InquiriesPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const { focus } = await searchParams;
  // A LINK TO A LEAD IS /leads/<id>: the old ?focus= deep links (My Day, an estimate's "from lead")
  // land on the lead's file, converted or not.
  if (focus) redirect(`/leads/${encodeURIComponent(focus)}`);
  const supabase = await createClient();
  const t = translator(await currentLang());

  // ONE CLOCK (cn-v1170): the rule's pick window and each row's running clock read the same now.
  const nowMs = Date.now();
  const [intake, notSoldRead, sw, { data: tzRow }] = await Promise.all([
    loadNewIntake<Inquiry>(supabase, "*, referrer:profiles!inquiries_referred_by_fkey(full_name)", { nowMs }),
    // One more than the fold shows, so it can say it was cut.
    supabase
      .from("inquiries")
      .select(FOLD_LEAD_COLUMNS)
      .eq("status", NOT_SOLD_STATUS)
      .is("converted_at", null)
      .order("updated_at", { ascending: false })
      .limit(NOT_SOLD_FOLD_CAP + 1),
    // THE SWITCH BOARD (0352). Leads off: this page still opens from a link, with the shell's Off
    // line on top, and New Lead goes. Website requests keep arriving either way. Track Referrals off:
    // no tally.
    viewerSwitches(),
    // `phone` rides along with the settings read (PROJECTION LAW): the business line is what the Let
    // Them Pick handoff has to be able to NAME (convert-menu).
    supabase.from("organizations").select("settings, phone").limit(1).maybeSingle(),
  ]);
  const leadsOn = featureOn(sw.features, "leads");
  if (intake.error) reportError("leads:list", intake.error);
  if (notSoldRead.error) reportError("leads:notSold", notSoldRead.error);

  const inquiries = intake.leads;
  const handRows = (notSoldRead.data ?? []) as NotSoldLine[];
  // THE FOLD'S SECOND KIND (cn-v1172): only where the company writes estimates; off, no read at all.
  // The fold's count and its cap cover both kinds, the hand-marked first.
  const byEstimate =
    featureOn(sw.features, "estimates") && !notSoldRead.error
      ? await readNotSoldByEstimate(
          supabase,
          new Set([...handRows.map((l) => l.id), ...inquiries.map((i) => i.id)]),
          NOT_SOLD_FOLD_CAP + 1 - handRows.length,
        )
      : { leads: [], error: null };
  if (byEstimate.error) reportError("leads:notSoldByEstimate", byEstimate.error);
  const notSoldRows = [...handRows, ...byEstimate.leads];
  const notSold = notSoldRows.slice(0, NOT_SOLD_FOLD_CAP);

  // The company's clock, and the server's now for each row's running clock (its first draw).
  const tz = getOrgSettings((tzRow as { settings?: unknown } | null)?.settings).timezone;
  const businessPhone = ((tzRow as { phone?: string | null } | null)?.phone ?? "").trim() || null;

  return (
    <div>
      <PageHeader title={t("nv_page_leads")} description={t("nv_desc_leads")}>
        {leadsOn && <InquiryModal />}
      </PageHeader>

      {/* Staff-only commission lookup — renders nothing for crew or when no lead
          has a referrer. Sits above the open list because converted referrals
          drop OUT of that list and this is where their credit stays visible. */}
      {featureOn(sw.features, "referrals") && <ReferralTally />}

      {intake.error ? (
        // A FAILED READ IS NEVER "NO LEADS": the empty state would tell him there is nothing to call.
        <p role="status" className="rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("ld_listCouldntLoad")}
        </p>
      ) : inquiries.length === 0 ? (
        // No duplicate "New lead" here (Andrew, 8/21: "leave the new lead button on the top
        // right and get rid of the button in the center its redundant") — the header's button
        // is always on screen, including over this empty state.
        <EmptyState icon={UserPlus} title={t("ld_noOpenLeads")} description={leadsOn ? t("ld_emptyDesc") : t("ld_nothingOpen")} />
      ) : (
        // ONE CARD PER LEAD, with space between ("Add visual barrier bolder between leads").
        <ul className="space-y-3">
          {inquiries.map((i) => (
            <InquiryRow
              key={i.id}
              inquiry={i}
              tz={tz}
              businessPhone={businessPhone}
              nowMs={nowMs}
              visitsUnread={intake.unread.has(i.id)}
              pickPending={intake.pickPending.has(i.id)}
              wonPending={intake.wonPending.has(i.id)}
            />
          ))}
        </ul>
      )}

      {/* A failed estimates read (cn-v1172 fixer) fails only its own part: the hand-marked rows, and
          their Reopen, were read fine and are drawn, with one line saying what could not be read. */}
      <NotSoldFold
        leads={notSold}
        cut={notSoldRows.length > NOT_SOLD_FOLD_CAP}
        failed={!!notSoldRead.error}
        estimatesFailed={!!byEstimate.error}
        t={t}
      />
    </div>
  );
}

