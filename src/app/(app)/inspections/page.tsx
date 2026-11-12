import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import { PageHeader, EmptyState } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { currentLangFor } from "@/lib/current-lang";
import { ESTIMATE_VISIT_TYPES, appointmentTypeLabel, isDecidableVisitType, visitTitle } from "@/lib/statuses";
import {
  bucketInspections,
  inspectionRowWords,
  openFirstTile,
  rowTagWords,
  tileInspections,
  tilesOf,
  type InspectionTile,
  type InspectionsView,
} from "@/lib/inspections";
import { dayWords, relativeWhen } from "@/lib/action-items/dated-when";
import { AppointmentButton } from "../appointments/appointment-button";
import { NewInspectionButton } from "../appointments/new-inspection-button";
import { featureOn } from "@/lib/features";
import { InspectionsBoard } from "./inspections-board";
import type { BoardRow, BoardTile, RowMenu } from "./board-types";

export const dynamic = "force-dynamic";

/** How many visits the page reads at most. When exactly this many come back, the board says so
 *  (ip_capped: the visits waiting for a day and the latest by date are the ones kept). */
const READ_CAP = 500;

/** Each tile's name (a tile is a button, so its key is ip_btn_…). */
const TILE_NAME_KEY: Record<InspectionTile, string> = {
  write_up: "ip_btn_tileWriteUp",
  coming_up: "ip_btn_tileComingUp",
  needs_day: "ip_btn_tileNeedsADay",
  missed: "ip_btn_tileMissed",
  completed: "ip_btn_tileCompleted",
  lost: "ip_btn_tileLost",
  cancelled: "ip_btn_tileCancelled",
};

/**
 * WHAT A ROW'S ⋯ OFFERS, BY ITS TILE. Lost is not offered on Coming Up or Needs a Day: a visit whose
 * day is still ahead (or that has none) stays in its pile after Lost is written (bucketInspections files
 * an outcome only for a visit that is completed or past), so the answer would look like it did nothing.
 * A filed row has no ⋯ at all. The row's own kind can take Lost away too (menuOf).
 */
const TILE_MENU: Record<InspectionTile, RowMenu | null> = {
  write_up: { move: false, happened: false, lost: true, del: false },
  coming_up: { move: true, happened: false, lost: false, del: true },
  needs_day: { move: false, happened: false, lost: false, del: true },
  missed: { move: true, happened: true, lost: true, del: true },
  completed: null,
  lost: null,
  cancelled: null,
};

/**
 * Sales → Inspections (the route never moved; lib/statuses holds the one word): appointments of the
 * inspection types, an inspection being one appointment type on one platform.
 *
 * Two views behind one switch: OPEN work (the default) and FILED (?view=completed, the estimates
 * file-away pattern). Each view is a grid of tiles that open one at a time (the one TileGrid, the
 * same as Needs You's): Write Up, Coming Up, Needs a Day and Didn't Happen? for open work; Completed,
 * Lost and Cancelled for what is filed. Which tile a visit sits under is ONE rule (lib/inspections
 * tileInspections, over the buckets My Day's Needs You reads too, so the two never disagree).
 *
 * Everything a row says is worded HERE, on the server, in the reader's language and the company's
 * timezone, and the board is handed finished strings: nothing on the phone formats a date, so the
 * server's render and the phone's cannot differ.
 */
