/**
 * THE MARKUP AN INVOICE IS ALREADY PRICED AT (review of the J-011 wave, 2026-09-24).
 *
 * Erik's ask on INV-078 was two things: bring it up to date, "or adjust the markup %". The % box
 * beside Materials from Costs re-prices every untouched materials line at the figure he types - and
 * nothing stores that figure. So the next "Add to INV-078" (or Request Next Payment, or New Invoice
 * landing on a draft) re-ran the materials import at the CUSTOMER'S default markup, and the RPC
 * refreshed every untouched line in place at that price: his 20% quietly went back to 15%, the
 * invoice moved by a figure the card never promised, and the toast said "Pulled 12 hours".
 *
 * The invoice itself is the record. Every untouched bill on it bills exactly mark(billable cost)
 * (billItemisation's anchor invariant: a bill's rows sum to its marked-up billable amount), and a
 * PO line bills mark(total). So the lines say what markup they were priced at. This reads it back:
 * only from bills whose every row is still the importer's (an edited row carries the office's own
 * number, a deleted one takes part of the bill off), weighted by cost so the cents of rounding on
 * a $3 part can't move it, and only when the bills agree - a draft priced at two different
 * markups has no single answer, and inventing one would reprice half of it.
 *
 * Pure: the caller hands over the invoice's materials lines, the tombstones and the job's bills,
 * orders and receipt lines. Returns null when there is nothing to read it from, or no one answer.
 * The reads that feed it live in ONE place (lib/invoice-markup-read), shared by the importer and
 * the invoice page's % box, so the two can never disagree about what an invoice is priced at.
 */

import { billableBillCost, billItemisation, remainderKey, type BillLine } from "./bill-itemisation";

export type InvoiceCostLine = {
  import_key: string | null;
  source_ids: string[] | null;
  line_total: unknown;
  edited: boolean | null;
};

/** A bill at least this big gets a vote on whether the invoice's bills agree. Below it, a cent of
 *  rounding moves the implied markup by more than the tolerance. */
const VOTE_FLOOR = 20;
/** How far (percentage points) one bill may sit from the weighted answer and still agree. */
const AGREE = 0.5;

export type MarkupOnInvoiceInput = {
  lines: readonly InvoiceCostLine[];
  dismissed: ReadonlySet<string>;
  bills: readonly { id: string; amount: unknown }[];
  linesByBill: ReadonlyMap<string, BillLine[]>;
  pos: readonly { id: string; total: unknown }[];
};

/**
 * What the lines say, in the three shapes the % box has to tell apart (Erik, 2026-09-25: "i changed
 * andrew's invoice to 11% ... but the marker still shows 15"). `one`: every untouched bill agrees,
 * and this is the figure. `mixed`: there were bills to read and they disagree - no single answer,
 * and the box says so rather than show one. `none`: nothing untouched to read it from.
 */
export type MarkupReading = { kind: "one"; pct: number } | { kind: "mixed" } | { kind: "none" };

/** The importer's rule (keepInvoiceMarkup) as a number: the one figure, or null for mixed / none. */
export function markupOnInvoice(input: MarkupOnInvoiceInput): number | null {
  const r = markupReading(input);
  return r.kind === "one" ? r.pct : null;
}

export function markupReading(input: MarkupOnInvoiceInput): MarkupReading {
  const bySource = new Map<string, InvoiceCostLine[]>();
  for (const l of input.lines) {
    const src = (l.source_ids ?? [])[0];
    if (!src) continue;
    const k = String(src);
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k)!.push(l);
  }

  const samples: { sell: number; cost: number }[] = [];
  const read = (
    id: string,
    cost: number,
    touched: (key: string) => boolean,
    /** Do these rows still say what the receipt says now? (See stillTheReceipt.) */
    current: (rows: InvoiceCostLine[], sell: number) => boolean = () => true,
  ) => {
    const rows = bySource.get(id);
    if (!rows?.length || !(cost > 0)) return;
    if (rows.some((r) => r.edited === true)) return;
    if ([...input.dismissed].some(touched)) return;
    const sell = rows.reduce((s, r) => s + (Number(r.line_total) || 0), 0);
    if (!(sell > 0)) return;
    if (!current(rows, sell)) return;
    samples.push({ sell, cost });
  };

  for (const b of input.bills) {
    const amount = Number(b.amount);
    if (!(amount > 0)) continue; // a return is a credit, read backwards - not a price sample
    const lines = input.linesByBill.get(b.id) ?? [];
    const lineIds = new Set(lines.map((l) => `bli:${l.id}`));
    const cost = billableBillCost(amount, lines);
    read(
      b.id,
      cost,
      (k) => k === `bill:${b.id}` || k.startsWith(`bill:${b.id}:`) || lineIds.has(k),
      (rows, sell) => stillTheReceipt({ id: b.id, amount: b.amount }, lines, rows, (sell / cost - 1) * 100),
    );
  }
  for (const p of input.pos) read(p.id, Number(p.total), (k) => k === `po:${p.id}`);

  const cost = samples.reduce((s, x) => s + x.cost, 0);
  if (!(cost >= 5)) return { kind: "none" };
  const sell = samples.reduce((s, x) => s + x.sell, 0);
  const pct = (sell / cost - 1) * 100;
  for (const x of samples) {
    if (x.cost < VOTE_FLOOR) continue;
    if (Math.abs((x.sell / x.cost - 1) * 100 - pct) > AGREE) return { kind: "mixed" };
  }
  // Below zero is not a markup anyone set: it is lines priced off a receipt that has since grown
  // (a lump bill whose amount went up, which no row can show). There is no one answer to give.
  if (pct < 0) return { kind: "mixed" };
  return { kind: "one", pct: Math.round(pct * 10) / 10 };
}

