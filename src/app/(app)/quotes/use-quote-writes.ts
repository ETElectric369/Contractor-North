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
  /** Each line under the id the client chose; idempotent on the server (B2). */
  appendQuoteLines: (quoteId: string, lines: (DraftLineItem & { id: string })[]) => Promise<{ ok: true; ids: string[] } | { ok: false; error: string }>;
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

/** What readQuoteLineIds hands back per line: the id, and where it sits. */
export interface ReadBackLine {
  id: string;
  sort_order?: number | null;
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

/**
 * WHAT MAKES A ROW WORTH HAVING (S2): a named line, header text he typed, or somebody picked. The
 * document kind, the paper format, a tax rate or a date on an otherwise empty estimate are
 * settings, not an estimate — held in the mirror until there is something to save them with.
 */
export function substantive(h: EstimateHeader, items: readonly DraftLineItem[]): boolean {
  if (items.some(named)) return true;
  if (h.title.trim() || h.description.trim() || h.notes.trim()) return true;
  return !!h.customerId || !!h.leadId;
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
 *  yet) by sort order — saveQuote writes sort_order = the named line's index. A row whose id the
 *  mirror already knows (a line appended under its own id meanwhile) is not matched onto anything.
 *  Unmatched lines keep no id. */
export function idsBySortOrder(items: readonly EditorLine[], read: readonly ReadBackLine[]): EditorLine[] {
  const known = new Set(items.map((l) => l.id).filter((id): id is string => !!id));
  const ordered = read
    .filter((r) => !known.has(r.id))
    .map((r, i) => ({ id: r.id, at: typeof r.sort_order === "number" ? r.sort_order : i }))
    .sort((a, b) => a.at - b.at);
  let n = 0;
  return items.map((l) => {
    if (!l.saved || l.id) return l;
    const got = ordered[n++];
    return got ? { ...l, id: got.id } : l;
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
   *  is refused or still unsaved here. */
  reseed: (saved: SavedReseed) => void;
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
  // THE LINES THE FIRST SAVE (or an append) CARRIED, by key, read while it is on the wire: a line among
  // them that is removed before the landing is on the server by then, so its delete is queued for after
  // (and the read-back matches ids by order, which a dropped row would shift).
  let firstSaveSent: Set<string> | null = null;
  let appendSent: Set<string> | null = null;
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
      return false;
    }
    // Landed: the wire is free BEFORE the follow-up runs (the first save's read-back is a write's
    // worth of pending of its own).
    retries.delete(slot);
    set({ pending: null, refusals: withRefusal(state.refusals, slot, null) });
    await onOk(r.value);
    await drain();
    return true;
  }

  /** THE FIRST SAVE: the whole document under the client's id, once; then the ids. The payload and
   *  the record of what went are both read when the call goes, so Retry after a refusal sends the
   *  estimate as it stands and nothing committed during the flight is marked sent. Held (nothing
   *  sent, true) while the estimate has no substance yet. */
  async function firstSave(): Promise<boolean> {
    if (state.mode.kind !== "unsaved") return true;
    if (busy()) return false;
    if (!substantive(state.header, state.items)) return true;
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
    // press before editing a line. A throw still reads as the one unreachable line.
    const read = async () => {
      const r = await init.actions.readQuoteLineIds(id);
      return r.ok ? r : { ok: false as const, error: READ_BACK_FAILED };
    };
    return run("read-back", read, READ_BACK_FAILED, (res) => {
      const items = idsBySortOrder(state.items, res.items);
      const waiting = Object.fromEntries(Object.entries(state.waiting).filter(([, w]) => w !== WAITING_READ_BACK));
      set({ items, waiting });
      // A line edited or removed while its id was on the way is queued; the drain writes it now.
    });
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
    const still = () => state.items.filter((l) => keys.includes(l.key) && !l.saved && named(l));
    return run(
      slot,
      () => {
        if (still().some((l) => !l.id)) set({ items: state.items.map((l) => (keys.includes(l.key) && !l.saved && !l.id ? { ...l, id: newId() } : l)) });
        const lines = still();
        for (const l of lines) committedLines.set(l.key, lineForServer(l));
        appendSent = new Set(lines.map((l) => l.key));
        return init.actions.appendQuoteLines(id, lines.map((l) => ({ ...lineForServer(l), id: l.id as string })));
      },
      "Couldn't add those lines.",
      () => {
        const landed = new Set(still().map((l) => l.key));
        set({ items: state.items.map((l) => (landed.has(l.key) ? { ...l, saved: true } : l)) });
      },
    );
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
        set({
          items: state.items.filter((x) => x.key !== key),
          refusals: withRefusal(state.refusals, `line:${key}`, null),
          said: res.said ?? (res.note ?? null),
        });
        wait(`line:${key}`, null);
      },
    );
  }

  /** The write of one line on a SAVED estimate, the wire free: its append (own id) or its own update. */
  async function writeSavedLine(l: EditorLine): Promise<boolean> {
    const id = savedId() as string;
    const slot = `line:${l.key}`;
    wait(slot, null);
    if (!l.saved) return appendKeys([l.key]);
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
        () => {},
      );
    if (w.kind === "meta") return send(() => init.actions.updateQuoteMeta(id, w.meta), "Couldn't save that.");
    if (w.kind === "customer") return send(() => init.actions.setQuoteCustomer(id, w.customerId), "Couldn't change the customer.");
    return send(() => init.actions.setQuoteType(id, w.docType), "Couldn't change the type.");
  }

  const dropLocal = (key: string) => {
    committedLines.delete(key);
    queued.lines.delete(key);
    queued.deletes.delete(key);
    set({ items: state.items.filter((x) => x.key !== key), refusals: withRefusal(withRefusal(state.refusals, `line:${key}`, null), `delete:${key}`, null) });
    wait(`line:${key}`, null);
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
      return () => appendKeys(fresh);
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
      if (!l.saved) {
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
      const onServer = l.saved || (state.pending === "first-save" && !!firstSaveSent?.has(key)) || (!!state.pending?.startsWith("append:") && !!appendSent?.has(key));
      if (!onServer) {
        dropLocal(key);
        return true;
      }
      if (busy()) {
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
      return writeKeys("reprice", changed.map((l) => l.key));
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
      // Lines: a server line replaces the mirror's by id unless the mirror's is refused (his typed
      // figure stands with its Retry); a line the server has that the mirror lacks joins; a line
      // still unsaved here stays at the end.
      const byId = new Map(saved.items.map((l) => [l.id, l]));
      const seen = new Set<string>();
      const matched: EditorLine[] = [];
      const local: EditorLine[] = [];
      for (const l of state.items) {
        if (l.saved && l.id && byId.has(l.id)) {
          seen.add(l.id);
          const refused = `line:${l.key}` in state.refusals || `delete:${l.key}` in state.refusals || queued.lines.has(l.key) || queued.deletes.has(l.key);
          const fresh = byId.get(l.id)!;
          if (!refused) committedLines.set(l.key, lineForServer(fresh));
          matched.push(refused ? l : { ...fresh, key: l.key, saved: true });
        } else if (!l.saved) local.push(l);
      }
      const extra: EditorLine[] = [];
      for (const fresh of saved.items) {
        if (seen.has(fresh.id)) continue;
        const key = newKey();
        committedLines.set(key, lineForServer(fresh));
        extra.push({ ...fresh, key, saved: true });
      }
      const kept = [...matched, ...extra, ...local];
      const header: EstimateHeader = { ...state.header };
      for (const k of Object.keys(saved.header) as HeaderField[]) {
        if (`header:${k}` in state.refusals || queued.header.has(k)) continue;
        const v = saved.header[k];
        if (v === undefined) continue;
        (header as unknown as Record<string, unknown>)[k] = v;
        (committedHeader as unknown as Record<string, unknown>)[k] = v;
      }
      const mode: Mode = state.mode.kind === "saved" ? { ...state.mode, status: saved.status, number: saved.number } : state.mode;
      set({ items: kept, header, mode });
    },
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
