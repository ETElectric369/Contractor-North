// cn-v1176: the Won sheet's shared shapes and its pure rules (lane MONEY). Pure; imports no catalog.
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { ESTIMATE_VISIT_TYPES, isDecidableVisitType } from "@/lib/statuses";

/**
 * WON · START THE JOB (cn-v1176). The owner, 2026-11-21: "an instant create and approve estimate button
 * at the bottom which would run the proper cycle of things". The SERVER decides what the sheet shows
 * (appointments/won-actions readWonSheet) and the approve door re-decides it before it writes anything
 * (approveVisitEstimate). This file holds the shapes both sides share and the rules that need no
 * database: the state decision (decideWonState), the overrides (applyWonOverrides), the totals
 * (wonTotals, through the one subtotalTaxTotal the estimate editor and its save use) and the stamp.
 */

export type BillingKind = "tm" | "fixed";
export type WonRef = { id: string; number: string | null };
export type WonLine = {
  key: string;                 // stable for one read of one visit, e.g. "scope:<question>:<code>", "task:<id>:labor", "typed:<n>"
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  amount: number;              // rounded the way a saved estimate line is
  hole: null | { kind: "flag" | "zero"; flag: string | null };   // null = priced
};
export type WonOverride = { key: string; remove?: boolean; quantity?: number; unitPrice?: number };
export type WonSheet =
  | { ok: false; error: string }
  | { ok: true; state: "has_job"; job: WonRef }
  | { ok: true; state: "finish"; quote: WonRef; total: number; billingKind: BillingKind }
  | { ok: true; state: "refer"; quote: WonRef; job: WonRef }
  | { ok: true; state: "plain"; why: "nothing_priced" | "estimates_off"; billingKind: BillingKind; noCustomer: boolean }
  | { ok: true; state: "estimate"; source: "visit" | "existing"; quote: WonRef | null; stamp: string;
      lines: WonLine[]; taxRate: number; subtotal: number; tax: number; total: number;
      billingKind: BillingKind; noCustomer: boolean };
export type ApproveInput = {
  appointmentId: string;
  quoteId: string;             // source "visit": a uuid the sheet mints ONCE per opening; "existing" and "finish": that estimate's id
  stamp: string;               // what the read returned; "" for finish
  overrides: WonOverride[];    // source "visit" only; [] otherwise
  billingType: BillingKind;
};
export type ApproveResult =
  | { ok: true; quote: WonRef; total: number; job: WonRef | null; warnings: string[] }
  | { ok: false; error: string; reread: boolean };

/** A line's amount the way the database stores it: round(quantity × unit price, 2), half away from zero,
 *  on the DECIMAL product (numeric in the database). The scaled value is read back to 15 significant
 *  digits first, so float dust never decides a half cent: 0.25 × $4.02 is $1.01 here as it is stored,
 *  never the $1.00 a bare Math.round(1.00499… × 100) gives (cn-v1176 fix F6). */
export function lineAmount(quantity: number, unitPrice: number): number {
  const n = (Number(quantity) || 0) * (Number(unitPrice) || 0);
  if (!Number.isFinite(n)) return 0;
  const scaled = Number((Math.abs(n) * 100).toPrecision(15));
  return (Math.sign(n) * Math.round(scaled)) / 100;
}

/** Is this override's number one the door may take? Finite, a quantity above 0, a price 0 or more. */
export function overrideProblem(overrides: WonOverride[]): string | null {
  for (const o of overrides) {
    if (!o || typeof o.key !== "string" || !o.key) return "key";
    if (o.quantity !== undefined && !(typeof o.quantity === "number" && Number.isFinite(o.quantity) && o.quantity > 0)) return o.key;
    if (o.unitPrice !== undefined && !(typeof o.unitPrice === "number" && Number.isFinite(o.unitPrice) && o.unitPrice >= 0)) return o.key;
  }
  return null;
}

/**
 * THE OVERRIDES, BY KEY. A removed line leaves; a typed quantity or unit price replaces the line's and
 * the amount is redrawn. A typed unit price above 0 answers the line's hole (he priced it by hand); 0
 * leaves it asking. A quantity alone answers nothing. A number this door would refuse (overrideProblem)
 * is not applied here, so the screen never draws a figure the save would not take. An override whose key
 * names no line does nothing.
 */
