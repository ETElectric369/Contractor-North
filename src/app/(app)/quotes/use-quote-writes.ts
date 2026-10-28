import { useState, useSyncExternalStore } from "react";
import type { DraftLineItem, TaskDetail } from "@/lib/estimate/line-map";
import { coerceTaskDetail, detailExplains } from "@/lib/estimate/task-lines";
import { repriceRows, type RuleInputs } from "@/lib/estimate/reprice-rows";
import type { EstimateFormat } from "@/lib/doc-style";
import type { QuoteDocType } from "@/lib/doc-label";

/**
 * THE ONE SAVE MODEL FOR AN ESTIMATE (cn-v1132) — the invoice editor's, and nothing else.
 *
 * Two editors used to hold the same document two ways: the builder kept the whole estimate in the
 * browser (a sessionStorage draft, a debounced autosave every 1.5 s, a queue of coalesced saves),
 * the saved page wrote one line at a time. Erik lived the split on 2026-10-27: the visit's
 * estimate had its task layout on the builder; the saved copy and the duplicate had plain rows.
 * Two rebuilds of the builder's save path were parked ([[two-doors-one-thing]]). The verdict: ONE
 * editor on the invoice editor's model (billing/[id]/invoice-detail.tsx) — every write inside one
 * transition, one write in flight at a time, the controls disabled while it runs, and no copy of
 * the document in the browser beyond the field being typed.
 *
 * This module is that model, written so a test can DRIVE it with no DOM: createQuoteSession is a
 * small store with the writes injected; the React hook (useQuoteSession) only subscribes to it.
 *
 *   · ONE write in flight (`pending` names its slot). A commit asked for while one runs is NOT
 *     refused and NOT dropped: it is queued, said on its row in words (STILL_SAVING, no Retry: there
 *     is nothing to retry), and sent the moment the wire is free — the catch-up (drain). The controls
 *     are disabled while a write runs, so the queue only ever fills from a race (Enter and a blur on
 *     the same beat, a pick that landed as the first save went out).
 *   · A refused write (ok:false) or a thrown one keeps the typed value on its row and shows the
 *     words beside it with Retry, which runs the SAME write again. A later edit of the same
 *     field replaces that retry. Nothing else waits behind a refusal. A write that answers nothing
 *     for twenty seconds reads as unreachable (the controls never stay disabled for a hung call).
 *   · WHAT WAS SENT IS WHAT IS MARKED SENT: the record of a write (committedHeader, committedLines)
 *     is taken inside the call, from the payload that actually went, never before the wire was
 *     checked — so a line added or a field committed while the first save was in flight is never
 *     marked saved; it is queued and goes after the landing.
 *   · BIRTH WITHOUT LITTER: an unsaved estimate renders its seed with no row. The first commit WITH
 *     SUBSTANCE — a named line, header text he typed, a customer or lead picked, or the mount when
 *     the seed carries real lines — calls saveQuote ONCE under an id the client chose
 *     (crypto.randomUUID), idempotent on the server; a refused first save leaves the editor unsaved
 *     with Retry under the SAME id. A toggle alone (the document kind, the paper format, a tax rate)
 *     on a cold estimate is held in the mirror and rides the first substantive save. Then the line
 *     ids are read back and every later write is per line or per field. A cold estimate nobody
 *     types into leaves no row. The hand-off to /quotes/<id> is the editor's (isQuiet says when).
 *   · A LINE ADDED LATER CARRIES ITS OWN ID (crypto.randomUUID, `newId`): the append is idempotent on
 *     the server, so a Retry after a lost answer lands on the same rows, never beside them. A delete
 *     the server answers "isn't on this estimate" is a delete that LANDED: the screen and the server
 *     agree the line is gone, and the row goes with one line said under the list.
 *   · NOTHING MOVES SILENTLY ON A SENT ESTIMATE: the rule pass re-prices "rule" labor rows only
 *     while the estimate is a draft; a sent estimate's chip says what the rule says now and the
 *     figure stands until he taps Use ….
 *   · A LINE WITH AN ID IS THE SERVER'S TO DELETE (cn-v1133, S1): an id means an append was attempted
 *     under it, and a lost answer or the clock cannot tell a row that landed from one that did not —
 *     so Remove asks the server, and "isn't on this estimate" lands as gone. Only a line never asked
 *     for (no id, not in the first save on the wire) is dropped here.
 *   · THE READ-BACK IS PROVED BY THE WORDS (S6): a row is a line's only when it says what the line
 *     says — the words that WENT (committedLines, taken when the first save was sent), so a line
 *     renamed while that save was out still finds its row and the rename then goes as its own write
 *     (skeptic #39, B3); a line no row vouches for keeps its words and a Retry that reads again.
 *   · THE PAGE'S FRESH PROPS WAIT (S2): a reseed is held while a write is on the wire or anything
 *     typed is uncommitted (isDirty), the latest one applied once the store is quiet — and never over
 *     what this store wrote since the last seed it took, which that seed may predate.
 */

export const COULD_NOT_REACH = "Couldn't reach the server — press Retry";
/** A commit asked for while another write was still on the wire: queued, not refused. Words only —
 *  there is nothing to retry, it goes next on its own. */
export const STILL_SAVING = "Still saving the last change — this goes next.";
/** A line with no description cannot be saved (the server refuses it by name); it waits here. */
export const NAME_THE_LINE = "Give this line a description to save it.";
export const READ_BACK_FAILED = "Saved, but couldn't read the lines back — press Retry before editing them.";
export const WAITING_READ_BACK = "This line is saved; its id is still being read back — press Retry above.";
/** deleteQuoteItem's zero-row answer (actions.ts): the line is not on the estimate — which, from the
 *  editor, means it is already gone. Treated as a delete that landed. */
export const LINE_GONE = "That line isn't on this estimate.";
export const LINE_WAS_GONE = "That line was already off the estimate.";
/** A write that answers nothing for this long reads as unreachable, with Retry. */
export const WRITE_TIMEOUT_MS = 20_000;

export type Answer = { ok?: boolean; error?: string | null } | null | undefined;

/** The answer that LANDED: the `ok: true` member when the action discriminates, else the whole answer. */
export type Landed<T> = [Extract<NonNullable<T>, { ok: true }>] extends [never] ? NonNullable<T> : Extract<NonNullable<T>, { ok: true }>;

