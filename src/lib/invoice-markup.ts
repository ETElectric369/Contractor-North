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
 */

import { billableBillCost, type BillLine } from "./bill-itemisation";

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

export function markupOnInvoice(input: {
  lines: readonly InvoiceCostLine[];
  dismissed: ReadonlySet<string>;
  bills: readonly { id: string; amount: unknown }[];
  linesByBill: ReadonlyMap<string, BillLine[]>;
  pos: readonly { id: string; total: unknown }[];
}): number | null {
  const bySource = new Map<string, InvoiceCostLine[]>();
  for (const l of input.lines) {
    const src = (l.source_ids ?? [])[0];
    if (!src) continue;
    const k = String(src);
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k)!.push(l);
  }

  const samples: { sell: number; cost: number }[] = [];
  const read = (id: string, cost: number, touched: (key: string) => boolean) => {
    const rows = bySource.get(id);
    if (!rows?.length || !(cost > 0)) return;
    if (rows.some((r) => r.edited === true)) return;
    if ([...input.dismissed].some(touched)) return;
    const sell = rows.reduce((s, r) => s + (Number(r.line_total) || 0), 0);
    if (!(sell > 0)) return;
    samples.push({ sell, cost });
  };

  for (const b of input.bills) {
    const amount = Number(b.amount);
    if (!(amount > 0)) continue; // a return is a credit, read backwards - not a price sample
    const lines = input.linesByBill.get(b.id) ?? [];
    const lineIds = new Set(lines.map((l) => `bli:${l.id}`));
    read(b.id, billableBillCost(amount, lines), (k) => k === `bill:${b.id}` || k.startsWith(`bill:${b.id}:`) || lineIds.has(k));
  }
  for (const p of input.pos) read(p.id, Number(p.total), (k) => k === `po:${p.id}`);

  const cost = samples.reduce((s, x) => s + x.cost, 0);
  if (!(cost >= 5)) return null;
  const sell = samples.reduce((s, x) => s + x.sell, 0);
  const pct = (sell / cost - 1) * 100;
  for (const x of samples) {
    if (x.cost < VOTE_FLOOR) continue;
    if (Math.abs((x.sell / x.cost - 1) * 100 - pct) > AGREE) return null;
  }
  return Math.round(pct * 10) / 10;
}
