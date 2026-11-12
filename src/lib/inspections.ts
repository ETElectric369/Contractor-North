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
 *     from it: it may never have happened, so the page asks (its Didn't Happen? tile).
 *   • filed — everything settled, behind the ?view=completed toggle, under three headings by ONE
 *     rule (filedUnder): completed and written up, lost (by OUTCOME, whatever the status), cancelled.
 *
 * The tags a row wears live here too (inspectionRowTags), for the same reason: one rule, one place.
 *
 * THE PAGE DRAWS THE PILES AS TILES (tileInspections): Write Up, Coming Up, Needs a Day and Didn't
 * Happen? for open work; Completed, Lost and Cancelled for what is filed. Which tile a visit sits
 * under, which tile opens first and what a row says (inspectionRowWords) are decided here, so the
 * page and its tests read one rule.
 */
import { appointmentTypeLabel } from "@/lib/statuses";
import type { Lang } from "@/lib/locale";
import { say, type Words } from "@/lib/lang-words";
import { isStockBookingTitle } from "@/lib/schedule/work-shape";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

export interface InspectionBucketRow {
  id: string;
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
 * OPEN. Nothing is lost by dropping it: every tile on the page already says the pile (Write Up,
 * Completed, Lost, Cancelled).
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
  /** Everything settled: written up, won, lost, cancelled. Newest first (the ?view=completed pile);
   *  the page draws it under three headings, each row under the one filedUnder names. */
  filed: T[];
}

/** The three headings of the filed pile, in the order /inspections draws them. */
export type FiledUnder = "completed" | "lost" | "cancelled";

/**
 * WHICH HEADING A FILED ROW IS DRAWN UNDER: THE OUTCOME FIRST, WHATEVER THE STATUS.
 *
 * The owner's standing rule: a visit that did not become work is LOST, everywhere. The page split the
 * filed pile on status alone (cancelled, or else "Completed & written up"), so a visit that never
 * happened and was answered Lost from the Didn't Happen? group (still 'scheduled', nothing captured,
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
): InspectionBuckets<T> {
  const out: InspectionBuckets<T> = { toWriteUp: [], upcoming: [], missed: [], filed: [] };
  const todayStart = tzDayStartUtc(todayStrInTz(tz, now), tz).getTime();
  const time = (r: T) => (r.starts_at ? new Date(r.starts_at).getTime() : 0);

  for (const r of rows) {
    const capQuote = captureQuoteId(r.capture);
    /**
     * FOUR WAYS A VISIT ENDS, not one (0205).
     *
     * This asked only "does an estimate exist?", so an inspection that turned into billed,
     * paid work still nagged (Mallow Springs: job complete, invoice paid, no estimate ever
     * written) and a lost bid could never leave at all (Donner Pass, which has no customer,
     * inquiry, job or estimate to hang anything on). Money is an outcome; so is a decision.
     */
    const settled =
      (!!r.inquiry_id && estimateInquiryIds.has(r.inquiry_id)) ||
      (!!r.job_id && estimateJobIds.has(r.job_id)) ||
      (!!capQuote && estimateQuoteIds.has(capQuote)) ||
      (!!r.job_id && billedJobIds.has(r.job_id)) ||
      /* A LINKED JOB IS ITSELF SETTLEMENT. The write-up nag asks "did the visit become an
         estimate?" — but a visit whose work went straight to a JOB was answered better than any
         estimate could: the work is sold (Erik's Karen: job on the calendar, and this bucket
         still demanding "Create estimate"). Billing-only was too narrow — it kept nagging
         through the whole gap between winning the work and invoicing it. */
      !!r.job_id ||
      !!r.outcome;
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

/* ── THE PAGE'S TILES ───────────────────────────────────────────────────────────────────────────── */

/** The four piles of open work, in the order the page draws their tiles. An id is never shown. */
export const OPEN_TILES = ["write_up", "coming_up", "needs_day", "missed"] as const;
/** The filed pile's three headings as tiles: filedUnder's own words, in the order they are drawn. */
export const FILED_TILES = ["completed", "lost", "cancelled"] as const satisfies readonly FiledUnder[];
export type OpenTile = (typeof OPEN_TILES)[number];
export type FiledTile = (typeof FILED_TILES)[number];
export type InspectionTile = OpenTile | FiledTile;
/** The page's two views: open work, and what is filed (the URL still says ?view=completed for it). */
export type InspectionsView = "open" | "filed";

/** The tiles of a view, in the order they are drawn. */
export function tilesOf(view: InspectionsView): readonly InspectionTile[] {
  return view === "filed" ? FILED_TILES : OPEN_TILES;
}

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

/**
 * WHICH TILE IS OPEN TO BEGIN WITH. The one asked for (the address's ?tile=, so Back from an
 * inspection lands on the tile it was opened from) when it is a tile of this view and still has rows;
 * else the first tile that has any; else none. Anything else in the address is ignored.
 */
export function openFirstTile(view: InspectionsView, counts: Readonly<Record<InspectionTile, number>>, wanted?: string | null): InspectionTile | null {
  const tiles = tilesOf(view);
  const asked = tiles.find((t) => t === wanted);
  if (asked && counts[asked] > 0) return asked;
  return tiles.find((t) => counts[t] > 0) ?? null;
}

/**
 * THE TAGS A ROW WOULD WEAR, AS PLAIN WORDS, in order: the page says them in the row's phrase and
 * draws no pill. The same rule as inspectionRowTags (no "done" tag, ever); "no field notes" is said
 * under Write Up only, and "cancelled" is left out under the Cancelled tile, whose name already says it
 * (a cancelled visit filed under Lost still says so).
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
