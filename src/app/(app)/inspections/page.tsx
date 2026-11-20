import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader, EmptyState } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { currentLangFor } from "@/lib/current-lang";
import { filedUnder, filedWithNobody, inspectionList, inspectionsToEstimate, type FiledUnder } from "@/lib/inspections";
import { readInspectionBuckets, VISIT_READ_CAP } from "@/lib/inspections-read";
import { reportError } from "@/lib/observe";
import { dayWords } from "@/lib/action-items/dated-when";
import { featureOn } from "@/lib/features";
import { FiledWithNobodyFold, InspectionList, PRIMARY, ToEstimateLine } from "./inspection-list";
import { inspectionRowBuilder } from "./row-words";
import type { FoldRow, ListRow } from "./list-rows";

export const dynamic = "force-dynamic";

/** How a filed inspection ended, as the fold says it (filedUnder's three endings). */
const ENDED_KEY: Record<FiledUnder, string> = {
  completed: "ip_endedCompleted",
  lost: "ip_endedNotSold",
  cancelled: "ip_endedCancelled",
};

/**
 * Sales → Inspections (the route never moved; lib/statuses holds the one word): appointments of the
 * inspection types, an inspection being one appointment type on one platform.
 *
 * ONE LIST (cn-v1171). Erik's meeting, 2026-11-19: "Just a list of people/leads that Need
 * Inspections", a boxed "START INSPECTION", and "Remove 'Book Inspec…'". The tiles, the Open / Filed
 * switch and the header's two buttons are gone: an inspection is booked from a lead, and a finished
 * one is found in its person's file. Which rows are on the list, and in what state, is ONE rule
 * (lib/inspections inspectionList, over the buckets My Day's Needs You reads too, so the two never
 * disagree). Filed inspections that hang on nobody wait in one fold under the list.
 *
 * INSPECTED, WAITING ON A PRICE, IS ON THE ESTIMATES PAGE (cn-v1172). Erik, after the second meeting:
 * "lets break the Estimate page into 2 parts consisting of completed inspections in its own new list
 * called Inspections To Estimate". With the Estimates switch on, an inspected visit nobody has priced
 * is drawn on top of the Estimates page and left off this list; with it off there is no such list and
 * it stays here. Both pages read through ONE reader (lib/inspections-read), so they cannot disagree,
 * and while any are over there this page says how many, with the door, so nobody falls between them.
 *
 * Every row is worded on the server by the one row builder both pages use (./row-words).
 */
export default async function InspectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  // The Filed view is gone (cn-v1171): an old link to it lands on the one list.
  const { view: viewParam } = await searchParams;
  if (viewParam) redirect("/inspections");
  const supabase = await createClient();

  // Office-only surface (mirrors /schedule): techs get My Day, not a half-empty sales tab.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) redirect("/planner");
  // The reader's language, read ONCE (current-lang caches per request) and handed to every row.
  const lang = await currentLangFor(user?.id);
  const t = translator(lang);

  // ONE "now" for the buckets, the list and the rows' words, so the three cannot disagree.
  const now = new Date();
  const read = await readInspectionBuckets(supabase, { now });
  if (read.error) reportError(`inspections:read:${read.error.where}`, read.error.cause);
  const { buckets, tz } = read;

  // THE SWITCH BOARD (0352), from the settings the reader read. Inspections are part of Leads: off,
  // this list still opens from a link, under the Off line, and the empty state sends nobody to Leads.
  // Estimates off: no Create Estimate on a row, and the inspected ones stay on this list.
  const leadsOn = featureOn(read.settings.features, "leads");
  const estimatesOn = featureOn(read.settings.features, "estimates");

  // EVERY OPEN VISIT ONCE, IN ONE STATE (lib/inspections inspectionList). The page tests no status
  // and no outcome of its own. A visit still `upcoming` whose day went by before today is a day that
  // passed, by the same now and the same company midnight the buckets read.
  const listed = inspectionList(buckets, now, tz, { estimatesOn });
  // The ones on the Estimates page's top list, counted here so this page can point at them.
  const toEstimate = estimatesOn ? inspectionsToEstimate(buckets).length : 0;

  const { todayStr, wordsOf, rowOf } = inspectionRowBuilder({ t, lang, tz, now, estimatesOn });
  const listRows: ListRow[] = listed.map(({ row, state }) => rowOf(row, state));

  // FILED UNDER NOBODY: no lead, no customer, no job, so no file to find them in. Its day and how it
  // ended (filedUnder: the outcome first, whatever the status).
  const foldRows: FoldRow[] = filedWithNobody(buckets.filed).map((a) => {
    const ended = filedUnder(a);
    const words = wordsOf(a, ended);
    return {
      id: a.id,
      who: words.who,
      what: words.what,
      day: dayWords(a.starts_at, todayStr, tz, lang),
      ending: t(ENDED_KEY[ended]),
      href: `/appointments/${a.id}`,
    };
  });

  return (
    <div>
      {/* No button in the header (cn-v1171: "Remove 'Book Inspec…'"): an inspection is booked from a
          lead, and started from its row. */}
      <PageHeader title={t("nv_page_inspections")} description={t("nv_desc_inspections")} />

      {read.error ? (
        // A FAILED READ IS NEVER "NOBODY IS WAITING" (cn-v1172): said, never drawn as an empty list.
        <p role="status" data-read-failed="" className="rounded-xl border-2 border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          {t("ip_readFailed")}
        </p>
      ) : listRows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t("ip_noOpenInspections")}
          description={leadsOn ? t("ip_emptyDescLeadsOn") : t("ip_emptyDescLeadsOff")}
        >
          {leadsOn && (
            <Link href="/leads" className={`${PRIMARY} mt-4`}>
              {t("ip_btn_goToLeads")}
            </Link>
          )}
          <ToEstimateLine n={toEstimate} t={t} />
        </EmptyState>
      ) : (
        <>
          <InspectionList rows={listRows} tz={tz} />
          <ToEstimateLine n={toEstimate} t={t} />
        </>
      )}
      {read.capped && <p className="mt-3 px-1 text-xs text-slate-600">{fillSlots(t("ip_capped"), { n: VISIT_READ_CAP })}</p>}
      <FiledWithNobodyFold rows={foldRows} t={t} />
    </div>
  );
}