/**
 * WHAT A WRITE'S ANSWER MEANS (the same rule as lib/save-words, with the value kept): landed, or
 * the words to show — the server's own, the caller's fallback when it gave none, and the one
 * unreachable line when the call itself threw OR answered nothing inside the clock. Nothing is
 * swallowed and nothing escapes into the error boundary.
 */
export async function settle<T extends Answer>(
  call: () => Promise<T>,
  fallback: string,
  timeoutMs: number = WRITE_TIMEOUT_MS,
): Promise<{ landed: true; value: Landed<T> } | { landed: false; words: string }> {
  let res: T;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const clock = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    res = await Promise.race([call(), clock]);
  } catch {
    return { landed: false, words: COULD_NOT_REACH };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res?.ok) return { landed: true, value: res as unknown as Landed<T> };
  return { landed: false, words: res?.error || fallback };
}

/** The refusals, slot → words. null clears a slot; a word replaces what was there. */
export type Refusals = Readonly<Record<string, string>>;
export function withRefusal(prev: Refusals, slot: string, words: string | null): Refusals {
  if (words === null) {
    if (!(slot in prev)) return prev;
    const { [slot]: _gone, ...rest } = prev;
    return rest;
  }
  if (prev[slot] === words) return prev;
  return { ...prev, [slot]: words };
}

/* ── THE DOCUMENT AS THE EDITOR HOLDS IT ───────────────────────────────────────────────────── */

export interface EstimateHeader {
  /** "" = nobody. */
  customerId: string;
  /** The lead this estimate is for (quotes.inquiry_id); "" = none. Fixed once the row exists. */
  leadId: string;
  jobId: string | null;
  captureId: string | null;
  docType: QuoteDocType;
  /** The estimate's own paper format; null = the company's. */
  estimateFormat: EstimateFormat | null;
  title: string;
  description: string;
  notes: string;
  /** A fraction (0.0825). */
  taxRate: number;
  /** yyyy-mm-dd, or "". */
  validUntil: string;
}

export type HeaderField = keyof EstimateHeader;

/** One line as the editor holds it: the draft line, a stable key, and what the server knows of it. */
export interface EditorLine extends DraftLineItem {
  key: string;
  /** The row's id: the server's for a line it read or the first save wrote (null until the read-back);
   *  for a line added here, the id the editor chose at its append, which the row lands under. */
  id: string | null;
  /** The server holds this line (an id may still be on its way back after the first save). */
  saved: boolean;
}

export type Mode =
  | { kind: "unsaved"; clientId: string }
  | { kind: "saved"; id: string; number: string | null; status: string; /** Born on this screen (the page did not read the row). */ bornHere: boolean };

export interface SessionState {
  mode: Mode;
  header: EstimateHeader;
  items: readonly EditorLine[];
  /** The slot of the write on the wire; null = none. The controls are disabled while it is set. */
  pending: string | null;
  /** A refused write per slot, in words, each with a Retry. */
  refusals: Refusals;
  /** Words with no Retry: a line that cannot be written yet (no description; its id still on the
   *  way), a commit queued behind the write on the wire. */
  waiting: Readonly<Record<string, string>>;
  /** What the job's list did after a line changed (updateQuoteItem's said / note), per line key. */
  follow: Readonly<Record<string, { said?: string; note?: string }>>;
  /** What the job's list did after a line was removed (the line is gone, so this sits under the list). */
  said: string | null;
}

/** Nothing on the wire, nothing refused, nothing waiting or queued: the estimate on the screen is the
 *  estimate on the server. The editor hands a born-here estimate off to its own page at this moment. */
export const isQuiet = (s: SessionState): boolean => s.pending === null && Object.keys(s.refusals).length === 0 && Object.keys(s.waiting).length === 0;

/** Everything the session writes through. The editor hands in the server actions; a test hands in fakes. */
export interface SessionActions {
  saveQuote: (input: FirstSaveInput) => Promise<{ ok: true; id: string; quote_number?: string | null } | { ok: false; error?: string; code?: string }>;
  /** Each line under the id the client chose; idempotent on the server (B2). `said` / `note` are the
   *  job-followed words (what the job's list did with a kit added to an accepted, job-linked estimate),
   *  the same two updateQuoteItem answers with; both optional, so an append that followed nothing says nothing. */
  appendQuoteLines: (quoteId: string, lines: (DraftLineItem & { id: string })[]) => Promise<{ ok: true; ids: string[]; said?: string; note?: string } | { ok: false; error: string }>;
  updateQuoteItem: (itemId: string, quoteId: string, patch: LinePatch) => Promise<{ ok: boolean; error?: string; said?: string; note?: string }>;
  deleteQuoteItem: (itemId: string, quoteId: string) => Promise<{ ok: boolean; error?: string; said?: string; note?: string }>;
  updateQuoteMeta: (quoteId: string, meta: MetaPatch) => Promise<{ ok: boolean; error?: string }>;
  setQuoteCustomer: (quoteId: string, customerId: string | null) => Promise<{ ok: boolean; error?: string }>;
  setQuoteType: (quoteId: string, docType: QuoteDocType) => Promise<{ ok: boolean; error?: string }>;
  /** The lean read after birth: the ids of the lines the first save wrote, and where each sits. */
  readQuoteLineIds: (quoteId: string) => Promise<{ ok: true; items: ReadBackLine[] } | { ok: false; error: string }>;
}

export interface FirstSaveInput {
  id: string;
  customer_id: string | null;
  job_id: string | null;
  inquiry_id: string | null;
  capture_appointment_id: string | null;
  title: string;
  description: string;
  notes: string;
  tax_rate: number;
  valid_until: string | null;
  doc_type: QuoteDocType;
  /** The estimate's own paper format, null for the company's — always sent: on a retry that takes
   *  the update path, null is the choice as it stands, not "untouched". */
  estimate_format: EstimateFormat | null;
  items: DraftLineItem[];
}

export interface LinePatch {
  description?: string;
  quantity?: number;
  unit?: string;
  unit_price?: number;
  detail?: TaskDetail | null;
  category?: string | null;
}

export interface MetaPatch {
  title?: string;
  description?: string;
  notes?: string;
  tax_rate?: number;
  valid_until?: string | null;
  estimate_format?: EstimateFormat | null;
}

/** What readQuoteLineIds hands back per line: the id, where it sits, and what it says — the words are
 *  the proof a row is a line's (idsBySortOrder); a row with none matches nothing. */
