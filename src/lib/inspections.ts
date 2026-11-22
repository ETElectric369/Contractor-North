/**
 * Bucket logic for the Sales → Inspections tab (/inspections) — pure and unit-tested, because the tab's
 * whole promise is TRUTHFUL buckets (Erik's design 2026-07-14: open work first, settled
 * paperwork files away like estimates do).
 *
 *   • toWriteUp — the money bucket: the visit happened (status completed, or its time
 *     is past AND field capture exists — capture is what makes an unmarked visit "done")
 *     but no estimate exists yet on its inquiry or job. Each row's next step is one
 *     verb: Create Estimate.
 *   • upcoming — scheduled/proposed visits that are still ahead (or today), and a visit with no day.
 *   • missed — a visit still 'scheduled' on a day before today with NO capture and nothing written
 *     from it: it may never have happened, so its row says Day Passed and asks.
 *   • filed — everything settled, by ONE rule (filedUnder): completed and written up, lost (by
 *     OUTCOME, whatever the status), cancelled. It is found in its person's file; the page shows only
 *     the few that hang on nobody (filedWithNobody), in a fold.
 *
 * The tags a row wears live here too (inspectionRowTags), for the same reason: one rule, one place.
 *
 * THE PAGE IS ONE LIST (cn-v1171, inspectionList): every open visit once, in one state (Coming Up,
 * Needs a Day, Needs an Estimate, Day Passed). tileInspections stays as the rule under it (which pile
 * a visit is in); what a row says (inspectionRowWords) is decided here too, so the page and its tests
 * read one rule.
 */
import { appointmentTypeLabel } from "@/lib/statuses";
import type { Lang } from "@/lib/locale";
import { say, type Words } from "@/lib/lang-words";
import { isStockBookingTitle } from "@/lib/schedule/work-shape";
import { pickWentUnanswered } from "@/lib/leads/new-intake";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { visitSettled, type VisitLinks } from "@/lib/appointments/visit-settled";

/** THE ONE VISIT RULE (cn-v1175), said from here too: the write-up rule's settled test is the one
 *  Visits to Close Out and the Leads list read (lib/appointments/visit-settled). */
export { visitSettled, isSalesVisit, isWorkVisit, type VisitLinks, type VisitSettledWhy } from "@/lib/appointments/visit-settled";

export interface InspectionBucketRow {
  id: string;
  /** The visit's kind, when read: a city's final inspection is the job's business (visitSettled). */
  type?: string | null;
  status: string; // APPOINTMENT_STATUSES value
  starts_at: string | null;
  inquiry_id: string | null;
  job_id: string | null;
  capture?: unknown;
  /** How it ended, when somebody said so: won / lost / no_bid (0205). */
  outcome?: string | null;
}

/** The estimate this inspection was written up into, stamped on the capture jsonb by
 *  saveQuote when the builder was opened via /quotes/new?capture=<appt>. This is the
 *  write-up signal for the LEAD-LESS "Inspect now" path (no inquiry_id/job_id to match),
 *  which used to leave the row in "To write up" forever. */
export function captureQuoteId(capture: unknown): string | null {
  if (!capture || typeof capture !== "object") return null;
  const q = (capture as { quote_id?: unknown }).quote_id;
  return typeof q === "string" && q.length > 0 ? q : null;
}

/** True when the capture jsonb carries any real field data: the prose boxes, photos, or the typed
 *  rows (a take-off item, an ad-hoc measure — lib/inspection/capture). The typed rows were not
 *  counted before cn-v1069, so a visit with only a typed take-off read "no field notes". */
export function hasCaptureData(capture: unknown): boolean {
  if (!capture || typeof capture !== "object") return false;
  const c = capture as { notes?: unknown; measurements?: unknown; materials?: unknown; photos?: unknown; items?: unknown; measures?: unknown };
  const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const some = (v: unknown) => Array.isArray(v) && v.length > 0;
  return filled(c.notes) || filled(c.measurements) || filled(c.materials) || some(c.photos) || some(c.items) || some(c.measures);
}

