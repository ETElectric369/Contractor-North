import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { PageHeader, EmptyState } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { currentLangFor } from "@/lib/current-lang";
import { ESTIMATE_VISIT_TYPES, appointmentTypeLabel, isDecidableVisitType, visitTitle } from "@/lib/statuses";
import {
  bucketInspections,
  filedUnder,
  filedWithNobody,
  inspectionFileHref,
  inspectionList,
  inspectionRowWords,
  rowTagWords,
  type FiledUnder,
  type InspectionListState,
} from "@/lib/inspections";
import { dayWords, relativeWhen } from "@/lib/action-items/dated-when";
import { featureOn } from "@/lib/features";
import { FiledWithNobodyFold, InspectionList, PRIMARY } from "./inspection-list";
import { happenedSaidKey, primaryOf, rowDoors, stateWordKey, type FoldRow, type ListRow } from "./list-rows";

export const dynamic = "force-dynamic";

/** How many visits the page reads at most. When exactly this many come back, the list says so
 *  (ip_capped: the visits waiting for a day and the latest by date are the ones kept). */
const READ_CAP = 500;

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
 * Everything a row says is worded HERE, on the server, in the reader's language and the company's
 * timezone, and the rows are handed finished strings: nothing on the phone formats a date, so the
 * server's render and the phone's cannot differ.
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

  const [{ data: apptData }, { data: quoteLinks }, { data: org }] = await Promise.all([
    supabase
      .from("appointments")
      // customer_id: where a row's name leads (inspectionFileHref), and whether a filed one hangs on
      // nobody (filedWithNobody); left out, every customer's inspection would read as nobody's.
      .select(
        "id, type, title, status, starts_at, ends_at, created_at, location, capture, inquiry_id, job_id, customer_id, outcome, customers(name), inquiries(name)",
      )
      .in("type", [...ESTIMATE_VISIT_TYPES])
      // THE CAP NEVER CUTS OPEN WORK THAT HAS NO DAY. Newest start first with the visits waiting
      // for a day (no start, 0368) ahead of them all, so the 500 kept are every visit waiting for a
      // day plus the latest by date; what the cap cuts is the oldest by date. The order on screen is
      // the list's own (inspectionList), never this one.
      .order("starts_at", { ascending: false, nullsFirst: true })
      .limit(READ_CAP),
    // Which inquiries/jobs already have an estimate — the "written up" signal. Ids too:
    // a lead-less Inspect-now write-up is matched via capture.quote_id (no inquiry/job link).
    supabase.from("quotes").select("id, inquiry_id, job_id"),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);

  const orgS = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const tz = orgS.timezone;
  // THE SWITCH BOARD (0352), from the settings and role already read. Inspections are part of
  // Leads: off, this list still opens from a link, under the Off line, and the empty state sends
  // nobody to Leads. Estimates off: no Create Estimate on a row.
  const sw = { features: orgS.features, isOwner: me.role === "owner" };
  const leadsOn = featureOn(sw.features, "leads");
  const estimateDoor = featureOn(sw.features, "estimates");
  const rows = (apptData ?? []) as any[];
  const estimateInquiryIds = new Set<string>(
    (quoteLinks ?? []).map((q: any) => q.inquiry_id).filter(Boolean),
  );
  const estimateJobIds = new Set<string>((quoteLinks ?? []).map((q: any) => q.job_id).filter(Boolean));
  const estimateQuoteIds = new Set<string>((quoteLinks ?? []).map((q: any) => q.id).filter(Boolean));
  // Same four endings as the inbox (0205) — this list and Needs-action must never disagree
  // about what is outstanding, which is why they share bucketInspections.
  const { data: billedJobs } = await supabase
    .from("invoices")
    .select("job_id")
    .not("job_id", "is", null)
    .not("status", "in", "(draft,void)")
    .limit(5000);
  // ONE "now" for the buckets, the list and the rows' words, so the three cannot disagree.
  const now = new Date();
  const buckets = bucketInspections(
    rows,
    estimateInquiryIds,
    estimateJobIds,
    now,
    estimateQuoteIds,
    new Set(((billedJobs ?? []) as { job_id: string }[]).map((r) => r.job_id).filter(Boolean)),
    tz, // "before today" is the company's midnight (a day that passed)
  );
  // EVERY OPEN VISIT ONCE, IN ONE STATE (lib/inspections inspectionList). The page tests no status
  // and no outcome of its own. A visit still `upcoming` whose day went by before today is a day that
  // passed, by the same now and the same company midnight the buckets read.
  const listed = inspectionList(buckets, now, tz);

  // THE ROW'S RIGHT EDGE, said here once. A Coming Up visit says when it is: its time alone today
  // (one earlier today that nobody closed out says its time too), its day and its time after. A
  // write-up and a missed visit say how long ago their day was, and a visit with no day how long ago
  // it was made: an age, so the DAY alone is handed over (the company's day) and no time of day rides
  // along ("9d ago", never "9d ago · 10:00 AM"). The day a thing happened is never "overdue". An age
  // whose day is still ahead (a visit marked done before its day) says that day, never "Tomorrow",
  // which would read as when it is due. A filed visit (the fold) says its day.
  const todayStr = todayStrInTz(tz, now);
  const said = { lang, words: t };
  const dayOf = (iso: string | null | undefined): string | null => {
    const at = iso ? new Date(iso) : null;
    return at && !Number.isNaN(at.getTime()) ? todayStrInTz(tz, at) : null;
  };
  const ageOf = (iso: string | null | undefined): string | null => {
    const day = dayOf(iso);
    return day && day > todayStr ? dayWords(day, todayStr, tz, lang) : relativeWhen(day, todayStr, tz, false, said);
  };
  const edgeOf = (a: any, state: InspectionListState): string | null => {
    if (state === "coming_up") return relativeWhen(a.starts_at, todayStr, tz, false, said);
    if (state === "needs_day") return ageOf(a.created_at);
    return ageOf(a.starts_at); // write_up, missed: how long ago its day was
  };

  /**
   * WHO AND WHAT, every word finished (lib/inspections inspectionRowWords): who in bold, then what it
   * is. visitTitle: a title stamped during the three days the visit was a Walk-Through still says
   * today's word. The words the old pills said ride in the phrase (rowTagWords, handed the row's
   * state, or for the fold how it ended), never as a pill. stampLabels: a stored title was stamped
   * with the type's ENGLISH label, whoever reads it now.
   */
  const wordsOf = (a: any, tile: InspectionListState | FiledUnder) =>
    inspectionRowWords({
      title: visitTitle(a.title),
      typeLabel: appointmentTypeLabel(a.type, lang, t),
      stampLabels: [appointmentTypeLabel(a.type, "en")],
      customer: a.customers?.name ?? a.inquiries?.name ?? null,
      street: a.location ?? null,
      tags: rowTagWords(a, tile, lang, t),
      lang,
    });

  /** One visit on the list, every word finished, its buttons decided (list-rows). */
  const rowOf = (a: any, state: InspectionListState): ListRow => {
    const words = wordsOf(a, state);
    const decidable = isDecidableVisitType(a.type);
    const kind = primaryOf(state, { decidable, estimatesOn: estimateDoor });
    const visitHref = `/appointments/${a.id}`;
    // THE BOXED BUTTON. Create Estimate: the capture prefills the estimator scope; the inquiry keeps
    // the lead threading (quotes/new also recovers it from the capture appointment when absent).
    // Start Inspection and Open Inspection both open the visit, where the inspection is done.
    const primary =
      kind === "estimate"
        ? { label: t("ip_btn_createEstimate"), href: `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}` }
        : { label: t(kind === "start" ? "ip_btn_startInspection" : "ip_btn_openInspection"), href: visitHref };
    const wordKey = stateWordKey(state, estimateDoor);
    return {
      id: a.id,
      state,
      who: words.who,
      whoHref: inspectionFileHref(a),
      what: words.what,
      edge: edgeOf(a, state),
      stateWord: wordKey ? t(wordKey) : null,
      primary,
      visitHref,
      doors: rowDoors(state, { primary: kind, decidable, hasStart: !!a.starts_at }),
      startsAt: a.starts_at ?? null,
      endsAt: a.ends_at ?? null,
      happenedSaid: t(happenedSaidKey(estimateDoor)),
    };
  };
  const listRows: ListRow[] = listed.map(({ row, state }) => rowOf(row, state));

  // FILED UNDER NOBODY: no lead, no customer, no job, so no file to find them in. Its day and how it
  // ended (filedUnder: the outcome first, whatever the status).
  const foldRows: FoldRow[] = filedWithNobody(buckets.filed).map((a: any) => {
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

      {listRows.length === 0 ? (
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
        </EmptyState>
      ) : (
        <InspectionList rows={listRows} tz={tz} />
      )}
      {rows.length === READ_CAP && <p className="mt-3 px-1 text-xs text-slate-600">{fillSlots(t("ip_capped"), { n: READ_CAP })}</p>}
      <FiledWithNobodyFold rows={foldRows} t={t} />
    </div>
  );
}