export interface ReadBackLine {
  id: string;
  sort_order?: number | null;
  description?: string | null;
}

/* ── PURE RULES ────────────────────────────────────────────────────────────────────────────── */

/** A line with words on it. Blank lines are the builder's scratch space and never reach the server. */
export const named = (l: Pick<DraftLineItem, "description">): boolean => l.description.trim().length > 0;

/** A nameless line somebody has started on: a figure, a count, hours or a part. The blank starter
 *  row (1 ea at $0, nothing behind it) is not. */
export function hasSubstance(l: DraftLineItem): boolean {
  if (l.unit_price !== 0 || l.quantity !== 1) return true;
  const d = l.detail;
  if (!d) return false;
  return d.labor.some((r) => r.hours !== null) || d.materials.some((m) => m.name.trim().length > 0);
}

/** The header fields that count as substance when HE put them there (substantive). */
export type SubstanceField = "customerId" | "leadId" | "title" | "description" | "notes";
const NOTHING_PRESET: Pick<EstimateHeader, SubstanceField> = { customerId: "", leadId: "", title: "", description: "", notes: "" };

/**
 * WHAT MAKES A ROW WORTH HAVING (S2): a named line, header text he typed, or somebody HE picked. The
 * document kind, the paper format, a tax rate or a date on an otherwise empty estimate are
 * settings, not an estimate — held in the mirror until there is something to save them with.
 * ONLY WHAT HE DID HERE COUNTS: a customer or lead the door preselected (?customer=, ?inquiry=) is
 * the seed's, not his — without this a toggle of the document kind on a cold estimate opened from a
 * lead birthed a zero-line row and handed it off. The seed's own values ride the first save he earns.
 */
export function substantive(h: EstimateHeader, items: readonly DraftLineItem[], seed: Pick<EstimateHeader, SubstanceField> = NOTHING_PRESET): boolean {
  if (items.some(named)) return true;
  const typed = (f: "title" | "description" | "notes") => h[f].trim().length > 0 && h[f].trim() !== seed[f].trim();
  if (typed("title") || typed("description") || typed("notes")) return true;
  return (!!h.customerId && h.customerId !== seed.customerId) || (!!h.leadId && h.leadId !== seed.leadId);
}

/** The part of a line the server stores, in the shape saveQuote and appendQuoteLines take. */
export function lineForServer(l: DraftLineItem): DraftLineItem {
  return {
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unit_price: l.unit_price,
    ...(l.group ? { group: l.group } : {}),
    ...(l.detail ? { detail: l.detail } : {}),
  };
}

/** Two lines say the same thing to the server (the flag is build-time only and never compared). */
export function sameLine(a: DraftLineItem, b: DraftLineItem): boolean {
  return JSON.stringify(lineForServer(a)) === JSON.stringify(lineForServer(b));
}

/** The patch a changed line writes: the whole line as it stands, so the row and the screen agree. */
export function linePatch(l: DraftLineItem): LinePatch {
  return {
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unit_price: l.unit_price,
    category: l.group ?? null,
    ...(l.detail ? { detail: coerceTaskDetail(l.detail) } : {}),
  };
}

/** The first save's payload: the header as typed and every NAMED line, under the client's id. */
export function firstSavePayload(clientId: string, header: EstimateHeader, items: readonly DraftLineItem[]): FirstSaveInput {
  return {
    id: clientId,
    customer_id: header.customerId || null,
    job_id: header.jobId || null,
    inquiry_id: header.leadId || null,
    capture_appointment_id: header.captureId || null,
    title: header.title,
    description: header.description,
    notes: header.notes,
    tax_rate: header.taxRate,
    valid_until: header.validUntil || null,
    doc_type: header.docType,
    estimate_format: header.estimateFormat,
    items: items.filter(named).map(lineForServer),
  };
}

/** The seed carries real lines (a visit's tasks, a lead's configurator lines): the row is made at
 *  mount, so the Estimates list has it even if he leaves. An empty seed waits for the first commit. */
export function savesAtMount(items: readonly DraftLineItem[]): boolean {
  return items.some(named);
}

/** The header's write for one field on a SAVED estimate: the action and its argument, or null when
 *  that field has no door once the row exists (the lead is provenance, fixed by the first save). */
export function headerWrite(field: HeaderField, h: EstimateHeader): { kind: "meta"; meta: MetaPatch } | { kind: "customer"; customerId: string | null } | { kind: "type"; docType: QuoteDocType } | null {
  switch (field) {
    case "title":
      return { kind: "meta", meta: { title: h.title } };
    case "description":
      return { kind: "meta", meta: { description: h.description } };
    case "notes":
      return { kind: "meta", meta: { notes: h.notes } };
    case "taxRate":
      return { kind: "meta", meta: { tax_rate: h.taxRate } };
    case "validUntil":
      return { kind: "meta", meta: { valid_until: h.validUntil || null } };
    case "estimateFormat":
      return { kind: "meta", meta: { estimate_format: h.estimateFormat } };
    case "customerId":
      return { kind: "customer", customerId: h.customerId || null };
    case "docType":
      return { kind: "type", docType: h.docType };
    default:
      return null;
  }
}

/**
 * THE RULE PASS, GATED ON THE STATUS (rule 5 of the wave): on a draft (saved or not yet), every task
 * line whose breakdown still explains its price takes the rule's answer (repriceRows); on a sent,
 * accepted or superseded estimate NOTHING moves — the chip says "quoted at $X/h · the rule says
 * $Y/h now" and the figure stands until he taps Use …. Returns the lines as they should read.
 */
export function repricedLines<T extends DraftLineItem>(items: readonly T[], status: string, now: RuleInputs, prevRate: number): T[] {
  if (status !== "draft") return items.slice();
  return items.map((l) => (l.detail && detailExplains(l.detail, l) ? (repriceRows(l, now, prevRate) as T) : l));
}

/** Which of `next` differ from `prev` in what the server would store (by position). */
export function changedLines<T extends DraftLineItem>(prev: readonly T[], next: readonly T[]): T[] {
  return next.filter((l, i) => !prev[i] || !sameLine(prev[i], l));
}

