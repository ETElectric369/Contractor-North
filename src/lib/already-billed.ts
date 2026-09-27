/**
 * ALREADY BILLED: THE RULES THE SHEET SUGGESTS FROM (pure; migration 0357 enforces the same).
 *
 * Erik, 2026-09-26: "i have a bill for purple sage that was already charged and i have no way to
 * associate it to the paid invoice becuase i did it manually and that will happen for people i
 * assure you". The Costs tab's Already Billed door asks "Which line already charged for this?" and a
 * person picks it. Everything here only decides what is OFFERED and what is ticked to start with:
 * the app suggests, a person decides, and mark_already_billed refuses anything these rules would not
 * have offered.
 *
 *   eligibleInvoice   which invoices can hold it: any status but draft or void, never a deposit
 *   sortInvoicesFor   the invoice written on or after the cost comes first (the one that most likely
 *                     charged it), then the older ones, newest first; the date only orders
 *   eligibleLines     which lines: a line typed by hand or one the office changed (an untouched
 *                     imported line is rewritten by the next import), never a credit, a contract or
 *                     a lump line, never $0; a charge goes on a line of work, a return on a line typed
 *                     by hand that takes money off; the matching kind first (materials for a receipt,
 *                     labor for hours)
 *   precheckHours     for hours: only the line's own person, only up to the day the invoice was
 *                     WRITTEN (created), never the day it was sent: INV-00023 went out 76 days after it
 *                     was written, and the sent date would have ticked 76 days of unbilled work; and
 *                     only as many as the line has room for beside the hours it already holds
 *   askUsedAll        Purple Sage's question, only when Shop Stock is on and the line is less than the
 *                     receipt's cost ($110 against $186.93): "Did J-010 Use All Of It?"
 */

import { lumpLineRule, isHoursUnit } from "@/lib/invoice-math";
import { countsAsWorkCompleted, lineGroup } from "@/lib/portal/line-kind";
import { formatCurrency } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";

export type AlreadyBilledKind = "bill" | "po" | "stock" | "time";

export type AbLine = {
  id: string;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  import_source: string | null;
  import_key: string | null;
  edited: boolean;
  line_kind: string | null;
  sort_order?: number | null;
  /** For hours: the hours of the job's shifts this line already holds (its claim, by import or by
   *  hand). A hand-bumped line is usually most of the way covered: only the rest is ticked. */
  heldHours?: number | null;
};

export type AbInvoice = {
  id: string;
  invoice_number: string | null;
  status: string;
  invoice_kind: string | null;
  job_id: string | null;
  created_at: string;
  lines: AbLine[];
};

const cents = (n: number) => Math.round(n * 100) / 100;

/** A draft is still open (Add To puts the cost there); a void bills nothing; a deposit bills a part
 *  of the job up front, never this cost. */
export function eligibleInvoice(inv: Pick<AbInvoice, "status" | "invoice_kind">): boolean {
  return inv.status !== "draft" && inv.status !== "void" && (inv.invoice_kind ?? "standard") !== "deposit";
}

/**
 * The invoices in the order to offer them: those written on or after the cost's own date first,
 * nearest first (the bill that went out after the purchase is the one most likely to have charged
 * for it), then the ones written before it, newest first. No date: newest first. Nothing is dropped
 * for its date: an invoice written before the receipt can still be the one that charged for it.
 */
export function sortInvoicesFor<T extends Pick<AbInvoice, "created_at">>(invoices: readonly T[], costDate: string | null | undefined): T[] {
  const day = (s: string) => String(s ?? "").slice(0, 10);
  const d = costDate ? day(costDate) : null;
  return [...invoices].sort((a, b) => {
    if (d) {
      const aAfter = day(a.created_at) >= d;
      const bAfter = day(b.created_at) >= d;
      if (aAfter !== bAfter) return aAfter ? -1 : 1;
      if (aAfter) return a.created_at.localeCompare(b.created_at);
    }
    return b.created_at.localeCompare(a.created_at);
  });
}

/** The group a cost of this kind reads as on an invoice: materials for a receipt, an order or a take. */
export function matchingGroup(kind: AlreadyBilledKind): "materials" | "labor" {
  return kind === "time" ? "labor" : "materials";
}