/**
 * A RECEIPT THAT CHANGED AFTER ITS LINES WERE WRITTEN HAS NO VOTE (review of this branch).
 *
 * The reading divides what a bill's rows bill NOW by what the receipt costs NOW. That ratio is a
 * markup only while the rows are still the importer's rows for the receipt as it stands. Switch a
 * line off after the import (the snacks), split a container, or take a supplier credit off the
 * bill, and the ratio is not a markup at all: a $100 receipt imported at 11% ($88.80 wire, $22.20
 * snacks) with the snacks switched off reads $111 over $80 = 38.7%, and seeding the % box with that
 * figure re-bills the snacks on the very tap meant to bring the change in.
 *
 * So a bill votes only when billItemisation, run on the receipt as it is now at the markup its rows
 * imply, puts back the same rows: the same keys (a switched-off line's row is still on the invoice
 * and is no longer produced; a line switched back on is produced and is not there) and every item
 * row within the cents that re-rounding can move it (a cent on the sell, times the count when the
 * row shows qty x unit). A credit on a bill's amount moves the implied markup, and every item row
 * priced off it misses by far more than a cent. The "Supplies & tax" row is not compared: it trues
 * the bill up to the total the implied markup was taken from, so it matches by construction.
 *
 * A bill with no receipt lines is one lump row and cannot say whether its amount moved - that is
 * what the below-zero refusal above and the bills' agreement are for.
 */
function stillTheReceipt(
  bill: { id: string; amount: unknown },
  lines: BillLine[],
  rows: readonly InvoiceCostLine[],
  pct: number,
): boolean {
  const fresh = billItemisation(bill, lines, pct);
  if (fresh.length !== rows.length) return false;
  const byKey = new Map(fresh.map((r) => [r.import_key, r]));
  const remainder = remainderKey(bill.id);
  const seen = new Set<string>();
  for (const r of rows) {
    const key = String(r.import_key ?? "");
    const f = byKey.get(key);
    if (!f || seen.has(key)) return false;
    seen.add(key);
    if (key === remainder) continue;
    const want = f.quantity * f.unit_price;
    const slack = 0.02 + 0.01 * Math.max(1, Math.abs(f.quantity));
    if (Math.abs((Number(r.line_total) || 0) - want) > slack) return false;
  }
  return true;
}

/**
 * WHAT THE % BOX STARTS AT, AND WHY (2026-09-25).
 *
 * The box used to start at the customer's usual markup whatever the lines said. On INV-078 that
 * was a trap: Erik had moved Andrew's invoice to 11%, the box still read 15, and tapping Materials
 * from Costs (or typing in the box and leaving it) sent that 15 and repriced every untouched line
 * back. The box now starts where the invoice IS when its lines give one answer - the reading the
 * importer's keepInvoiceMarkup takes, from the same server read (lib/invoice-markup-read) - and at
 * the usual figure otherwise, with the reason said beside it.
 *
 * `reading` null = the invoice has no materials lines to read (a fresh invoice); "unread" = the
 * read failed, which is not the same as "no lines" and is said as such.
 */
export type MarkupSeed = {
  /** What the box starts at. */
  pct: number;
  /** Where that figure came from. */
  source: "invoice" | "mixed" | "usual" | "unread";
  /** The customer's pricing level, or the org default when they have none. */
  usualPct: number;
};

export function markupBoxSeed(reading: MarkupReading | "unread" | null, usualPct: unknown): MarkupSeed {
  const n = Number(usualPct);
  const usual = Number.isFinite(n) && n >= 0 ? n : 0;
  if (reading === "unread") return { pct: usual, source: "unread", usualPct: usual };
  if (reading?.kind === "one") return { pct: reading.pct, source: "invoice", usualPct: usual };
  if (reading?.kind === "mixed") return { pct: usual, source: "mixed", usualPct: usual };
  return { pct: usual, source: "usual", usualPct: usual };
}

const pctWords = (n: number) => `${Math.round(n * 10) / 10}%`;

