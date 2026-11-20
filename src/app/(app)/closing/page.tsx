import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader } from "@/components/page-header";
import { fillText, translator } from "@/lib/i18n";
import { currentLangFor } from "@/lib/current-lang";
import { switchesFromRow } from "@/lib/viewer-switches";
import { featureOn } from "@/lib/features";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { smsReadiness } from "@/lib/sms";
import { reportError } from "@/lib/observe";
import { CLOSING_CAP, loadClosing } from "@/lib/estimate/closing";
import { ClosingList } from "./closing-list";
import { cardRow } from "./card-row";

export const dynamic = "force-dynamic";

/**
 * Sales > Closing (cn-v1172): every estimate that is SENT and not settled, the inbox of answers
 * still to come. Erik, 2026-11-19, after the second meeting: "we want it to appear in a new sub-nav
 * tab right below Estimates called Closing as an inbox for estimates that havent been accepted only
 * for a sales person, once an estimate is accepted it will disappear from there and file with the
 * customer file". Who sees it: "sales will be admin or office owner so nothing new or special there
 * just a place to see that sales need attention", so it is the office's (a tech goes to My Day, the
 * way /inspections sends one). And: "Closing is the reminder yes": an estimate has no follow-up day.
 *
 * ONE READER (lib/estimate/closing loadClosing), the same rule the Sales dot and Needs You's No
 * Answer Yet rows read, so the three cannot disagree. A failed read of the list is said on the page,
 * never drawn as an empty inbox; a failed read BEHIND it (a bill, a revision, the send log) is filed
 * and the rows are still drawn, since that read settles nothing and logs no send.
 *
 * THE SWITCH (0352): with Estimates off the page still opens from a link (the dock row is gone), and
 * an estimate already in a customer's hands is a live obligation, so it is still listed. The shell's
 * Off line (FEATURE_ROUTES has /closing) already says the switch is off, so the page's own line says
 * only what that one does not: an estimate already sent still waits here (cn-v1172 fixer).
 */
export default async function ClosingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // The role, the company's switches, its clock and its texting ride one row.
  const { data: me } = user
    ? await supabase.from("profiles").select("role, active, organizations(name, settings)").eq("id", user.id).maybeSingle()
    : { data: null };
  if (!me || !isStaffRole((me as { role?: string }).role ?? "")) redirect("/planner");
  const lang = await currentLangFor(user?.id);
  const t = translator(lang);

  const orgRel = (me as { organizations?: unknown }).organizations;
  const org = ((Array.isArray(orgRel) ? orgRel[0] : orgRel) ?? null) as { name?: string | null; settings?: unknown } | null;
  const estimatesOn = featureOn(switchesFromRow(me).features, "estimates");
  const tz = getOrgSettings(org?.settings).timezone;
  // ONE CLOCK: the company's today for the rule, and the server's now for each row's first draw.
  const nowMs = Date.now();
  const todayStr = todayStrInTz(tz);

  const read = await loadClosing(supabase, { todayStr });
  if (read.error) reportError("closing:list", read.error);
  for (const e of read.softErrors) reportError("closing:behind-the-list", e);

  return (
    <div>
      <PageHeader title={t("nv_page_closing")} description={t("nv_desc_closing")} />
      {!estimatesOn && <p className="mb-3 text-sm text-slate-600">{t("cl_estimatesOff")}</p>}
      {read.error ? (
        // A FAILED READ IS NEVER "NOTHING IS OUT": the empty state would say nobody owes an answer.
        <p role="status" data-closing-failed="" className="rounded-xl border-2 border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-800">
          {t("cl_listCouldntLoad")}
        </p>
      ) : (
        <>
          {/* The cap keeps the estimates WRITTEN FIRST (the read's order), and says so. */}
          {read.cut && <p className="mb-3 text-sm text-slate-600" data-closing-cut="">{fillText(t("cl_cut"), { n: String(CLOSING_CAP) })}</p>}
          <ClosingList rows={read.rows.map(cardRow)} nowMs={nowMs} todayStr={todayStr} tz={tz} textReady={smsReadiness(org).ready} />
        </>
      )}
    </div>
  );
}