/** One tag on an Inspections row: what it says, and the Badge tone it would say it in. The tone names
 *  are components/ui/badge's `Tone`, spelled out here so this module stays pure (no component
 *  import). The page draws no pill (it says the tags in the row's phrase, rowTagWords); the tones are
 *  kept for a caller that draws one. */
export interface InspectionRowTag {
  tone: "indigo" | "amber" | "slate";
  label: string;
}

/**
 * EVERY TAG AN INSPECTIONS ROW WEARS, in ONE place. /inspections draws one row component for the
 * open piles AND the filed pile, so a tag written inline on that row rides into the pile it was
 * never meant for.
 *
 * THERE IS NO "done" TAG, and that is the rule. Report 8592392b (2026-10-02): "glaring on the front
 * is [a customer] tagged Done while it sits in the open box." The green pill was drawn from
 * `status === "completed"` alone, so every row of the write-up pile — the OPEN pile, each row carrying
 * a Create Estimate button — advertised itself as finished work. BADGES AND TAGS SHOW ONLY WHAT IS
 * OPEN. Nothing is lost by dropping it: every row already says its state, and a filed one its ending.
 */
export function inspectionRowTags(
  row: { type?: string | null; status: string; capture?: unknown },
  /** The row is under Write Up, the one pile where a visit with no field notes is worth saying. */
  writeUp = false,
  /** The reader's language and translator (the Ventas-2 wave, cn-v1146): English, the default, is the
   *  tags' words byte for byte; a Spanish caller's translator reads lib/words/inspections' ip_lib_…. */
  lang: Lang = "en",
  words?: Words,
): InspectionRowTag[] {
  return keyedTags(row, writeUp, lang, words).map(({ tone, label }) => ({ tone, label }));
}

/** A tag and which of the four it is, so a reader can leave one out by what it IS, never by its words. */
type KeyedTag = InspectionRowTag & { key: "type" | "pending" | "cancelled" | "noNotes" };

/** The one list both readers draw from: inspectionRowTags (a tag with its tone) and rowTagWords (the
 *  same tags as plain words, for a row that says them in its phrase). */
function keyedTags(row: { type?: string | null; status: string; capture?: unknown }, writeUp: boolean, lang: Lang, words?: Words): KeyedTag[] {
  const tags: KeyedTag[] = [];
  // The CITY'S inspection on a permit (type final_inspection) is a different animal from the site
  // visit before a price (type inspection), and this list
  // holds both (ESTIMATE_VISIT_TYPES), so the row says which one it is.
  if (row.type === "final_inspection") tags.push({ key: "type", tone: "indigo", label: appointmentTypeLabel(row.type, lang, words) });
  if (row.status === "proposed") tags.push({ key: "pending", tone: "amber", label: say(lang, words, "ip_lib_pendingPick", "pending pick") });
  if (row.status === "cancelled") tags.push({ key: "cancelled", tone: "slate", label: say(lang, words, "ip_lib_cancelled", "cancelled") });
  if (writeUp && !hasCaptureData(row.capture)) tags.push({ key: "noNotes", tone: "slate", label: say(lang, words, "ip_lib_noFieldNotes", "no field notes") });
  return tags;
}

/** The words an inspection's title says when the person never named what it is FOR: the bare word,
 *  in either language. The type's own label (said in the caller's language) joins them. */
const GENERIC_INSPECTION_WORDS = new Set(["inspection", "site inspection", "inspección", "inspeccion", "inspección del sitio", "inspeccion del sitio", "inspección de sitio"]);

/** True when a visit's title tells nobody what the visit is for: empty, or only the word inspection /
 *  site inspection / the type's own label (either language), ignoring case, a trailing colon and spaces. */
export function isGenericInspectionTitle(title: string | null | undefined, typeLabel?: string | null): boolean {
  const norm = (v: string) => v.trim().replace(/[:\s]+$/u, "").replace(/\s+/g, " ").toLowerCase();
  const t = norm(title ?? "");
  if (!t) return true;
  if (GENERIC_INSPECTION_WORDS.has(t)) return true;
  const label = typeLabel ? norm(typeLabel) : "";
  return !!label && t === label;
}