/**
 * The words beside the box. `main` is what the lines are priced at, or why there is no one figure;
 * `usual` is the customer's usual - small, secondary, and only when it differs from what the lines
 * say. `who` is whose usual it is: the customer when they have a pricing level, null when the usual
 * is the org default.
 */
export function markupBoxWords(seed: MarkupSeed, who: string | null): { main: string | null; usual: string | null } {
  if (seed.source === "mixed") return { main: "Lines are at different markups", usual: null };
  if (seed.source === "unread") return { main: "Couldn't read what these lines are priced at just now", usual: null };
  if (seed.source !== "invoice") return { main: null, usual: null };
  const name = who?.trim();
  const differs = Math.abs(seed.pct - seed.usualPct) > 0.05;
  return {
    main: `Priced at ${pctWords(seed.pct)}`,
    usual: !differs ? null : name ? `${name}'s usual is ${pctWords(seed.usualPct)}` : `Your default is ${pctWords(seed.usualPct)}`,
  };
}

/**
 * THE BOX'S OWN STATE: what is typed, and what the lines were last set to from here.
 *
 * `applied` starts at the seed, so opening the page and leaving the box never reprices anything,
 * and `value !== applied` is the one meaning of "the person has typed a new number". When the
 * server re-reads (a refresh after any import, or someone else's change), the new seed is taken
 * only when nothing is typed - and a seed that is not the invoice's own reading (no lines left to
 * read, or lines that disagree) does not overwrite a number the person just applied here.
 */
export type MarkupBoxState = { value: number; applied: number; appliedHere: boolean };

export function markupBoxStart(seed: MarkupSeed): MarkupBoxState {
  return { value: seed.pct, applied: seed.pct, appliedHere: false };
}

export function markupBoxTyped(box: MarkupBoxState): boolean {
  return box.value !== box.applied;
}

export function markupBoxOnSeed(box: MarkupBoxState, seed: MarkupSeed): MarkupBoxState {
  if (markupBoxTyped(box)) return box;
  if (seed.source !== "invoice" && box.appliedHere) return box;
  return { ...box, value: seed.pct, applied: seed.pct };
}

/** The lines were just set to `pct` from here. What is in the box stays - if they typed again while
 *  the import ran, that is still theirs to apply. */
export function markupBoxApplied(box: MarkupBoxState, pct: number): MarkupBoxState {
  return { value: box.value, applied: pct, appliedHere: true };
}

/**
 * WHAT MATERIALS FROM COSTS SENDS, AND WHAT ITS CONFIRM SAYS (review of this branch).
 *
 * The button used to send whatever the box held as an explicit markup. When the box held the
 * page's own reading that was harmless, but it also held the customer's usual whenever the page
 * could NOT read one - a failed read, or lines at different markups - and one tap then repriced
 * every untouched line on INV-078 back to 15%, the exact trap this box was rebuilt to close. The
 * confirm called it a refresh and never named a percent.
 *
 * So a number the person TYPED is the only one sent as a decision. Otherwise the import is asked
 * to keep the invoice's own markup (keepInvoiceMarkup): the server reads the lines again with the
 * importer's read, keeps the one figure they give, refuses when that read fails, and only when
 * there is no one figure prices at `pct` - which the confirm now says, with the number in it.
 */
export type MaterialsImportPlan = {
  /** The markup sent. */
  pct: number;
  /** Ask the server to keep the markup the invoice's lines are at (everything but a typed number). */
  keepInvoiceMarkup: boolean;
  /** A sentence for the re-import confirm: what markup the untouched lines end up at. */
  confirmNote: string;
  /** A sentence for Start It Over's confirm (every line of the source is rebuilt at `pct`). */
  rebuildNote: string;
};

export function materialsImportPlan(box: MarkupBoxState, seed: MarkupSeed): MaterialsImportPlan {
  const pct = box.value;
  const at = pctWords(pct);
  const rebuildNote =
    seed.source === "unread" && !markupBoxTyped(box)
      ? `Materials are rebuilt at ${at} markup - this page couldn't read what they were priced at, so check that figure first.`
      : `Materials are rebuilt at ${at} markup.`;
  if (markupBoxTyped(box)) {
    return { pct, keepInvoiceMarkup: false, confirmNote: `Untouched materials lines are repriced at ${at}, the markup you typed.`, rebuildNote };
  }
  const confirmNote =
    seed.source === "invoice"
      ? `Untouched materials lines stay at ${at}, the markup they're priced at.`
      : seed.source === "mixed"
        ? `Lines are at different markups - this prices every untouched materials line at ${at}.`
        : seed.source === "unread"
          ? `This page couldn't read what the lines are priced at, so the import reads them again first: untouched lines keep the markup they're at, or are priced at ${at} if they aren't all at one.`
          : `Untouched materials lines are priced at ${at}.`;
  return { pct, keepInvoiceMarkup: true, confirmNote, rebuildNote };
}