/** The lines read back after the first save, matched onto the lines THAT SAVE WROTE (saved, no id
 *  yet). A row is a line's only when it SAYS what the line says (description, trimmed): the words are
 *  the proof. Among the rows that say it, the one at the line's place wins — saveQuote writes
 *  sort_order = the named line's index — else the earliest still unused, so two lines with the same
 *  words keep their order. Position alone used to pair them, and an extra row ahead of a line, or one
 *  tied with it, handed the line another row's id: its next edit then overwrote a row that said
 *  something else. A row whose id the mirror already knows (a line appended under its own id
 *  meanwhile) is not matched onto anything. A line no row vouches for keeps no id — readBack says so.
 *  THE WORDS COMPARED ARE THE WORDS THAT WENT (`sent`, skeptic #39, B3): the server holds what the
 *  first save carried, and a line renamed or cleared while that save was out would otherwise never
 *  match — READ_BACK_FAILED for good, its queued edit never written, no hand-off. The current words
 *  stand in only for a line with no record of what went. */
export function idsBySortOrder(items: readonly EditorLine[], read: readonly ReadBackLine[], sent?: (key: string) => string | undefined): EditorLine[] {
  const known = new Set(items.map((l) => l.id).filter((id): id is string => !!id));
  const pool = read
    .filter((r) => !known.has(r.id))
    .map((r, i) => ({ id: r.id, at: typeof r.sort_order === "number" ? r.sort_order : i, says: (r.description ?? "").trim(), used: false }))
    .sort((a, b) => a.at - b.at);
  let place = 0;
  return items.map((l) => {
    if (!l.saved || l.id) return l;
    const at = place++;
    const says = (sent?.(l.key) ?? l.description).trim();
    const row = pool.find((r) => !r.used && r.says === says && r.at === at) ?? pool.find((r) => !r.used && r.says === says);
    if (!row) return l;
    row.used = true;
    return { ...l, id: row.id };
  });
}

/* ── THE SESSION ───────────────────────────────────────────────────────────────────────────── */

export interface SessionInit {
  mode: Mode;
  header: EstimateHeader;
  /** The lines; a saved page's carry their ids. */
  items: readonly (DraftLineItem & { id?: string | null })[];
  actions: SessionActions;
  /** A key for a new line (tests hand in a counter). */
  newKey?: () => string;
  /** The id a line added here is appended under (crypto.randomUUID; tests hand in a counter). */
  newId?: () => string;
  /** The write clock (WRITE_TIMEOUT_MS; a test shortens it under fake timers). */
  timeoutMs?: number;
}

export interface SavedReseed {
  header: Partial<EstimateHeader>;
  items: readonly (DraftLineItem & { id: string })[];
  status: string;
  number: string | null;
}

export interface QuoteSession {
  get: () => SessionState;
  subscribe: (fn: () => void) => () => void;
  /** The mirror of a header field as it is typed; no write. */
  typeHeader: (patch: Partial<EstimateHeader>) => void;
  /** Commit one header field (blur, Enter, a pick): the first save, or that field's own write. */
  commitHeader: (field: HeaderField) => Promise<boolean>;
  /** The mirror of a line as it is typed; no write. */
  typeLine: (key: string, patch: Partial<DraftLineItem>) => void;
  /** Commit a line as it stands (or as `next` says): the first save, an append, or its own write. */
  commitLine: (key: string, next?: DraftLineItem) => Promise<boolean>;
  /** A new line on the estimate. It is written when it has a description (commitLine), never blank. */
  addLine: (line: DraftLineItem) => string;
  /** Lines that arrive priced (a kit, accepted proposals, a generator): on the estimate at once, and
   *  written at once — the first save, or ONE append that keeps each line's group and detail. */
  addLines: (lines: DraftLineItem[]) => Promise<boolean>;
  /** Remove a line: its own delete on the server when it has one; a never-saved line just goes. */
  removeLine: (key: string) => Promise<boolean>;
  /** The rule pass (repricedLines) applied: the mirror on an unsaved draft; one write per changed
   *  line on a saved draft, inside one pending, stopping at the first refusal. */
  reprice: (now: RuleInputs, prevRate: number) => Promise<boolean>;
  /** The unsaved editor's mount: the first save at once when the seed carries real lines. */
  mount: () => Promise<boolean>;
  /** Run the refused write of a slot again. */
  retry: (slot: string) => Promise<boolean>;
  /** The saved page read the row again (another door refreshed it): take what landed, keep what
   *  is refused or still unsaved here. HELD while a write is on the wire or anything typed is not yet
   *  committed (isDirty) — the latest seed is remembered and applied once the store goes quiet. */
  reseed: (saved: SavedReseed) => void;
  /** Something typed here is not what the server was last asked to hold: a line or a header field
   *  whose typed value differs from its committed one, or a named line not yet on the server. */
  isDirty: () => boolean;
  /** Clear the "what the job's list did" words. */
  clearSaid: () => void;
}