export default async function InspectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: viewParam } = await searchParams;
  const showCompleted = viewParam === "completed";
  const view: InspectionsView = showCompleted ? "filed" : "open";
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

  const [{ data: apptData }, { data: quoteLinks }, { data: org }, pickers] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, type, title, status, starts_at, ends_at, created_at, location, capture, inquiry_id, job_id, outcome, customers(name), inquiries(name)",
      )
      .in("type", [...ESTIMATE_VISIT_TYPES])
      // THE CAP NEVER CUTS OPEN WORK THAT HAS NO DAY. Newest start first with the visits waiting
      // for a day (no start, 0368) ahead of them all, so the 500 kept are every visit waiting for a
      // day plus the latest by date; what the cap cuts is the oldest by date. The order on screen is
      // the tiles' own (tileInspections), never this one.
      .order("starts_at", { ascending: false, nullsFirst: true })
      .limit(READ_CAP),
    // Which inquiries/jobs already have an estimate — the "written up" signal. Ids too:
    // a lead-less Inspect-now write-up is matched via capture.quote_id (no inquiry/job link).
    supabase.from("quotes").select("id, inquiry_id, job_id"),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    getSchedulePickerOptions(supabase),
  ]);

  const orgS = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const tz = orgS.timezone;
  // THE SWITCH BOARD (0352), from the settings and role already read. Inspections are part of
  // Leads: off, this list still opens from a link, under the Off line, with no new-inspection doors.
  // Estimates off: no Create Estimate on a row.
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
  // ONE "now" for the buckets, the tiles and the tiles' lines, so the three cannot disagree.
  const now = new Date();
  const { toWriteUp, upcoming, missed, filed } = bucketInspections(
    rows,
    estimateInquiryIds,
    estimateJobIds,
    now,
    estimateQuoteIds,
    new Set(((billedJobs ?? []) as { job_id: string }[]).map((r) => r.job_id).filter(Boolean)),
    tz, // "before today" is the company's midnight (the Didn't Happen? tile)
  );
  // EVERY VISIT UNDER EXACTLY ONE TILE (lib/inspections tileInspections; a filed row by filedUnder,
  // the outcome first, whatever the status). The page tests no status and no outcome of its own.
  // A visit still `upcoming` whose day went by before today is Didn't Happen?, by the same now and
  // the same company midnight the buckets read.
  const byTile = tileInspections({ toWriteUp, upcoming, missed, filed }, now, tz);
  const counts = Object.fromEntries(Object.entries(byTile).map(([k, v]) => [k, v.length])) as Record<InspectionTile, number>;

  // THE ROW'S RIGHT EDGE, said here once. A Coming Up visit says when it is: its time alone today
  // (one earlier today that nobody closed out says its time too), its day and its time after. A
  // write-up and a missed visit say how long ago their day was, and a visit with no day how long ago
  // it was made: an age, so the DAY alone is handed over (the company's day) and no time of day rides
  // along ("9d ago", never "9d ago · 10:00 AM"). The day a thing happened is never "overdue". An age
  // whose day is still ahead (a visit marked done before its day) says that day, never "Tomorrow",
  // which would read as when it is due. A filed visit says its day.
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
  const edgeOf = (a: any, tile: InspectionTile): string | null => {
    if (tile === "coming_up") return relativeWhen(a.starts_at, todayStr, tz, false, said);
    if (tile === "needs_day") return ageOf(a.created_at);
    if (tile === "write_up" || tile === "missed") return ageOf(a.starts_at);
    return dayWords(a.starts_at, todayStr, tz, lang);
  };

  /** A row's ⋯: its tile's moves, less Lost where the visit's kind has no win or loss to record (the
   *  city's Final Inspection). Nothing left: no ⋯. */
  const menuOf = (a: any, tile: InspectionTile): RowMenu | null => {
    const base = TILE_MENU[tile];
    if (!base) return null;
    const menu = { ...base, lost: base.lost && isDecidableVisitType(a.type) };
    return menu.move || menu.happened || menu.lost || menu.del ? menu : null;
  };

  /** One visit as a row, every word finished. */
  const rowOf = (a: any, tile: InspectionTile): BoardRow => {
    // EVERY ROW SAYS WHAT IT IS FOR (lib/inspections inspectionRowWords): who in bold, then what it
    // is. visitTitle: a title stamped during the three days the visit was a Walk-Through still says
    // today's word. The words the old pills said ride in the phrase (rowTagWords), never as a pill.
    // stampLabels: a stored title was stamped with the type's ENGLISH label, whoever reads it now.
    const words = inspectionRowWords({
      title: visitTitle(a.title),
      typeLabel: appointmentTypeLabel(a.type, lang, t),
      stampLabels: [appointmentTypeLabel(a.type, "en")],
      customer: a.customers?.name ?? a.inquiries?.name ?? null,
      street: a.location ?? null,
      tags: rowTagWords(a, tile, lang, t),
      lang,
    });
    // THE ROW'S OWN SMALL VERB. Create Estimate: the capture prefills the estimator scope; the
    // inquiry keeps the lead threading (quotes/new also recovers it from the capture appointment
    // when absent). Pick a Day: the schedule's Waiting for a Day rail is the one door that gives a
    // waiting visit a day AND a time, so none is invented here.
    const verb =
      tile === "write_up" && estimateDoor
        ? { label: t("ip_btn_createEstimate"), href: `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}` }
        : tile === "needs_day"
          ? { label: t("ip_btn_pickADay"), href: "/schedule" }
          : null;
    return {
      id: a.id,
      who: words.who,
      what: words.what,
      edge: edgeOf(a, tile),
      href: `/appointments/${a.id}`,
      verb,
      menu: menuOf(a, tile),
      startsAt: a.starts_at ?? null,
      endsAt: a.ends_at ?? null,
    };
  };

  /**
   * A tile's one quiet line: how old the oldest is, when the next one is, or what the pile means.
   * Oldest is the first row that HAS an edge (a done visit with no day sorts first and has none).
   * Next is the first row whose start is still AHEAD of now; when everything left is earlier today
   * there is no next, and the tile has no line.
   */
  const lineOf = (tile: InspectionTile, rows: BoardRow[]): string | null => {
    if (rows.length === 0) return null;
    switch (tile) {
      case "write_up":
      case "needs_day": {
        const oldest = rows.find((r) => r.edge)?.edge;
        return oldest ? fillSlots(t("ip_tileOldest"), { age: oldest }) : null;
      }
      case "coming_up": {
        const next = rows.find((r) => r.startsAt && Date.parse(r.startsAt) > now.getTime())?.edge;
        return next ? fillSlots(t("ip_tileNext"), { when: next }) : null;
      }
      case "missed":
        return t("ip_tilePastNoNotes");
      case "completed":
        return t("ip_tileWrittenUp");
      case "lost":
        return t("ip_tileDidntBecomeWork");
      case "cancelled":
        return t("ip_tileCalledOff");
    }
  };

  // Only the view on screen is worded and handed down.
  const tiles: BoardTile[] = tilesOf(view).map((id) => {
    const name = t(TILE_NAME_KEY[id]);
    const tileRows = byTile[id].map((a: any) => rowOf(a, id));
    const line = lineOf(id, tileRows);
    const label = tileRows.length > 0 ? `${name}: ${tileRows.length}${line ? `, ${line}` : ""}` : fillSlots(t("ip_tileNothing"), { name });
    return { id, name, label, count: tileRows.length, line, rows: tileRows };
  });
  // The tile the first paint opens: the first with rows. The board takes the one the address's hash
  // names once it is on the phone (the hash never reaches the server).
  const defaultOpen = openFirstTile(view, counts, null);
  const nothingHere = tiles.every((tile) => tile.count === 0);

  // 44px targets, like every tap in the app (the pill still reads as a pill).
  const pill = (active: boolean) =>
    `inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
      active
        ? "border-brand bg-brand-light/40 text-brand-dark"
        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
    }`;

  // The EXISTING appointment flow (Set a Time | Propose Times) preset to the inspection
  // type — shared by the header AND the empty state. A bare <NewInspectionButton /> falls back to
  // the generic /schedule create modal (type defaults to "appointment"), so a trusting tap there
  // would make a record that never appears here.
  const scheduleInspection = (
    <AppointmentButton
      jobs={pickers.jobOpts}
      customers={pickers.custOpts}
      staff={pickers.staffOpts}
      defaultType="inspection"
      buttonLabel={t("ip_btn_bookAnInspection")}
    />
  );

  return (
    <div>
      <PageHeader title={t("nv_page_inspections")} description={t("nv_desc_inspections")}>
        {/* The shared two-mode affordance: Start an Inspection (one tap → capture) or the EXISTING
            appointment flow (Set a Time | Propose Times), preset to the inspection type. */}
        {leadsOn && <NewInspectionButton schedule={scheduleInspection} />}
      </PageHeader>

      {/* Open work is the default view; settled paperwork files away (estimates pattern). */}
      <div className="mb-4 flex gap-2">
        <Link href="/inspections" className={pill(!showCompleted)}>
          {t("ip_btn_open")}
        </Link>
        <Link href="/inspections?view=completed" className={pill(showCompleted)}>
          {t("ip_btn_filed")}
        </Link>
      </div>

      {showCompleted && nothingHere ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t("ip_nothingFiledTitle")}
          description={t("ip_nothingFiledDesc")}
        />
      ) : nothingHere ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t("ip_noOpenInspections")}
          description={leadsOn ? t("ip_emptyDescLeadsOn") : t("ip_emptyDescLeadsOff")}
        >
          {leadsOn && <NewInspectionButton schedule={scheduleInspection} />}
        </EmptyState>
      ) : (
        <InspectionsBoard view={view} tiles={tiles} defaultOpen={defaultOpen} tz={tz} capped={rows.length === READ_CAP ? READ_CAP : null} />
      )}
    </div>
  );
}