/**
 * The lines of one invoice that can hold it, the matching kind first. `negative`: the cost is a
 * supplier return (it takes money off), so only a line typed by hand that takes money off can.
 */
export function eligibleLines(inv: AbInvoice, target: { kind: AlreadyBilledKind; negative?: boolean }): AbLine[] {
  const isLump = lumpLineRule(inv.invoice_kind, inv.lines);
  const want = matchingGroup(target.kind);
  const ok = inv.lines.filter((l) => {
    const total = Number(l.line_total) || 0;
    if (l.import_source === "draw_credit" || isLump(l) || total === 0) return false;
    if (l.import_source != null && l.edited !== true) return false;
    if (target.negative) return total < 0 && l.import_source == null && lineGroup(l, inv.invoice_kind) !== "credit";
    return total > 0 && countsAsWorkCompleted(l, inv.invoice_kind);
  });
  const rank = (l: AbLine) => (lineGroup(l, inv.invoice_kind) === want ? 0 : 1);
  return ok.sort((a, b) => rank(a) - rank(b) || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
}

/** An invoice line as the database returns it, in the shape the rules read (numbers as numbers). */
export function abLineOf(l: any): AbLine {
  return {
    id: String(l?.id ?? ""),
    description: String(l?.description ?? ""),
    quantity: Number(l?.quantity) || 0,
    unit: l?.unit ?? null,
    unit_price: Number(l?.unit_price) || 0,
    line_total: Number(l?.line_total) || 0,
    import_source: l?.import_source ?? null,
    import_key: l?.import_key ?? null,
    edited: l?.edited === true,
    line_kind: l?.line_kind ?? null,
    sort_order: l?.sort_order ?? null,
  };
}

/**
 * CAN ANY BILL THAT WENT OUT HOLD IT? A charge needs a line of work typed or changed by hand; a
 * supplier return needs a line typed by hand that takes money off. The Costs tab shows a door only
 * where the sheet it opens has a line to pick (a door onto an empty sheet is a dead end).
 */
export function jobCanHold(invoices: readonly AbInvoice[]): { charge: boolean; ret: boolean } {
  const live = invoices.filter(eligibleInvoice);
  return {
    charge: live.some((i) => eligibleLines(i, { kind: "bill" }).length > 0),
    ret: live.some((i) => eligibleLines(i, { kind: "bill", negative: true }).length > 0),
  };
}

/**
 * WHERE THE SHEET CAN WORK FOR A JOB (the one rule behind every door that opens it: the Costs tab,
 * the paper card, the bill's own row): the job's next New Invoice pulls its actuals
 * (nextInvoiceImportsActuals, which loadAlreadyBilledSheet asks too), and a bill that went out has
 * a line that could hold it. `invoices` are the ones the sheet would offer: the job's own, and for a
 * job that isn't Time & Material its customer's invoices with no job.
 */
export function jobReach(imports: boolean, invoices: readonly AbInvoice[]): { charge: boolean; ret: boolean } {
  return imports ? jobCanHold(invoices) : { charge: false, ret: false };
}

/**
 * THE SHIFTS TICKED TO START ON THE NO-JOB SHEET: the ones the door was pressed on (a split shift
 * whole), and nothing else. Hours on no job name no person on an invoice line the app could match,
 * so the app ticks only what he pointed at; the rest are listed for him to tick.
 */
export function noJobPreticked(entries: readonly AbEntry[], pressed: readonly string[]): string[] {
  let on = new Set<string>();
  for (const id of pressed ?? []) if (entries.some((e) => e.id === id)) on = tickTogether(entries, on, id, true);
  return entries.filter((e) => on.has(e.id)).map((e) => e.id);
}

/**
 * THE NEEDS YOU ROWS OF CLOSED SHIFTS ON NO JOB (0357): `billed` are the ones a live invoice already
 * holds (billed by hand on an invoice with no job, so no longer hours nobody can bill: no row);
 * `door` are the rest, when a sent invoice with no job could hold them. `reach` null is a lost read:
 * every row stays and every one gets the door (the sheet says what it finds).
 */
export function noJobStrayDoors(
  closedIds: readonly string[],
  reach: { canHold: boolean; claimed: ReadonlySet<string> } | null,
): { billed: Set<string>; door: Set<string> } {
  const billed = new Set((closedIds ?? []).filter((id) => !!reach?.claimed.has(id)));
  const door = new Set(reach && !reach.canHold ? [] : (closedIds ?? []).filter((id) => !billed.has(id)));
  return { billed, door };
}

/** Can any invoice with no job that went out hold hours? (a line of work typed or changed by hand) */
export function noJobCanHoldHours(invoices: readonly AbInvoice[]): boolean {
  return invoices.some((i) => !i.job_id && eligibleInvoice(i) && eligibleLines(i, { kind: "time" }).length > 0);
}

/** One tap when it is obvious: the one line of the matching kind, or the only line there is. */
export function preselectLine(inv: AbInvoice, lines: readonly AbLine[], kind: AlreadyBilledKind): string | null {
  const want = matchingGroup(kind);
  const matching = lines.filter((l) => lineGroup(l, inv.invoice_kind) === want);
  if (matching.length === 1) return matching[0].id;
  if (lines.length === 1) return lines[0].id;
  return null;
}

/** "INV-00023 · Materials · $110.00" */
export function lineLabel(inv: Pick<AbInvoice, "invoice_number">, line: Pick<AbLine, "description" | "line_total">): string {
  return [inv.invoice_number ?? "Unnumbered invoice", String(line.description ?? "").trim() || "A line", formatCurrency(Number(line.line_total) || 0)].join(" · ");
}

/**
 * PURPLE SAGE'S QUESTION: "Did J-010 Use All Of It?" Only when Shop Stock is on, the receipt has
 * lines to shelve, and the line that charged for it is less than what the receipt cost ($110 against
 * $186.93: Erik kept 3 GFCIs). The shelf has to come first: once a sent invoice bills a receipt, the
 * shelf refuses it (0328), so No opens the shelf card and comes back to Mark.
 */
export function askUsedAll(o: { shopStock: boolean; billHasLines: boolean; billCost: number; lineTotal: number }): boolean {
  return o.shopStock && o.billHasLines && o.lineTotal > 0 && o.billCost > 0 && cents(o.lineTotal) < cents(o.billCost);
}

// ── Hours ────────────────────────────────────────────────────────────────────────────────────────

/** One closed shift nobody has billed, as the sheet lists it. `person` is the key the importer puts
 *  a person's line under (labor:<person>): the profile id, or the name when there is none. `family`:
 *  the shift a split piece was cut from (coalesce(split_from, id), 0288); missing = its own. */
export type AbEntry = { id: string; person: string; name: string; clockIn: string; hours: number; family?: string };

const familyOf = (e: Pick<AbEntry, "id" | "family">) => e.family || e.id;

/**
 * A SPLIT SHIFT IS TICKED WHOLE (mark_already_billed bills it whole): ticking or unticking one piece
 * does the same to every piece of the same shift the sheet lists.
 */
export function tickTogether(entries: readonly AbEntry[], checked: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const e = entries.find((x) => x.id === id);
  const fam = e ? familyOf(e) : id;
  const next = new Set(checked);
  for (const x of entries) {
    if (x.id !== id && familyOf(x) !== fam) continue;
    if (on) next.add(x.id);
    else next.delete(x.id);
  }
  return next;
}

const wordRe = (w: string) => new RegExp(`(^|[^a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`);

/**
 * WHOSE HOURS A LINE CHARGED: the person its key names (labor:<person>), or, for a line typed by
 * hand, the one person whose full name or first name is in its words ("Labor - Brian"). Two people
 * who both fit, or nobody: null, and nothing is ticked for the office.
 */
export function personOfLine(line: Pick<AbLine, "import_key" | "description">, entries: readonly AbEntry[]): string | null {
  const people = new Map<string, string>();
  for (const e of entries) people.set(e.person, e.name);
  const key = String(line.import_key ?? "");
  if (key.startsWith("labor:")) {
    const p = key.slice("labor:".length).replace(/:\d+$/, "");
    return people.has(p) ? p : null;
  }
  const words = String(line.description ?? "").toLowerCase();
  const full = [...people].filter(([, name]) => name.trim() && wordRe(name.trim()).test(words));
  if (full.length === 1) return full[0][0];
  if (full.length > 1) return null;
  const first = [...people].filter(([, name]) => {
    const f = name.trim().split(/\s+/)[0];
    return !!f && wordRe(f).test(words);
  });
  return first.length === 1 ? first[0][0] : null;
}

/**
 * THE HOURS TICKED TO START WITH: the line's own person's shifts worked on or before the day the
 * invoice was written (its created_at, in the company's time zone). Never the sent date: a bill sent
 * weeks after it was written would tick every hour worked in between, and they would be claimed and
 * never billed. Everything else is listed, unticked, for the office to decide.
 *
 * ONLY WHAT THE LINE HAS ROOM FOR (INV-069's "Labor — Erik": 30.5 h on the line, 27.5 h of shifts
 * already held, so 3 h uncovered). A line billed in hours ticks shifts oldest first only while they
 * fit in its hours less what it already holds, and nothing when it is already covered: ticking more
 * would claim hours no line charges for, and they would never be billed. A line not billed in hours
 * that already holds some ticks nothing (how much it covers can't be told). `covered`: nothing was
 * ticked because the line already holds all it can.
 */
export function precheckHours(
  entries: readonly AbEntry[],
  line: Pick<AbLine, "import_key" | "description"> & Partial<Pick<AbLine, "unit" | "quantity" | "heldHours">>,
  writtenAt: string,
  tz: string,
): { person: string | null; checked: string[]; covered: boolean } {
  const person = personOfLine(line, entries);
  if (!person) return { person: null, checked: [], covered: false };
  const cutoff = todayStrInTz(tz, new Date(writtenAt));
  const picked = entries.filter((e) => e.person === person && todayStrInTz(tz, new Date(e.clockIn)) <= cutoff);
  // A split shift goes whole: a piece ticked ticks the rest of it. Oldest shift first.
  const fams = [...new Set([...picked].sort((a, b) => a.clockIn.localeCompare(b.clockIn)).map(familyOf))];
  const ofFam = (f: string) => entries.filter((e) => familyOf(e) === f);
  const held = Math.max(0, Number(line.heldHours) || 0);
  const lineH = line.unit === undefined ? null : lineHours({ unit: line.unit, quantity: Number(line.quantity) || 0 });
  if (lineH == null) {
    if (held > 0) return { person, checked: [], covered: fams.length > 0 };
    return { person, checked: fams.flatMap((f) => ofFam(f).map((e) => e.id)), covered: false };
  }
  let room = cents(Math.max(0, lineH - held));
  const checked: string[] = [];
  for (const f of fams) {
    const pieces = ofFam(f);
    const h = hoursOf(pieces, pieces.map((e) => e.id));
    if (h > room + 0.005) break;
    checked.push(...pieces.map((e) => e.id));
    room = cents(room - h);
  }
  return { person, checked, covered: fams.length > 0 && checked.length === 0 && cents(lineH - held) <= 0 };
}

/** The hours a line bills, when it is billed in hours ("13 h"), else null. */
export function lineHours(line: Pick<AbLine, "unit" | "quantity">): number | null {
  return isHoursUnit(line.unit) ? cents(Number(line.quantity) || 0) : null;
}

/** The hours of the ticked shifts, to the hundredth. */
export function hoursOf(entries: readonly AbEntry[], ids: Iterable<string>): number {
  const set = new Set(ids);
  return cents(entries.filter((e) => set.has(e.id)).reduce((s, e) => s + (Number(e.hours) || 0), 0));
}

/** "Line: 30.5 h · Already Holds: 27.5 h · Checked: 3 h" (the line's own hours only when it is billed
 *  in hours; what it already holds only when it holds some). */
export function hoursCompareWords(line: Pick<AbLine, "unit" | "quantity"> & Partial<Pick<AbLine, "heldHours">>, checkedHours: number): string {
  const h = lineHours(line);
  const held = Math.max(0, Number(line.heldHours) || 0);
  const fmt = (n: number) => `${cents(n)} h`;
  return [h == null ? null : `Line: ${fmt(h)}`, held > 0 ? `Already Holds: ${fmt(held)}` : null, `Checked: ${fmt(checkedHours)}`].filter(Boolean).join(" · ");
}

/** The sentence after a mark lands: what, where, and that nothing on the bill moved. */
export function markedSentence(what: string, inv: Pick<AbInvoice, "invoice_number">, line: Pick<AbLine, "description" | "line_total">): string {
  const num = inv.invoice_number ?? "that invoice";
  const on = `${String(line.description ?? "").trim() || "a line"} ${formatCurrency(Number(line.line_total) || 0)}`;
  return `${what} is billed on ${num} (${on}). Nothing on ${num} changed.`;
}

/** Said when 0357 isn't on the database yet: the door is there, and it says why it can't work. */
export const NEEDS_UPDATE = "Already Billed needs an update to the app's database before it works. Nothing was changed.";

/**
 * THE BILL'S OWN ROW (Bills → All Bills, Erik: "the Already Billed could connect to the bill on that
 * screen too"). A bill on a job that no invoice holds gets Already Billed where the job's sheet could
 * hold it (a charge, or a supplier return); a bill a person marked says Billed By Hand On INV-x with
 * Not Billed After All. A bill any invoice holds otherwise (an import, or its order billed: the
 * importer skips a receipt whose order is billed) gets nothing, and so does a $0.00 one.
 */
export type BillAlreadyBilled =
  | { kind: "open"; jobId: string; what: string }
  | { kind: "hand"; jobId: string; lineId: string; ids: string[]; invoiceNumber: string | null; what: string };

export function billAlreadyBilledDoors(input: {
  bills: readonly { id: string; job_id?: string | null; po_id?: string | null; amount?: number | string | null; superseded?: boolean; what: string }[];
  reach: ReadonlyMap<string, { charge: boolean; ret: boolean }>;
  hands: ReadonlyMap<string, { lineId: string; invoiceNumber: string | null }>;
  /** Every id some live invoice holds, by an import or by hand. */
  claimed: ReadonlySet<string>;
}): Record<string, BillAlreadyBilled> {
  const out: Record<string, BillAlreadyBilled> = {};
  for (const b of input.bills ?? []) {
    const id = String(b.id);
    const job = b.job_id ? String(b.job_id) : "";
    if (!job || b.superseded) continue;
    const hand = input.hands.get(id);
    if (hand) {
      out[id] = { kind: "hand", jobId: job, lineId: hand.lineId, ids: [id], invoiceNumber: hand.invoiceNumber, what: b.what };
      continue;
    }
    if (input.claimed.has(id) || (b.po_id && input.claimed.has(String(b.po_id)))) continue;
    const amount = Number(b.amount) || 0;
    if (amount === 0) continue;
    const r = input.reach.get(job);
    if (r && (amount < 0 ? r.ret : r.charge)) out[id] = { kind: "open", jobId: job, what: b.what };
  }
  return out;
}

// ── The Costs tab's doors, from what the page already read ───────────────────────────────────────

/** Which of a job's rows a person marked, by the row's id (lib/already-billed-read's HandClaims). */
export type HandById = ReadonlyMap<string, { lineId: string; invoiceNumber: string | null; invoiceId?: string | null }>;

type Piles = { open: { ids: string[] }; billed: { ids: string[] }[] };

/**
 * What the Costs tab offers, row by row: Already Billed on each Not Billed Yet row (only when some
 * sent bill has a line that could hold it: `offer.charge`, or for a supplier return `offer.ret`),
 * and Billed By Hand · Not Billed After All on each billed row a person marked. A take's row id is its
 * stock key; its ids are every move of it (a take bills whole).
 */
export function jobAlreadyBilledDoors(input: {
  groups: Piles;
  bills: readonly { id: string; supplier?: string | null; bill_number?: string | null; amount?: number | string | null }[];
  pos: readonly { id: string; po_number?: string | null; vendor?: string | null }[];
  takes: readonly { key: string; moveIds: readonly string[]; label: string }[];
  hands: HandById | null;
  offer: { charge: boolean; ret: boolean };
}): {
  open: Record<string, { kind: "bill" | "po" | "stock"; ids: string[]; what: string }>;
  hands: Record<string, { lineId: string; ids: string[]; invoiceNumber: string | null; what: string }>;
} {
  const bill = new Map(input.bills.map((b) => [String(b.id), b] as const));
  const po = new Map(input.pos.map((p) => [String(p.id), p] as const));
  const take = new Map(input.takes.map((t) => [t.key, t] as const));
  const words = (id: string): { kind: "bill" | "po" | "stock"; ids: string[]; what: string } | null => {
    const b = bill.get(id);
    if (b) return { kind: "bill", ids: [id], what: [String(b.supplier ?? "").trim() || "The bill", b.bill_number ? String(b.bill_number) : null].filter(Boolean).join(" ") };
    const p = po.get(id);
    if (p) return { kind: "po", ids: [id], what: [p.po_number, p.vendor].filter(Boolean).join(" · ") || "The order" };
    const t = take.get(id);
    if (t) return { kind: "stock", ids: [...t.moveIds], what: t.label };
    return null;
  };
  const open: Record<string, { kind: "bill" | "po" | "stock"; ids: string[]; what: string }> = {};
  for (const id of input.groups.open.ids) {
    const w = words(id);
    if (!w) continue;
    const isReturn = w.kind === "bill" && (Number(bill.get(id)?.amount) || 0) < 0;
    if (isReturn ? input.offer.ret : input.offer.charge) open[id] = w;
  }
  const hands: Record<string, { lineId: string; ids: string[]; invoiceNumber: string | null; what: string }> = {};
  if (input.hands) {
    for (const g of input.groups.billed) {
      for (const id of g.ids) {
        const w = words(id);
        if (!w) continue;
        const held = w.ids.filter((x) => input.hands!.has(x));
        if (!held.length) continue;
        const h = input.hands.get(held[0])!;
        // One line holds a mark (a take bills whole, on one line): the ids that line holds by hand.
        const same = held.filter((x) => input.hands!.get(x)!.lineId === h.lineId);
        hands[id] = { lineId: h.lineId, ids: same, invoiceNumber: h.invoiceNumber, what: w.what };
      }
    }
  }
  return { open, hands };
}

/**
 * THE JOB'S HOURS A PERSON MARKED, per line: "Billed By Hand On INV-059: 5 h · Not Billed After All".
 * `entries` are the job's closed shifts (clock_in, clock_out, lunch_minutes).
 */
export function hoursByHand(
  entries: readonly { id: string; clock_in: string; clock_out?: string | null; lunch_minutes?: number | null; profiles?: { full_name?: string | null } | null }[],
  hands: HandById | null,
): { lineId: string; invoiceId: string | null; invoiceNumber: string | null; ids: string[]; hours: number; what: string }[] {
  if (!hands) return [];
  const by = new Map<string, { lineId: string; invoiceId: string | null; invoiceNumber: string | null; ids: string[]; hours: number; names: Set<string> }>();
  for (const e of entries ?? []) {
    const h = hands.get(String(e.id));
    if (!h || !e.clock_out) continue;
    const hrs = (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - Math.max(0, Number(e.lunch_minutes) || 0) / 60;
    const cur = by.get(h.lineId) ?? { lineId: h.lineId, invoiceId: h.invoiceId ?? null, invoiceNumber: h.invoiceNumber, ids: [], hours: 0, names: new Set<string>() };
    cur.ids.push(String(e.id));
    cur.hours += Math.max(0, hrs);
    if (e.profiles?.full_name) cur.names.add(String(e.profiles.full_name));
    by.set(h.lineId, cur);
  }
  return [...by.values()].map((x) => {
    const hours = cents(x.hours);
    const names = [...x.names];
    return { lineId: x.lineId, invoiceId: x.invoiceId, invoiceNumber: x.invoiceNumber, ids: x.ids, hours, what: names.length === 1 ? `${hours} h of ${names[0]}'s time` : `${hours} h of time` };
  });
}