const headerOf = (h: EstimateHeader): EstimateHeader => ({ ...h });
const randomId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function createQuoteSession(init: SessionInit): QuoteSession {
  let keyN = 0;
  const newKey = init.newKey ?? (() => `k${++keyN}`);
  const newId = init.newId ?? randomId;
  const timeoutMs = init.timeoutMs ?? WRITE_TIMEOUT_MS;
  let state: SessionState = {
    mode: init.mode,
    header: headerOf(init.header),
    items: init.items.map((l) => ({ ...l, key: newKey(), id: l.id ?? null, saved: !!l.id })),
    pending: null,
    refusals: {},
    waiting: {},
    follow: {},
    said: null,
  };
  // WHAT THE SERVER HOLDS (or was last asked to hold): the header and each line as last SENT, taken
  // inside the call from the payload that went, so a blur that changed nothing writes nothing, and a
  // refused write is not sent twice by a second blur — only by Retry or by a later edit.
  let committedHeader: EstimateHeader = headerOf(init.header);
  const committedLines = new Map<string, DraftLineItem>();
  for (const l of state.items) if (l.saved) committedLines.set(l.key, lineForServer(l));
  // THE HEADER AS THE DOOR SEEDED IT: what substantive measures his own typing and picks against, so
  // a preselected customer or lead never earns a row on its own.
  const seedHeader: EstimateHeader = headerOf(init.header);
  // THE LINES THE FIRST SAVE CARRIED, by key, read while it is on the wire: a line among them that is
  // removed before the landing is on the server by then, so its delete is queued for after (and the
  // read-back matches ids by place and words, which a dropped row would shift). A line an append
  // carried needs no such set: it carries its own id from the first attempt, and an id IS the mark
  // that the server may hold it.
  let firstSaveSent: Set<string> | null = null;
  // EACH APPEND'S LINES, by slot: a refused append whose lines have all since been removed (each
  // through its own delete) has nothing left to retry, so its words and its Retry go with the last.
  const appendSlots = new Map<string, string[]>();
  // THE SEED THAT ARRIVED WHILE THE STORE WAS BUSY OR DIRTY (reseed): remembered, applied once quiet.
  let latestSeed: SavedReseed | null = null;
  // WHAT THIS STORE WROTE SINCE THE LAST SEED IT TOOK — each line and header field that landed, each
  // line deleted (by id). Next commits an action's props after the action resolved, by which time the
  // next write may already have landed, so the seed in hand can predate what is on the screen: it does
  // not overwrite those (the write's own refresh follows and agrees), does not drop a line appended
  // since, and does not bring back a line removed since.
  const written = { lines: new Set<string>(), header: new Set<HeaderField>(), gone: new Set<string>() };
  // THE QUEUE: what was committed while the wire was busy, in the order it was asked for. Drained
  // after every landing or refusal. A line waiting for its id stays until the read-back lands.
  const queued = { header: new Set<HeaderField>(), lines: new Set<string>(), deletes: new Set<string>() };
  const retries = new Map<string, () => Promise<boolean>>();
  const subs = new Set<() => void>();
  const set = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    subs.forEach((f) => f());
  };
  const line = (key: string): EditorLine | undefined => state.items.find((l) => l.key === key);
  const patchLine = (key: string, patch: Partial<EditorLine>) => set({ items: state.items.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const wait = (slot: string, words: string | null) => {
    if (words === null) {
      if (!(slot in state.waiting)) return;
      const { [slot]: _gone, ...rest } = state.waiting;
      set({ waiting: rest });
    } else if (state.waiting[slot] !== words) set({ waiting: { ...state.waiting, [slot]: words } });
  };
  const savedId = (): string | null => (state.mode.kind === "saved" ? state.mode.id : null);
  const busy = (): boolean => state.pending !== null;

  /** ONE WRITE ON THE WIRE. The slot's retry is this same write; a refusal keeps it, a landing drops
   *  it. Callers check `busy()` first and queue; this never races itself. After either outcome the
   *  queue is drained. */
  async function run<T extends Answer>(slot: string, call: () => Promise<T>, fallback: string, onOk: (v: Landed<T>) => void | Promise<void>): Promise<boolean> {
    retries.set(slot, () => run(slot, call, fallback, onOk));
    set({ pending: slot, refusals: withRefusal(state.refusals, slot, null) });
    const r = await settle(call, fallback, timeoutMs);
    if (!r.landed) {
      set({ pending: null, refusals: withRefusal(state.refusals, slot, r.words) });
      await drain();
      settleSeed();
      return false;
    }
    // Landed: the wire is free BEFORE the follow-up runs (the first save's read-back is a write's
    // worth of pending of its own).
    retries.delete(slot);
    set({ pending: null, refusals: withRefusal(state.refusals, slot, null) });
    await onOk(r.value);
    await drain();
    settleSeed();
    return true;
  }

  /** THE FIRST SAVE: the whole document under the client's id, once; then the ids. The payload and
   *  the record of what went are both read when the call goes, so Retry after a refusal sends the
   *  estimate as it stands and nothing committed during the flight is marked sent. Held (nothing
   *  sent, true) while the estimate has no substance yet. */
  async function firstSave(): Promise<boolean> {
    if (state.mode.kind !== "unsaved") return true;
    if (busy()) return false;
    if (!substantive(state.header, state.items, seedHeader)) return true;
    const clientId = state.mode.clientId;
    return run(
      "first-save",
      () => {
        const payload = firstSavePayload(clientId, state.header, state.items);
        committedHeader = headerOf(state.header);
        const sent = state.items.filter(named);
        for (const l of sent) committedLines.set(l.key, lineForServer(l));
        firstSaveSent = new Set(sent.map((l) => l.key));
        return init.actions.saveQuote(payload);
      },
      "Couldn't save the estimate.",
      async (res) => {
        const sent = firstSaveSent ?? new Set<string>();
        firstSaveSent = null;
        set({
          mode: { kind: "saved", id: res.id, number: res.quote_number ?? null, status: "draft", bornHere: true },
          items: state.items.map((l) => (sent.has(l.key) ? { ...l, saved: true } : l)),
        });
        await readBack(res.id);
      },
    );
  }

  /** The ids of the lines the first save wrote, so each can be written on its own from here. */
  async function readBack(id: string): Promise<boolean> {
    if (!state.items.some((l) => l.saved && !l.id)) return true;
    // The read's own refusal is a detail; what he needs to know is that the row IS saved and what to
    // press before editing a line. A throw still reads as the one unreachable line. A read that
    // LANDED but vouched for fewer lines than the save wrote (a row short, a row that says something
    // else at a line's place) is the same answer: the lines it did vouch for take their ids now, and
    // the rest keep their words — with the Retry, which reads again. Without that a line left id-less
    // after a landed read said "press Retry above" over a slot that had no Retry.
    const read = async () => {
      const r = await init.actions.readQuoteLineIds(id);
      if (!r.ok) return { ok: false as const, error: READ_BACK_FAILED };
      // Matched by the words the first save SENT (the record taken at send), never the words typed since.
      const items = idsBySortOrder(state.items, r.items, (key) => committedLines.get(key)?.description);
      const idless = new Set(items.filter((l) => l.saved && !l.id).map((l) => `line:${l.key}`));
      const waiting = Object.fromEntries(Object.entries(state.waiting).filter(([slot, w]) => w !== WAITING_READ_BACK || idless.has(slot)));
      set({ items, waiting });
      // A line edited or removed while its id was on the way is queued; the drain writes it now.
      return idless.size ? { ok: false as const, error: READ_BACK_FAILED } : { ok: true as const };
    };
    return run("read-back", read, READ_BACK_FAILED, () => {});
  }

  /** ONE deed, one pending: each named line in turn; the first refusal stops the pass and names the
   *  line, and Retry carries on from the lines still unwritten. */
  function writeKeys(slot: string, keys: string[]): Promise<boolean> {
    const id = savedId();
    if (!id) return Promise.resolve(true);
    return run(
      slot,
      async () => {
        for (const key of keys) {
          const l = line(key);
          if (!l || !l.saved || !l.id) continue;
          const was = committedLines.get(key);
          if (was && sameLine(was, l)) continue;
          const res = await init.actions.updateQuoteItem(l.id, id, linePatch(l));
          if (!res.ok) return { ok: false, error: `${l.description || "A line"}: ${res.error ?? "couldn't be saved."}` };
          // Recorded per line as it lands, so Retry carries on from the line that was refused.
          committedLines.set(key, lineForServer(l));
          written.lines.add(key);
        }
        return { ok: true };
      },
      "Couldn't save the lines.",
      () => {},
    );
  }

  /** ONE append for a set of lines added here, each under its own id — chosen HERE, at the first
   *  attempt (a line that rides the first save instead takes the server's id from the read-back, so
   *  no line carries one until an append needs it). The retry appends only what is STILL unsaved of
   *  the set: a line he has since edited went through its own write and must not land twice; a line
   *  whose first attempt landed with its answer lost lands on the same row under the same id. */
  function appendKeys(keys: string[]): Promise<boolean> {
    const id = savedId();
    if (!id) return Promise.resolve(true);
    const slot = `append:${keys[0]}`;
    appendSlots.set(slot, keys);
    const still = () => state.items.filter((l) => keys.includes(l.key) && !l.saved && named(l));
    return run(
      slot,
      () => {
        if (still().some((l) => !l.id)) set({ items: state.items.map((l) => (keys.includes(l.key) && !l.saved && !l.id ? { ...l, id: newId() } : l)) });
        const lines = still();
        for (const l of lines) committedLines.set(l.key, lineForServer(l));
        return init.actions.appendQuoteLines(id, lines.map((l) => ({ ...lineForServer(l), id: l.id as string })));
      },
      "Couldn't add those lines.",
      (res) => {
        const landed = new Set(still().map((l) => l.key));
        // What the job's list did with the lines (a kit added to an accepted, job-linked estimate):
        // the note rides each line it was about, the said sits under the list — as a line's own write
        // and a delete land theirs.
        const follow = { ...state.follow };
        if (res.note) for (const key of landed) follow[key] = { ...follow[key], note: res.note };
        for (const key of landed) written.lines.add(key);
        set({ items: state.items.map((l) => (landed.has(l.key) ? { ...l, saved: true } : l)), follow, said: res.said ?? null });
        appendSlots.delete(slot);
        sweepAppends(); // a widened set may have landed another slot's last line too
      },
    );
  }

  /** A LINE OF A REFUSED APPEND GOES WITH ITS SET (skeptic #39, B4). A slot is named by its first key,
   *  so one line of a refused [A, B] committed alone re-ran the same slot with A only: the refusal
   *  cleared, A landed, and B sat unsaved with its id, no words and no Retry — on the screen, nowhere
   *  on the server. Every key is widened to its slot's keys, in the slot's order (so the slot name is
   *  the same and its refusal is the one replaced); appendKeys sends what is still unsaved of them. */
  function appendSet(keys: string[]): string[] {
    const out: string[] = [];
    for (const k of keys) {
      const slot = [...appendSlots.values()].find((ks) => ks.includes(k));
      for (const x of slot ?? [k]) if (!out.includes(x)) out.push(x);
    }
    return out;
  }

  /** A refused append whose lines have all gone (each through its own delete, or a never-attempted
   *  one dropped) or have all since landed has nothing to send again: its words and its Retry go. */
  function sweepAppends() {
    let refusals = state.refusals;
    for (const [slot, keys] of appendSlots) {
      if (state.items.some((l) => keys.includes(l.key) && !l.saved)) continue;
      appendSlots.delete(slot);
      retries.delete(slot);
      refusals = withRefusal(refusals, slot, null);
    }
    if (refusals !== state.refusals) set({ refusals });
  }

  /** The delete of one saved line. "Isn't on this estimate" is a delete that landed (the screen and
   *  the server agree the line is gone): the row goes and one line says so under the list. */
  function deleteKey(key: string): Promise<boolean> {
    const l = line(key);
    const id = savedId();
    if (!l || !id || !l.id) return Promise.resolve(true);
    const itemId = l.id;
    return run(
      `delete:${key}`,
      async () => {
        const r = await init.actions.deleteQuoteItem(itemId, id);
        return !r.ok && r.error === LINE_GONE ? { ok: true, said: LINE_WAS_GONE } : r;
      },
      "Couldn't remove the line.",
      (res) => {
        committedLines.delete(key);
        written.gone.add(itemId);
        set({
          items: state.items.filter((x) => x.key !== key),
          refusals: withRefusal(state.refusals, `line:${key}`, null),
          said: res.said ?? (res.note ?? null),
        });
        wait(`line:${key}`, null);
        sweepAppends();
      },
    );
  }

  /** The write of one line on a SAVED estimate, the wire free: its append (own id) or its own update. */
  async function writeSavedLine(l: EditorLine): Promise<boolean> {
    const id = savedId() as string;
    const slot = `line:${l.key}`;
    wait(slot, null);
    if (!l.saved) return appendKeys(appendSet([l.key]));
    if (!l.id) {
      // Saved by the first save, its id still on the way back: the typed figure waits on the row
      // (not marked sent) and goes once the read-back lands.
      queued.lines.add(l.key);
      wait(slot, WAITING_READ_BACK);
      return false;
    }
    const itemId = l.id;
    return run(
      slot,
      () => {
        committedLines.set(l.key, lineForServer(l));
        return init.actions.updateQuoteItem(itemId, id, linePatch(l));
      },
      "Couldn't save the line.",
      (res) => {
        const words = { ...(res.said ? { said: res.said } : {}), ...(res.note ? { note: res.note } : {}) };
        written.lines.add(l.key);
        set({ follow: { ...state.follow, [l.key]: words } });
      },
    );
  }

  /** The write of one header field on a SAVED estimate, the wire free; the record is taken at send. */
  function writeHeaderField(field: HeaderField): Promise<boolean> {
    const id = savedId() as string;
    const w = headerWrite(field, state.header);
    wait(`header:${field}`, null);
    if (!w) return Promise.resolve(true);
    const slot = `header:${field}`;
    const send = <T extends Answer>(call: () => Promise<T>, fallback: string) =>
      run(
        slot,
        () => {
          committedHeader = { ...committedHeader, [field]: state.header[field] };
          return call();
        },
        fallback,
        () => {
          written.header.add(field);
        },
      );
    if (w.kind === "meta") return send(() => init.actions.updateQuoteMeta(id, w.meta), "Couldn't save that.");
    if (w.kind === "customer") return send(() => init.actions.setQuoteCustomer(id, w.customerId), "Couldn't change the customer.");
    return send(() => init.actions.setQuoteType(id, w.docType), "Couldn't change the type.");
  }

  /** A line the server was never asked for (no id: no append attempted, not in the first save) just goes. */
  const dropLocal = (key: string) => {
    committedLines.delete(key);
    queued.lines.delete(key);
    queued.deletes.delete(key);
    set({ items: state.items.filter((x) => x.key !== key), refusals: withRefusal(withRefusal(state.refusals, `line:${key}`, null), `delete:${key}`, null) });
    wait(`line:${key}`, null);
    sweepAppends();
  };

  /**
   * THE CATCH-UP: what was committed while the wire was busy goes now, one write at a time, in the
   * order it can go — the lines added here (one append), each changed line, each header field, each
   * delete. A line whose id is still on the way stays queued with its words until the read-back
   * lands. On an estimate not yet saved everything queued rides ONE first save, which reads the
   * estimate as it stands. Never re-entered: a landing inside the drain does not start a second.
   */
  let draining = false;
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!busy()) {
        const step = nextStep();
        if (!step) break;
        await step();
      }
    } finally {
      draining = false;
    }
  }

  function nextStep(): (() => Promise<boolean>) | null {
    if (!queued.header.size && !queued.lines.size && !queued.deletes.size) return null;
    if (!savedId()) {
      // Nothing is on the server: a queued delete is a local one, and the rest is the first save.
      for (const k of queued.deletes) dropLocal(k);
      queued.deletes.clear();
      for (const k of queued.lines) wait(`line:${k}`, null);
      for (const f of queued.header) wait(`header:${f}`, null);
      queued.lines.clear();
      queued.header.clear();
      return () => firstSave();
    }
    // Lines added here, still unsaved: one append for all of them.
    const fresh: string[] = [];
    for (const k of queued.lines) {
      const l = line(k);
      if (!l) {
        queued.lines.delete(k);
        continue;
      }
      if (!named(l)) {
        queued.lines.delete(k);
        wait(`line:${k}`, hasSubstance(l) ? NAME_THE_LINE : null);
        continue;
      }
      if (!l.saved) fresh.push(k);
    }
    if (fresh.length) {
      for (const k of fresh) {
        queued.lines.delete(k);
        wait(`line:${k}`, null);
      }
      return () => appendKeys(appendSet(fresh));
    }
    for (const k of queued.lines) {
      const l = line(k) as EditorLine;
      if (!l.id) {
        wait(`line:${k}`, WAITING_READ_BACK);
        continue;
      }
      queued.lines.delete(k);
      const was = committedLines.get(k);
      if (was && sameLine(was, l)) {
        wait(`line:${k}`, null);
        continue;
      }
      return () => writeSavedLine(l);
    }
    for (const f of queued.header) {
      queued.header.delete(f);
      if (state.header[f] === committedHeader[f]) {
        wait(`header:${f}`, null);
        continue;
      }
      return () => writeHeaderField(f);
    }
    for (const k of queued.deletes) {
      const l = line(k);
      if (!l) {
        queued.deletes.delete(k);
        continue;
      }
      // Never attempted (no id, not marked saved): a local drop. A line WITH an id had an append
      // attempted under it — its answer may have been lost — so it is deleted on the server like any
      // saved line (S1): "isn't on this estimate" lands, a ghost row never does.
      if (!l.saved && !l.id) {
        dropLocal(k);
        continue;
      }
      if (!l.id) {
        wait(`line:${k}`, WAITING_READ_BACK);
        continue;
      }
      queued.deletes.delete(k);
      return () => deleteKey(k);
    }
    return null;
  }

  /** Something typed here is not what the server was last asked to hold. A refused write is NOT
   *  dirty (its record was taken at send; only Retry or a later edit sends it again); a header field
   *  with no door once the row exists (the lead) is not either. */
  function isDirty(): boolean {
    for (const f of Object.keys(state.header) as HeaderField[]) {
      if (state.header[f] === committedHeader[f]) continue;
      if (state.mode.kind === "saved" && !headerWrite(f, state.header)) continue;
      return true;
    }
    for (const l of state.items) {
      const was = committedLines.get(l.key);
      if (was ? !sameLine(was, l) : named(l)) return true;
    }
    return false;
  }

  /** The remembered seed, applied the moment the store is quiet — the tail of every write, after its
   *  catch-up; inside a drain it waits for the drain's end. */
  function settleSeed() {
    if (!latestSeed || draining || busy() || isDirty()) return;
    const s = latestSeed;
    latestSeed = null;
    applyReseed(s);
  }

  /** The seed taken: a server line replaces the mirror's by id unless the mirror's is refused (his
   *  typed figure stands with its Retry) or was written here since the last seed (the seed may predate
   *  that write); a line the server has that the mirror lacks joins, unless it was removed here since;
   *  a line still unsaved here stays at the end. The record of what was written since is then cleared. */
  function applyReseed(saved: SavedReseed) {
    const byId = new Map(saved.items.map((l) => [l.id, l]));
    const seen = new Set<string>();
    const matched: EditorLine[] = [];
    const local: EditorLine[] = [];
    for (const l of state.items) {
      if (l.saved && written.lines.has(l.key)) {
        if (l.id) seen.add(l.id);
        matched.push(l);
      } else if (l.saved && l.id && byId.has(l.id)) {
        seen.add(l.id);
        const refused = `line:${l.key}` in state.refusals || `delete:${l.key}` in state.refusals || queued.lines.has(l.key) || queued.deletes.has(l.key);
        const fresh = byId.get(l.id)!;
        if (!refused) committedLines.set(l.key, lineForServer(fresh));
        matched.push(refused ? l : { ...fresh, key: l.key, saved: true });
      } else if (!l.saved) local.push(l);
    }
    const extra: EditorLine[] = [];
    for (const fresh of saved.items) {
      if (seen.has(fresh.id) || written.gone.has(fresh.id)) continue;
      const key = newKey();
      committedLines.set(key, lineForServer(fresh));
      extra.push({ ...fresh, key, saved: true });
    }
    const kept = [...matched, ...extra, ...local];
    const header: EstimateHeader = { ...state.header };
    for (const k of Object.keys(saved.header) as HeaderField[]) {
      if (`header:${k}` in state.refusals || queued.header.has(k) || written.header.has(k)) continue;
      const v = saved.header[k];
      if (v === undefined) continue;
      (header as unknown as Record<string, unknown>)[k] = v;
      (committedHeader as unknown as Record<string, unknown>)[k] = v;
    }
    written.lines.clear();
    written.header.clear();
    written.gone.clear();
    const mode: Mode = state.mode.kind === "saved" ? { ...state.mode, status: saved.status, number: saved.number } : state.mode;
    set({ items: kept, header, mode });
  }

  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    typeHeader(patch) {
      set({ header: { ...state.header, ...patch } });
    },
    async commitHeader(field) {
      if (state.header[field] === committedHeader[field]) return true;
      if (busy()) {
        queued.header.add(field);
        wait(`header:${field}`, STILL_SAVING);
        return false;
      }
      if (!savedId()) return firstSave();
      return writeHeaderField(field);
    },
    typeLine(key, patch) {
      patchLine(key, patch);
    },
    async commitLine(key, next) {
      if (next) patchLine(key, next);
      const l = line(key);
      if (!l) return false;
      // Nothing changed since it was last sent: nothing to send. A refused write is run again by
      // Retry or by a later edit, never by a second blur on the same figure.
      const was = committedLines.get(key);
      if (was && sameLine(was, l)) return true;
      const slot = `line:${key}`;
      if (!named(l)) {
        // A blank row he just added and left says nothing; a row with a figure on it and no words is
        // asked for them, because without them the server will not take it.
        wait(slot, hasSubstance(l) ? NAME_THE_LINE : null);
        return false;
      }
      if (busy()) {
        queued.lines.add(key);
        wait(slot, STILL_SAVING);
        return false;
      }
      if (!savedId()) {
        wait(slot, null);
        return firstSave();
      }
      return writeSavedLine(l);
    },
    addLine(l) {
      const key = newKey();
      set({ items: [...state.items, { ...l, key, id: null, saved: false }] });
      return key;
    },
    async addLines(lines) {
      if (!lines.length) return true;
      const added = lines.map((l) => ({ ...l, key: newKey(), id: null, saved: false }));
      // The one append rule: priced lines join the real ones; a blank starter row (nothing on it)
      // does not sit above a kit. A nameless row he has started on stays, with its words.
      set({ items: [...state.items.filter((l) => named(l) || hasSubstance(l)), ...added] });
      if (busy()) {
        for (const a of added) {
          queued.lines.add(a.key);
          wait(`line:${a.key}`, STILL_SAVING);
        }
        return false;
      }
      if (!savedId()) return firstSave();
      return appendKeys(added.map((a) => a.key));
    },
    async removeLine(key) {
      const l = line(key);
      if (!l) return true;
      // THE SERVER MAY HOLD IT when it is marked saved, when it carries an id (an append was attempted
      // under that id — on the wire now, refused, or answered nothing inside the clock: the rows may
      // have landed with the answer lost), or when the first save on the wire carried it. Only a line
      // the server was never asked for is dropped here (S1): dropping one with an id left a ghost row
      // that came back at the next read.
      const onServer = l.saved || !!l.id || (state.pending === "first-save" && !!firstSaveSent?.has(key));
      if (!onServer) {
        dropLocal(key);
        return true;
      }
      if (busy()) {
        // A delete supersedes an edit of the same line queued behind the wire.
        queued.lines.delete(key);
        queued.deletes.add(key);
        wait(`line:${key}`, STILL_SAVING);
        return false;
      }
      if (!l.id) {
        queued.deletes.add(key);
        wait(`line:${key}`, WAITING_READ_BACK);
        return false;
      }
      return deleteKey(key);
    },
    async reprice(now, prevRate) {
      const status = state.mode.kind === "saved" ? state.mode.status : "draft";
      const next = repricedLines(state.items, status, now, prevRate);
      const changed = changedLines(state.items, next);
      if (!changed.length) return true;
      set({ items: next });
      if (!savedId()) return true; // the mirror is the draft until the first commit
      if (busy()) {
        for (const l of changed) {
          queued.lines.add(l.key);
          wait(`line:${l.key}`, STILL_SAVING);
        }
        return false;
      }
      // A saved line whose id is not back yet (the read-back refused) cannot be written now: queued
      // with its words, like a typed edit (writeSavedLine), so the read-back's Retry drains it. It
      // used to be skipped without a word — the mirror re-priced, nothing sent, nothing queued, and
      // Retry on the read-back sent nothing (S3). A line not on the server at all rides its own
      // commit or its append's Retry, which read the mirror as it stands.
      const ready: string[] = [];
      let held = false;
      for (const l of changed) {
        if (!l.saved) continue;
        if (l.id) ready.push(l.key);
        else {
          queued.lines.add(l.key);
          wait(`line:${l.key}`, WAITING_READ_BACK);
          held = true;
        }
      }
      if (!ready.length) return !held;
      const ok = await writeKeys("reprice", ready);
      return ok && !held;
    },
    mount() {
      if (state.mode.kind !== "unsaved" || !savesAtMount(state.items)) return Promise.resolve(true);
      if (busy()) return Promise.resolve(false); // the first save is on the wire (a second mount)
      return firstSave();
    },
    retry(slot) {
      if (busy()) return Promise.resolve(false);
      const again = retries.get(slot);
      return again ? again() : Promise.resolve(true);
    },
    reseed(saved) {
      // HELD WHILE A WRITE IS ON THE WIRE OR SOMETHING TYPED IS NOT YET COMMITTED (S2): Next's action
      // queue can run the next write before the previous action's props commit, so a chained write
      // (the reprice loop, a drain) met stale props that reverted the in-flight figure and replaced
      // what he was typing. The latest seed is remembered and applied once, when the store is quiet.
      if (busy() || isDirty()) {
        latestSeed = saved;
        return;
      }
      latestSeed = null;
      applyReseed(saved);
    },
    isDirty,
    clearSaid() {
      if (state.said !== null) set({ said: null });
    },
  };

}

/** The React side: one session per mount, read through useSyncExternalStore (server render included). */
export function useQuoteSession(make: () => QuoteSession): { session: QuoteSession; state: SessionState } {
  // One session for the life of the editor: `make` closes over the seed read at mount. useState's
  // initializer runs once and its identity is a guarantee (a memo's is a hint React may drop).
  const [session] = useState(make);
  const state = useSyncExternalStore(session.subscribe, session.get, session.get);
  return { session, state };
}
