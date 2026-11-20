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

export const dynamic = "force-dynamic";

/**
 * THE LEADS LIST (cn-v1170). Erik, 2026-11-19: "NEW INTAKE ONLY (Remove Follow up-due)", and "if a
 * lead is still on the lead page that IS the reminder ... one badge one list simple". The list is
 * lib/leads/new-intake's (open, and no visit from it still stands: the badge reads the same rule),
 * newest first, one card per lead. Not Sold leads wait in a fold under it, kept on file.
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
      .select("id, name, company_name, message")
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
  const notSoldRows = (notSoldRead.data ?? []) as NotSoldLine[];
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
            />
          ))}
        </ul>
      )}

      <NotSoldFold leads={notSold} cut={notSoldRows.length > NOT_SOLD_FOLD_CAP} failed={!!notSoldRead.error} t={t} />
    </div>
  );
}