/** What a row says, so every inspection reads as WHAT IT IS FOR: a real title stays and its subtitle
 *  carries the known parts of customer, street and day; a generic title gives way to the customer and
 *  street (else the type label), and the subtitle carries the day. Pure: the caller passes the type
 *  label and the day already said in the reader's language.
 *
 *  `kindUnder` is for a row that has no tag and no heading of its own to say the visit's KIND (My
 *  Day's write-up row): when the generic title gave way to who and where, the type's label leads the
 *  second line, so a Quote / Estimate or the city's Final Inspection still says which one it is. A
 *  row whose title IS the type's label already says it, so the label is never said twice. */
export function inspectionLabel(p: {
  title?: string | null;
  typeLabel: string;
  customer?: string | null;
  street?: string | null;
  day?: string | null;
  kindUnder?: boolean;
}): { title: string; subtitle: string } {
  const join = (parts: (string | null | undefined)[]) => parts.map((x) => (x ?? "").trim()).filter(Boolean).join(" · ");
  if (isGenericInspectionTitle(p.title, p.typeLabel)) {
    const whoWhere = join([p.customer, p.street]);
    return { title: whoWhere || p.typeLabel, subtitle: join([p.kindUnder && whoWhere ? p.typeLabel : null, p.day]) };
  }
  return { title: (p.title ?? "").trim(), subtitle: join([p.customer, p.street, p.day]) };
}

export interface InspectionBuckets<T> {
  /** Visit happened, no estimate yet — oldest first (longest-waiting write-up on top). */
  toWriteUp: T[];
  /** Scheduled/proposed — soonest first. */
  upcoming: T[];
  /** A visit still 'scheduled' on a day BEFORE today with nothing captured and nothing written from
   *  it: it may never have happened. Newest first. Never joins My Day's pile. */
  missed: T[];
  /** Everything settled: written up, won, lost, cancelled. Newest first; each row's ending is the one
   *  filedUnder names (the page's fold shows only the ones filed under nobody). */
  filed: T[];
}

/** The three endings of the filed pile (the fold's words: Completed, Not Sold, Cancelled). */
export type FiledUnder = "completed" | "lost" | "cancelled";

/**
 * WHICH HEADING A FILED ROW IS DRAWN UNDER: THE OUTCOME FIRST, WHATEVER THE STATUS.
 *
 * The owner's standing rule: a visit that did not become work is LOST, everywhere. The page split the
 * filed pile on status alone (cancelled, or else "Completed & written up"), so a visit that never
 * happened and was answered Lost from the page's day-passed group (still 'scheduled', nothing captured,
 * no estimate) was filed as completed and written up. It was neither.
 *
 *   lost        the outcome is lost or no_bid. no_bid is 0205's other word for the same ending: a few
 *               old rows hold it and Nort's door can still write it, and every screen already reads
 *               it as Lost (the visit page's ending card). A CANCELLED visit marked Lost is Lost too:
 *               the answer somebody gave says more than the status the calendar was left in.
 *   cancelled   called off, and nobody said it was lost.
 *   completed   everything else that files: written up, on a job, billed, or won.
 *
 * It names the heading and nothing else. WHETHER a row files at all is bucketInspections' business
 * (an outcome files a completed visit, and a scheduled or proposed one once its time has passed);
 * this is asked of the rows it filed.
 */
export function filedUnder(row: Pick<InspectionBucketRow, "status" | "outcome">): FiledUnder {
  if (row.outcome === "lost" || row.outcome === "no_bid") return "lost";
  if (row.status === "cancelled") return "cancelled";
  return "completed";
}