export function applyWonOverrides(lines: WonLine[], overrides: WonOverride[]): WonLine[] {
  const byKey = new Map<string, WonOverride>();
  for (const o of overrides ?? []) if (o && typeof o.key === "string") byKey.set(o.key, o);
  const out: WonLine[] = [];
  for (const l of lines) {
    const o = byKey.get(l.key);
    if (!o) {
      out.push(l);
      continue;
    }
    if (o.remove) continue;
    const qtyOk = typeof o.quantity === "number" && Number.isFinite(o.quantity) && o.quantity > 0;
    const priceOk = typeof o.unitPrice === "number" && Number.isFinite(o.unitPrice) && o.unitPrice >= 0;
    const quantity = qtyOk ? (o.quantity as number) : l.quantity;
    const unitPrice = priceOk ? (o.unitPrice as number) : l.unitPrice;
    const amount = lineAmount(quantity, unitPrice);
    let hole = priceOk ? ((o.unitPrice as number) > 0 ? null : { kind: "zero" as const, flag: null }) : l.hole;
    // A $0 OR NEGATIVE LINE IS A HOLE (cn-v1176 fix F3, the builder's lineHole says the same): a priced
    // line with a quantity of 0 or less, or an amount of 0 or less, still asks for its quantity.
    if (!hole && (!(quantity > 0) || !(amount > 0))) hole = { kind: "zero" as const, flag: null };
    out.push({ ...l, quantity, unitPrice, amount, hole });
  }
  return out;
}

/** The sheet's totals, through the ONE subtotalTaxTotal the estimate editor and its save (recalcQuote)
 *  use, over each line's stored-way amount. */
export function wonTotals(lines: WonLine[], taxRate: number): { subtotal: number; tax: number; total: number } {
  return subtotalTaxTotal(lines.map((l) => l.amount), taxRate || 0);
}

