import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { translator } from "@/lib/i18n";
import { currentLang } from "@/lib/current-lang";
import { leadStage, visitStands } from "@/lib/leads/new-intake";
import { reportError } from "@/lib/observe";
import { viewerSwitches } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";
import { readLeadFile } from "./file-reads";
import { LeadFile } from "./lead-file";

export const dynamic = "force-dynamic";

/**
 * THE LEAD'S FILE, /leads/<id> (cn-v1170). Erik, 2026-11-19: "Ok lets make everything staged around
 * the customer and stored with the customer file to make it easier". The customer record is still
 * made at the win; until then this page is the lead's file, and once it has a customer it hands over
 * with a link. Access is the Leads list's own (leads/page.tsx): no guard of its own, the session's RLS,
 * and a lead that does not resolve is a 404. `?schedule=1` opens the Schedule sheet.
 */
export default async function LeadFilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ schedule?: string }>;
}) {
  const [{ id }, { schedule }] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const lang = await currentLang();
  const t = translator(lang);

  const [read, sw, { data: orgRow }] = await Promise.all([
    readLeadFile(supabase, id),
    viewerSwitches(),
    // `phone` rides along with the settings read, as on the list: Let Them Pick names the business line.
    supabase.from("organizations").select("settings, phone").limit(1).maybeSingle(),
  ]);

  if (read.leadError) {
    reportError("leads:file", read.leadError);
    return (
      <p role="status" className="rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        {t("ld_file_leadUnread")}
      </p>
    );
  }
  if (!read.lead) notFound();
  for (const [what, e] of Object.entries(read.readErrors)) reportError(`leads:file:${what}`, e);

  // ONE CLOCK for the page (cn-v1170): the stage, the pick line and the running clock all read it.
  const nowMs = Date.now();
  // A failed visits read is not a standing visit: the lead is offered, never hidden.
  const stage = leadStage(read.lead, (read.visits ?? []).some((v) => visitStands(v, nowMs)));
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone;
  const businessPhone = ((orgRow as { phone?: string | null } | null)?.phone ?? "").trim() || null;

  return (
    <LeadFile
      lead={read.lead}
      stage={stage}
      visits={read.visits}
      estimates={read.estimates}
      jobs={read.jobs}
      customerName={read.customerName}
      tz={tz}
      businessPhone={businessPhone}
      nowMs={nowMs}
      lang={lang}
      t={t}
      referralsOn={featureOn(sw.features, "referrals")}
      estimatesOn={featureOn(sw.features, "estimates")}
      openSchedule={schedule === "1"}
    />
  );
}