export function bucketInspections<T extends InspectionBucketRow>(
  rows: T[],
  estimateInquiryIds: ReadonlySet<string>,
  estimateJobIds: ReadonlySet<string>,
  now: Date = new Date(),
  /** Ids of quotes that still EXIST — matched against capture.quote_id so the lead-less
   *  "Inspect now" write-up files away too (and truthfully un-files if the quote is deleted). */
  estimateQuoteIds: ReadonlySet<string> = new Set(),
  /** Job ids that have real billing on them — a visit that became BILLED WORK is finished,
   *  estimate or no estimate (0205). Empty set keeps the old behaviour for callers that
   *  don't care (e.g. a pure calendar view). */
  billedJobIds: ReadonlySet<string> = new Set(),
  /** The company's timezone: "before today" is the company's midnight, not UTC's. */
  tz: string = "UTC",
  /** The links only some readers read (cn-v1175): the jobs that are over, and when each lead closed.
   *  Left out, a visit is never settled by them (offered, never hidden). */
  more: Pick<VisitLinks, "closedJobIds" | "leadClosedAt" | "finishedJobIds"> = {},
): InspectionBuckets<T> {
  const out: InspectionBuckets<T> = { toWriteUp: [], upcoming: [], missed: [], filed: [] };
  const todayStart = tzDayStartUtc(todayStrInTz(tz, now), tz).getTime();
  const time = (r: T) => (r.starts_at ? new Date(r.starts_at).getTime() : 0);
  const links: VisitLinks = { estimateInquiryIds, estimateJobIds, estimateQuoteIds, billedJobIds, ...more };

  for (const r of rows) {
    /**
     * FOUR WAYS A VISIT ENDS, not one (0205), and since cn-v1175 ONE RULE for every reader
     * (lib/appointments/visit-settled visitSettled): an answer, a job that is over, an estimate written
     * from it or for its lead or its job, its lead closed after it, or a job it is tied to. Money is an
     * outcome; so is a decision. (Mallow Springs: job complete, invoice paid, no estimate ever written,
     * and the visit still nagged; Donner Pass, a lost bid with nothing to hang it on, could never leave.)
     *
     * THE CITY'S FINAL INSPECTION ON A JOB is never written up into an estimate: it files once it has
     * its job, as it always did here. That is a write-up fact, not a settled one (Visits to Close Out
     * still asks about it until its job is over).
     */
    const settled = visitSettled(r, links) !== null || (r.type === "final_inspection" && !!r.job_id);
    const writtenUp = settled;
    const past = !!r.starts_at && new Date(r.starts_at).getTime() < now.getTime();

    if (r.status === "cancelled") out.filed.push(r);
    else if (r.status === "completed") (writtenUp ? out.filed : out.toWriteUp).push(r);
    // "Done by capture": a past visit with field data counts as happened even if nobody
    // tapped complete — unless its estimate already exists, in which case it's settled.
    // A written-up estimate is itself the strongest "the visit happened" signal, so a
    // past visit whose estimate exists files even when the capture text was left blank.
    else if (past && (hasCaptureData(r.capture) || writtenUp))
      (writtenUp ? out.filed : out.toWriteUp).push(r);
    // A past DAY, still scheduled, nothing captured, nothing written from it: it may never have
    // happened, so it asks instead of posing as upcoming.
    else if (r.status === "scheduled" && !!r.starts_at && new Date(r.starts_at).getTime() < todayStart) out.missed.push(r);
    else out.upcoming.push(r);
  }

  out.toWriteUp.sort((a, b) => time(a) - time(b));
  out.upcoming.sort((a, b) => time(a) - time(b));
  out.missed.sort((a, b) => time(b) - time(a));
  out.filed.sort((a, b) => time(b) - time(a));
  return out;
}

/* ── THE PILES (the page drew them as tiles until cn-v1171; inspectionList draws one list over them) ── */

/** The four piles of open work. An id is never shown. */
export const OPEN_TILES = ["write_up", "coming_up", "needs_day", "missed"] as const;
/** The filed pile's three endings: filedUnder's own words. */
export const FILED_TILES = ["completed", "lost", "cancelled"] as const satisfies readonly FiledUnder[];
export type OpenTile = (typeof OPEN_TILES)[number];
export type FiledTile = (typeof FILED_TILES)[number];
export type InspectionTile = OpenTile | FiledTile;

/**
 * EVERY INSPECTION UNDER EXACTLY ONE TILE, from the buckets bucketInspections made (which My Day's
 * Needs You reads too, so the two can never disagree about what is open).
 *
 *   write_up    the visit happened and nothing was written from it: oldest first.
 *   coming_up   today or later, booked or proposed and waiting on the customer's pick: soonest first.
 *   needs_day   booked with no day (0368): the one that has waited longest first, by the day it was
 *               made. A row with no such stamp keeps its place at the end.
 *   missed      its day went by with nothing captured: newest first. A PROPOSED visit whose day went
 *               by with no pick is here too. bucketInspections leaves it in `upcoming` for ever (only
 *               a booked visit can be "missed" there), and under Coming Up it stood first and said
 *               "Next: 12d ago". A proposal nobody picked did not happen; its row says "pending pick".
 *   completed / lost / cancelled   the filed pile under filedUnder's three headings, newest first.
 *
 * "Upcoming" is split by two facts, whether the visit has a start and whether that start is before
 * today (the company's midnight, as bucketInspections reads it), so a row cannot sit under two tiles.
 */