/** A short hash (FNV-1a, 32 bits, hex) of what the sheet shows: the lines and the totals. */
export function wonStamp(lines: WonLine[], taxRate: number, totals: { subtotal: number; tax: number; total: number }): string {
  const text = JSON.stringify([
    lines.map((l) => [l.key, l.description, l.quantity, l.unit, l.unitPrice, l.amount, l.hole?.kind ?? null, l.hole?.flag ?? null]),
    taxRate,
    totals.subtotal,
    totals.tax,
    totals.total,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** An estimate as the decision reads it. */
export type WonQuoteFact = { id: string; number: string | null; status: string | null; job: WonRef | null; total: number };

export type WonFacts = {
  visit: { type: string | null; status: string | null; outcome: string | null; job: WonRef | null };
  /** The estimate behind the visit by its capture backlink, read through the behind-visit rule (a
   *  superseded one through its standing revision); null when there is none. */
  behind: WonQuoteFact | null;
  /** The visit's lead's estimates (any order; the newest is read by `createdAt`). */
  lead: (WonQuoteFact & { createdAt: string | null })[];
  estimatesOn: boolean;
  /** The builder's lines: how many are priced and how many are holes. */
  visitLines: { priced: number; holes: number };
};

export type WonDecision =
  | { kind: "refuse"; why: "not_inspection" | "cancelled" | "not_sold" }
  | { kind: "has_job"; job: WonRef; quote: WonQuoteFact | null }
  | { kind: "finish"; quote: WonQuoteFact }
  | { kind: "existing"; quote: WonQuoteFact }
  | { kind: "refer"; quote: WonQuoteFact; job: WonRef }
  | { kind: "plain"; why: "nothing_priced" | "estimates_off" }
  | { kind: "visit" };

/** NOT SOLD IS TWO STORED WORDS (cn-v1176): a visit's outcome 'lost' or 'no_bid' (lib/appointments/file-visit
 *  reads the same two). The server's refusal and the Inspector's door (inspection-page wonDoorShown) read this. */
export const isNotSoldOutcome = (o: string | null | undefined): boolean => o === "lost" || o === "no_bid";

/** A SALES VISIT THAT CAN BE WON HERE (cn-v1176 fix F2): an inspection or the old estimate-type visit
 *  ("quote"), the visits whose product is an estimate (lib/statuses ESTIMATE_VISIT_TYPES) and that have
 *  a win to record (a final inspection is the authority's, never a sale). ONE rule: the Inspector's door
 *  (inspection-page wonDoorShown), the server (decideWonState, startJobFromSale) and the lists' and the
 *  ending card's Won link (wonStartShown) all read it. */
export const isWonVisitType = (t: string | null | undefined): boolean =>
  (ESTIMATE_VISIT_TYPES as readonly string[]).includes(t ?? "") && isDecidableVisitType(t);

/** Is a visit's "Won · Start the Job" (to `?won=1`) drawn on a list row or on the ending card? A visit
 *  marked Won with no job, of a type the Won sheet takes (isWonVisitType). Any other Won visit with no
 *  job keeps a button that opens the visit, where the quiet pick of a job is. */
export const wonStartShown = (v: { type: string | null | undefined; outcome: string | null | undefined; hasJob: boolean }): boolean =>
  v.outcome === "won" && !v.hasJob && isWonVisitType(v.type);

const LIVE = new Set(["draft", "sent"]);

/**
 * WHAT THE SHEET SHOWS, in the contract's order (M3):
 *   not an inspection, cancelled, Not Sold         refuse
 *   the visit has a job                            has_job
 *   an estimate behind the visit: accepted with a job has_job (that job); accepted, no job finish;
 *                                  draft or sent existing; declined, expired, superseded ignored
 *   the lead's estimates: an accepted one with a job refer; accepted with none finish; else the newest
 *                                  draft or sent existing (an acceptance is read first: never a second job)
 *   Estimates switched off                          plain (estimates_off)
 *   the builder's lines: nothing priced and no hole plain (nothing_priced); else visit
 */
export function decideWonState(f: WonFacts): WonDecision {
  if (!isWonVisitType(f.visit.type)) return { kind: "refuse", why: "not_inspection" };
  if (f.visit.status === "cancelled") return { kind: "refuse", why: "cancelled" };
  if (isNotSoldOutcome(f.visit.outcome)) return { kind: "refuse", why: "not_sold" };
  if (f.visit.job) return { kind: "has_job", job: f.visit.job, quote: f.behind?.status === "accepted" ? f.behind : null };
  const b = f.behind;
  if (b) {
    if (b.status === "accepted") return b.job ? { kind: "has_job", job: b.job, quote: b } : { kind: "finish", quote: b };
    if (LIVE.has(b.status ?? "")) return { kind: "existing", quote: b };
  }
  const newestFirst = [...f.lead].sort((x, y) => String(y.createdAt ?? "").localeCompare(String(x.createdAt ?? "")));
  const acceptedWithJob = newestFirst.find((q) => q.status === "accepted" && q.job);
  if (acceptedWithJob) return { kind: "refer", quote: acceptedWithJob, job: acceptedWithJob.job as WonRef };
  const acceptedNoJob = newestFirst.find((q) => q.status === "accepted");
  if (acceptedNoJob) return { kind: "finish", quote: acceptedNoJob };
  const open = newestFirst.find((q) => LIVE.has(q.status ?? ""));
  if (open) return { kind: "existing", quote: open };
  if (!f.estimatesOn) return { kind: "plain", why: "estimates_off" };
  if (f.visitLines.priced === 0 && f.visitLines.holes === 0) return { kind: "plain", why: "nothing_priced" };
  return { kind: "visit" };
}

/** The job's billing kind an estimate's own word says: an Estimate is time and material, a Quote fixed. */
export const billingKindOfDocType = (docType: string | null | undefined): BillingKind => (docType === "quote" ? "fixed" : "tm");
/** The estimate's word a billing kind asks for: time and material is an Estimate, fixed a Quote. */
export const docTypeOfBillingKind = (k: BillingKind): "estimate" | "quote" => (k === "fixed" ? "quote" : "estimate");