export function tileInspections<T extends InspectionBucketRow & { created_at?: string | null }>(
  b: InspectionBuckets<T>,
  now: Date = new Date(),
  tz: string = "UTC",
): Record<InspectionTile, T[]> {
  const out: Record<InspectionTile, T[]> = { write_up: [...b.toWriteUp], coming_up: [], needs_day: [], missed: [...b.missed], completed: [], lost: [], cancelled: [] };
  const todayStart = tzDayStartUtc(todayStrInTz(tz, now), tz).getTime();
  const start = (r: T) => (r.starts_at ? new Date(r.starts_at).getTime() : 0);
  let lateProposal = false;
  for (const r of b.upcoming) {
    if (!r.starts_at) out.needs_day.push(r);
    else if (start(r) < todayStart) {
      out.missed.push(r);
      lateProposal = true;
    } else out.coming_up.push(r);
  }
  if (lateProposal) out.missed.sort((a, c) => start(c) - start(a));
  const made = (r: T) => {
    const at = r.created_at ? new Date(r.created_at).getTime() : NaN;
    return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
  };
  out.needs_day.sort((a, c) => made(a) - made(c));
  for (const r of b.filed) out[filedUnder(r)].push(r);
  return out;
}

/* ── THE ONE LIST (cn-v1171) ────────────────────────────────────────────────────────────────────── */

/** The states a row on the Inspections list can be in, in the order the list is drawn. */
export const INSPECTION_LIST_ORDER = ["coming_up", "needs_day", "write_up", "missed"] as const satisfies readonly OpenTile[];
export type InspectionListState = (typeof INSPECTION_LIST_ORDER)[number];

/**
 * THE INSPECTIONS PAGE IS ONE LIST (the meeting's notes, 2026-11-19: "Just a list of people/leads
 * that Need Inspections"). The tiles are gone. What a row IS is still decided by the rule the tiles
 * had (tileInspections over bucketInspections, which Needs You reads too), so the page and My Day
 * cannot disagree about what is open. A row's state is the open pile it sits in:
 *
 *   coming_up   booked for today or later, or waiting on the customer's pick: soonest first.
 *   needs_day   on the books with no day: the one that has waited longest first.
 *   write_up    inspected, and nothing written from it yet: oldest first. WHERE IT IS DRAWN depends
 *               on the Estimates switch (cn-v1172, below): on, it is the Estimates page's top list
 *               and is left off this one; off, it stays here, so nobody falls between the two pages.
 *   missed      its day went by with nothing captured: newest first.
 *
 * In that order: who to go and inspect, who is waiting on a day, who is waiting on a price, and last
 * the ones that need an answer.
 *
 * ONE LIST PER LEAD. A pick-a-time request whose first time went by with no answer no longer stands
 * (lib/leads/new-intake): its lead is back on the Leads list, and that row says the times were sent.
 * It is left off this list, or the same person would be on both with two sets of buttons. A request
 * like that with NO lead has no other list to be on, so it stays here.
 *
 * Nothing filed is on it. A finished, Not Sold or cancelled inspection is found in its person's file
 * (the lead's, the customer's, the job's); the few that hang on nobody are filedWithNobody's.
 *
 * INSPECTED PEOPLE MOVE TO ESTIMATES (cn-v1172). Erik, 2026-11-19, after the second meeting: "lets
 * break the Estimate page into 2 parts consisting of completed inspections in its own new list called
 * Inspections To Estimate, and the other section below is all Estimates". So with `estimatesOn` the
 * write_up pile is NOT on this list: it is inspectionsToEstimate's, drawn on top of the Estimates
 * page, and one person is never on both with two sets of buttons. With Estimates switched off there
 * is no such page, and the pile stays here (its row says Inspected and never names an estimate).
 */
export function inspectionList<T extends InspectionBucketRow & { created_at?: string | null }>(
  b: InspectionBuckets<T>,
  now: Date = new Date(),
  tz: string = "UTC",
  opts: { estimatesOn?: boolean } = {},
): { row: T; state: InspectionListState }[] {
  const piles = tileInspections(b, now, tz);
  const nowMs = now.getTime();
  const out: { row: T; state: InspectionListState }[] = [];
  for (const state of INSPECTION_LIST_ORDER) {
    for (const row of piles[state]) {
      // The Estimates page's top list holds what waits on a price; a win with no job picked waits on its
      // JOB (cn-v1175, R8), so it stays here whatever the switch says.
      if (state === "write_up" && opts.estimatesOn && !wonWithNoJob(row)) continue;
      const ranOut = pickWentUnanswered({ status: row.status, outcome: row.outcome ?? null, starts_at: row.starts_at }, nowMs);
      if (ranOut && row.inquiry_id) continue;
      out.push({ row, state });
    }
  }
  return out;
}

/**
 * INSPECTIONS TO ESTIMATE (cn-v1172): the Estimates page's top list. The very pile the Inspections
 * list calls write_up (the visit happened and nothing was written from it), oldest first, from the
 * same buckets Needs You reads. inspectionList leaves these off when Estimates is on, so every
 * inspected visit is on exactly one of the two pages.
 */
export function inspectionsToEstimate<T extends InspectionBucketRow>(b: InspectionBuckets<T>): T[] {
  return b.toWriteUp.filter((r) => !wonWithNoJob(r));
}

/** A visit marked Won with no job picked (cn-v1175, R8): open, asking for its job, on the Inspections list. */
export function wonWithNoJob(r: Pick<InspectionBucketRow, "outcome" | "job_id">): boolean {
  return r.outcome === "won" && !r.job_id;
}

/**
 * FILED, AND FILED UNDER NOBODY. The page's Filed side is gone (cn-v1171): a finished inspection is
 * found in its person's file. One with no lead, no customer and no job has no such file, so the page
 * keeps those in one quiet fold, and nothing that could be reached stops being reachable. The order
 * is the filed pile's own (newest first).
 *
 * `customer_id` is REQUIRED on the row: a read that left the column out would call every customer's
 * inspection nobody's.
 */
export function filedWithNobody<T extends InspectionBucketRow & { customer_id: string | null }>(filed: readonly T[]): T[] {
  return filed.filter((r) => !r.inquiry_id && !r.job_id && !r.customer_id);
}

/**
 * THE NOT SOLD FOLD (cn-v1175, R8). The owner: "could we safely say that it could go in the Not Sold
 * box to simplify everything including the Not FIled under anyone group with is confusing in itself?"
 * The fold under the list holds every inspection that ENDED WITHOUT BECOMING WORK and has no person's
 * file to live in: its record says Not Sold, or it was cancelled (filedUnder's lost and cancelled).
 * One that was written up or became work is found from its estimate or its job, so it is not here; a
 * visit marked Won with no job picked is not an ending at all (visitSettled) and is on the open list,
 * asking for its job. No data is patched: a read and a label.
 */
export function notSoldWithNobody<T extends InspectionBucketRow & { customer_id: string | null }>(filed: readonly T[]): T[] {
  return filedWithNobody(filed).filter((r) => filedUnder(r) !== "completed");
}

/**
 * WHERE A ROW'S NAME LEADS: the person's file, where all of their information is kept (Erik,
 * 2026-11-19: "on the inspections page lets have just the lead which will be where all of their info
 * is stored"). The lead's file while there is a lead; else the customer's page; else the job. The
 * city's Final Inspection is about a job's permit, so it leads to its job first. null: the visit
 * hangs on nobody. On the Inspections page such a name is still a link, to the visit itself
 * (inspections/inspection-list.tsx, `nameOpensVisit`, cn-v1181); only the Estimates page's top list
 * draws it as plain words, where the row's dots still open the visit.
 */
export function inspectionFileHref(r: {
  type?: string | null;
  inquiry_id?: string | null;
  customer_id?: string | null;
  job_id?: string | null;
}): string | null {
  if (r.type === "final_inspection" && r.job_id) return `/jobs/${r.job_id}`;
  if (r.inquiry_id) return `/leads/${r.inquiry_id}`;
  if (r.customer_id) return `/crm/${r.customer_id}`;
  if (r.job_id) return `/jobs/${r.job_id}`;
  return null;
}

/**
 * THE TAGS A ROW WOULD WEAR, AS PLAIN WORDS, in order: the page says them in the row's phrase and
 * draws no pill. The same rule as inspectionRowTags (no "done" tag, ever); "no field notes" is said
 * under Write Up only, and "cancelled" is left out of a row whose ending already says Cancelled (a
 * cancelled visit filed under Not Sold still says so).
 *
 * EVERY KIND BUT THE PLAIN INSPECTION SAYS WHICH IT IS. The page holds three kinds of visit
 * (ESTIMATE_VISIT_TYPES). The city's Final Inspection has always had its tag; a Quote / Estimate visit
 * used to say so through the title its booking door stamped ("Quote: Sam Tillery"), and a row that
 * says the person in bold no longer repeats that stamp, so the kind is said here, first.
 */
export function rowTagWords(
  row: { type?: string | null; status: string; capture?: unknown },
  tile: InspectionTile,
  lang: Lang = "en",
  words?: Words,
): string[] {
  const tags = keyedTags(row, tile === "write_up", lang, words).filter((t) => !(t.key === "cancelled" && tile === "cancelled"));
  const kind = row.type && row.type !== "inspection" && !tags.some((t) => t.key === "type") ? [appointmentTypeLabel(row.type, lang, words)] : [];
  return [...kind, ...tags.map((t) => t.label)];
}

/**
 * WHAT A ROW ON THE PAGE SAYS: who it is for in bold, then what it is as a phrase.
 *
 * A title counts as TYPED only when a person wrote it: not the bare word (isGenericInspectionTitle)
 * and not a stamp a booking door wrote ("Inspection: Sam Tillery", isStockBookingTitle), which would
 * say the bold name twice.
 *
 *   somebody is named   who = the name;                         what = typed title · street · tags
 *   nobody is named     who = the typed title, else the street,  what = the street (only when the title
 *                       else the type's label;                   is the who) · tags
 *
 * The parts of `what` are joined with " · " and its first letter is a capital in the reader's
 * language (a phrase that begins with a tag reads "No field notes"). It may be empty. The day is not
 * here: the page puts it at the row's right edge. Pure: the caller hands the type's label and the
 * tags already said in the reader's language.
 *
 * `stampLabels` are the other spellings of the type's label a stored title may be: a title is stamped
 * in English whoever reads it, so a Spanish reader's caller hands the English label too, and "Final
 * Inspection" is not taken for words somebody typed. A tag that only repeats the bold line is left out
 * (with nobody named and nothing typed the bold line IS the type's label).
 */
export function inspectionRowWords(p: {
  title?: string | null;
  typeLabel: string;
  stampLabels?: readonly string[];
  customer?: string | null;
  street?: string | null;
  tags?: readonly string[];
  lang?: Lang;
}): { who: string; what: string } {
  const clean = (v: string | null | undefined) => String(v ?? "").trim();
  const customer = clean(p.customer);
  const street = clean(p.street);
  const title = clean(p.title);
  const generic = [p.typeLabel, ...(p.stampLabels ?? [])].some((label) => isGenericInspectionTitle(title, label));
  // The names a booking door could have stamped: who, the place whole, and its street alone.
  const typed = !!title && !generic && !isStockBookingTitle(title, [customer, street, street.split(",")[0]]);
  const who = customer || (typed ? title : street || p.typeLabel);
  const tags = (p.tags ?? []).map(clean).filter((tag) => tag.toLowerCase() !== who.toLowerCase());
  const parts = customer ? [typed ? title : "", street, ...tags] : typed ? [street, ...tags] : tags;
  const what = parts.filter(Boolean).join(" · ");
  return { who, what: what ? what.charAt(0).toLocaleUpperCase(p.lang === "es" ? "es" : "en") + what.slice(1) : "" };
}
