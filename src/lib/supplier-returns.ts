import { formatCurrency } from "@/lib/utils";
import {
  PART_USED_SUFFIX,
  billItemisation,
  billLineBilledCost,
  billLineCost,
  billableBillCost,
  billedPortion,
  isTaxLine,
  remainderKey,
  type BillForItemisation,
  type BillItemRow,
  type BillLine,
} from "@/lib/bill-itemisation";

/**
 * A SUPPLIER RETURN REACHES THE INVOICE (2026-09-24, INV-078).
 *
 * Four LED housings went back to CED. The return was scanned and filed on the job as a bill of
 * -$51.58, and the customer was still billed for all four: the materials importer and the Unbilled
 * card both opened their bill loop with "skip anything that is not above zero", so a return was
 * not a smaller cost, it was invisible. Erik fixed INV-078 by hand, by switching the purchase line
 * and the return lines to "not the customer's" - which is the right answer for that invoice, and
 * the reason those rows must never be credited now.
 *
 * WHAT A RETURN IS, IN THIS APP'S OWN ARITHMETIC: the same piece of paper read backwards. Every
 * rule the purchase side already has applies to it unchanged -
 *   - the markup is the job's materials markup (what the customer was charged for the part is what
 *     comes off when it goes back),
 *   - a line switched off (0268) is not credited, because it was never billed,
 *   - a container billed in part (0272) credits only the part this job was billed,
 *   - TAX RIDES WITH WHAT IT TAXES: the return's tax comes back in proportion to the lines that do,
 *   - the rows sum to exactly the marked-up credit (the anchor invariant), on the cent.
 * So rather than a second copy of that arithmetic, a return is MIRRORED into a positive receipt,
 * run through billItemisation - the one function that has been reviewed against every one of those
 * rules - and the rows it produces are turned back into credits. There is nothing to drift.
 *
 * The claim is the bill's id on every row, exactly like a purchase (0255/0258): a return credited
 * on one non-void invoice is held there, and another invoice will skip it rather than credit it a
 * second time.
 */

const cents = (n: number) => Math.round(n * 100) / 100;

/** Below zero, to the cent: goods went back to the supplier, or a credit memo. Zero is neither a
 *  cost nor a credit and stays skipped, as it always was. */
export function isReturnBill(amount: unknown): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && Math.round(n * 100) < 0;
}

/**
 * One return line, read as the purchase it reverses. The extension is the cost (billLineCost), so
 * the mirror negates THAT, not the unit price - a return scanned as "-4 × 11.83" and one scanned as
 * "4 × -11.83" are the same $47.32. The count is kept as a count (never negative) so the invoice can
 * still say "4 × $13.60". `billed_amount` is already stored as a size, not a signed figure (0272's
 * check compares it to abs(amount)), so it passes through untouched and means the same thing: the
 * part of this container this job was billed for.
 */
function mirrored(l: BillLine): BillLine {
  const qty = Number(l.quantity);
  return {
    ...l,
    quantity: Number.isFinite(qty) ? Math.abs(qty) : l.quantity,
    unit_price: -(Number(l.unit_price) || 0),
    amount: cents(-billLineCost(l)),
  };
}

/** A line's words, for matching a returned part to the purchase it reverses: case, punctuation
 *  and spacing are the scanner's, not the part's. */
function itemWords(desc: unknown): string {
  return String(desc ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The same part, read off two pieces of paper. CED prints the return with its catalogue number in
 * front ("H245ICAT 4 in LED Shallow IC HSG") and the purchase without it ("4 in LED SHALLOW IC
 * HSG"), so one description has to hold the other as whole words - never a fuzzy score. At least
 * two words, so "wire" alone never claims every coil on the job.
 */
function sameItem(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.split(" ").length < 2) return false;
  return ` ${long} `.includes(` ${short} `);
}

/**
 * A RETURN CREDITS WHAT THE CUSTOMER WAS BILLED, NEVER MORE (review of this wave).
 *
 * "A shop-stock line credits only its billed part" cannot be read off the return alone: the
 * return is a new piece of paper, and the decision about how much of that box was the customer's
 * was made on the PURCHASE - switched off (0268), or split to what this job used (0272). Reading
 * the return in isolation sends a $108.36 box of Twisters back and credits the customer $135.45 at
 * 25% when they were billed $16.25 for it: money they were never charged.
 *
 * So every returned line is matched, by its words (sameItem), to the purchase lines on this job's
 * own receipts, and it credits at most what those purchase lines billed - billLineBilledCost, the
 * one reading the importer bills by. A purchase switched off credits nothing; a container billed in
 * part credits up to that part; several returns of one purchase share what it billed.
 *
 * WHICH RETURN SPENDS THE PURCHASE FIRST (audit v994, DB3). This used to be "by bill id", a random
 * uuid order that knew nothing about what had already been credited. Four housings billed $100;
 * return R1 of all four credited $100 on INV-A; a later return R2 of two, whose uuid happened to
 * sort first, took the whole $100 here, R1 (claimed, so skipped by every caller) took nothing,
 * and the card and the next import offered R2's $50 plus markup on top: $150 back on $100 billed.
 * The claim triggers cannot see it, because R2 is a different bill.
 *
 * So the order is the order the money actually moved:
 *   1. a return already CREDITED on an invoice (`claimed`, the caller's claim set) spends first -
 *      that credit is on paper a customer holds, and nothing computed here can take it back;
 *   2. then the rest by when they were filed (`created_at`), oldest first, so a return filed
 *      tomorrow can never shrink one the office is looking at today;
 *   3. then the bill id, only to break a tie (two bills written in one statement share a stamp).
 * The purchase budgets are laid out by bill id and line id, not in whatever order the caller's
 * query returned them, so the card, the panel and the importer - which all call this over the same
 * job's bills - agree on which return got which cents.
 *
 * A returned line with NO matching purchase on the job (a lump bill, a purchase filed elsewhere,
 * words the scanner read differently) is credited in full, as a return is by default: the app has
 * no purchase to hold it to, and inventing one would be a guess. The person decides from the
 * bill - the same switch that takes a purchase line off takes a return line off.
 *
 * Returns the lines each RETURN bill is credited on, keyed by the bill object passed in; a line
 * the cap touched carries `billed_amount` = what it may credit (the mirror in returnCreditRows
 * reads that exactly as 0272's split, tax share and all). Purchases are not in the map.
 */
export function returnLinesAgainstPurchases<T extends { id?: unknown; amount?: unknown; created_at?: unknown }>(
  bills: readonly T[],
  linesOf: (b: T) => BillLine[] | null | undefined,
  /** Bill ids already on a non-void invoice (the caller's claim set). Optional: without it the
   *  order is filing order alone. */
  claimed?: { has(id: string): boolean } | null,
): Map<T, BillLine[]> {
  const byId = (x: unknown, y: unknown) => String(x ?? "").localeCompare(String(y ?? ""));
  const budgets: { words: string; left: number }[] = [];
  const purchases = bills
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => Number(b.amount) > 0)
    .sort((x, y) => byId(x.b.id, y.b.id) || x.i - y.i);
  for (const { b } of purchases) {
    const lines = (linesOf(b) ?? []).map((l, i) => ({ l, i })).sort((x, y) => byId(x.l.id, y.l.id) || x.i - y.i);
    for (const { l } of lines) {
      if (isTaxLine(l) || !(billLineCost(l) > 0)) continue;
      const words = itemWords(l.description);
      if (words) budgets.push({ words, left: cents(billLineBilledCost(l)) });
    }
  }
  const out = new Map<T, BillLine[]>();
  const filedAt = (b: T) => {
    const t = b.created_at == null ? NaN : Date.parse(String(b.created_at));
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const isClaimed = (b: T) => (claimed && b.id != null ? claimed.has(String(b.id)) : false);
  const returns = bills
    .map((b, i) => ({ b, i, first: isClaimed(b) ? 0 : 1, at: filedAt(b) }))
    .filter(({ b }) => isReturnBill(b.amount))
    .sort((x, y) => x.first - y.first || (x.at === y.at ? 0 : x.at < y.at ? -1 : 1) || byId(x.b.id, y.b.id) || x.i - y.i);
  for (const { b } of returns) {
    const lines = linesOf(b) ?? [];
    const capped = new Map<BillLine, BillLine>();
    const order = [...lines].sort((x, y) => String(x.id).localeCompare(String(y.id)));
    for (const l of order) {
      const cost = billLineCost(l);
      if (isTaxLine(l) || l.billable === false || !(cost < 0)) continue;
      const words = itemWords(l.description);
      const matches = budgets.filter((p) => sameItem(words, p.words));
      if (!matches.length) continue;
      const size = cents(-cost);
      const want = billedPortion(size, l.billed_amount) ?? size;
      const room = cents(matches.reduce((s, p) => s + p.left, 0));
      const allowed = cents(Math.max(0, Math.min(want, room)));
      let take = allowed;
      for (const p of matches) {
        const used = cents(Math.min(p.left, take));
        p.left = cents(p.left - used);
        take = cents(take - used);
      }
      if (l.billed_amount == null && allowed >= size) continue;
      capped.set(l, { ...l, billed_amount: allowed });
    }
    out.set(b, lines.map((l) => capped.get(l) ?? l));
  }
  return out;
}

/**
 * WHAT A RETURN GIVES BACK TO THE CUSTOMER, AT COST - a positive figure, or 0 when nothing on it was
 * ever the customer's. The Unbilled card and the work-to-date panel mark this up per bill exactly
 * as the importer marks up its rows, so the card's figure and the credit the button writes agree.
 * A bill that is not a return gives back nothing.
 */
export function returnCreditCost(amount: unknown, lines: BillLine[] | null | undefined): number {
  if (!isReturnBill(amount)) return 0;
  return billableBillCost(-Number(amount), (lines ?? []).map(mirrored));
}

/**
 * THE CREDIT ROWS FOR ONE RETURN, in order - negative unit prices, positive counts, each row named
 * so the customer can read it: "Returned: 4 in LED Shallow IC HSG", "Returned: tax". An empty array
 * means nothing on this return was billed to the customer (every line switched off, or a container
 * this job was billed none of), so nothing is credited.
 *
 * A line on a return that is NOT a credit - a restocking fee the supplier kept - is a positive row
 * in the mirror's negative, so it comes back here as an ordinary charge with its own description.
 * That is the true cost of sending the part back, and it is the customer's part like the part was.
 */
export function returnCreditRows(bill: BillForItemisation, lines: BillLine[], markup: unknown): BillItemRow[] {
  if (!isReturnBill(bill.amount)) return [];
  const all = lines ?? [];
  const mirror = all.map(mirrored);
  const flipped = billItemisation({ ...bill, amount: cents(-Number(bill.amount)) }, mirror, markup);
  const supplier = String(bill.supplier ?? "").trim() || "the supplier";
  const partKeys = new Set(
    mirror
      .filter((l) => l.billable !== false && billedPortion(billLineCost(l), l.billed_amount) != null)
      .map((l) => `bli:${l.id}`),
  );
  const hasTax = all.some(isTaxLine);
  const lumpKey = `bill:${bill.id}`;
  return flipped.map((r) => {
    // A mirrored row billing money is a credit once it is turned back; one that was itself negative
    // in the mirror (a fee the supplier kept) is a charge and keeps its own words.
    const credit = r.unit_price > 0;
    const unit_price = cents(-r.unit_price) || 0;
    let description = r.description;
    if (r.import_key === remainderKey(bill.id)) {
      description = hasTax ? "Returned: tax" : `Returned: other items — ${supplier}`;
    } else if (r.import_key === lumpKey) {
      description = `Returned: materials — ${supplier}${bill.bill_number ? ` (bill #${bill.bill_number})` : ""}`;
    } else if (credit) {
      const part = partKeys.has(r.import_key);
      const base = part && description.endsWith(PART_USED_SUFFIX) ? description.slice(0, -PART_USED_SUFFIX.length) : description;
      description = `Returned: ${base}${part ? " (the part this job was billed)" : ""}`;
    }
    return { ...r, description: description.slice(0, 300), unit_price };
  });
}

/** What happened to one return on an import, for the sentence below. */
export type ReturnOutcome = {
  supplier: string;
  /** The bill's own amount (negative). */
  amount: number;
  /** What the rows credit the customer, marked up, as a positive figure. 0 = nothing credited. */
  credit: number;
};

/**
 * A CREDIT NEVER TAKES AN INVOICE BELOW ZERO (review of this wave).
 *
 * An invoice that totals less than nothing settles as paid the moment it is sent (paidStatus) and
 * its balance floors at zero (invoiceBalance), so the part of a credit bigger than the invoice it
 * lands on simply disappears - no refund, no account credit, nothing on any screen. "The customer
 * is owed $40 back" would be a promise the app then breaks by itself.
 *
 * So a return lands only on an invoice that bills at least as much as it credits. `base` is what
 * the invoice will carry without any return (its other lines after this import); the returns are
 * taken in the order given while they fit, and the rest are HELD: not written, not claimed, still
 * pending on the Unbilled card for the next invoice that bills more than they do. A net charge (a
 * restocking fee bigger than the part) always fits.
 */
export function returnsThatFit<R extends { billId: string; credit: number }>(base: number, returns: readonly R[]): { land: R[]; held: R[] } {
  let room = cents(Number(base) || 0);
  const land: R[] = [];
  const held: R[] = [];
  for (const r of returns) {
    if (r.credit <= 0 || cents(room - r.credit) >= 0) {
      land.push(r);
      room = cents(room - r.credit);
    } else held.push(r);
  }
  return { land, held };
}

/**
 * THE IMPORT SUMMARY'S WORDS FOR RETURNS - one part per fact, in the office's language.
 *
 *   credited      "a supplier return credited back to the customer: -$59.32"
 *   not credited  "the Consolidated Electrical Dist. return of $51.58 not credited - none of what
 *                  went back was billed to the customer (...)"
 *   held          "the Consolidated Electrical Dist. return ($59.32 back to the customer) held -
 *                  it is more than this invoice bills (...)"
 *
 * `credited` is only what THIS tap put on the invoice: a re-import of a draft that already holds
 * the credit does not say it again, because every other count in the summary is "what this added"
 * and a repeated "credited back" reads as a second credit.
 *
 * The not-credited one is the INV-078 case, said rather than swallowed: the return is a real piece
 * of paper on the job, and an import that neither credits it nor mentions it is a screen that
 * disagrees with what he can see.
 */
export function returnsSummaryParts(credited: ReturnOutcome[], notCredited: ReturnOutcome[], held: ReturnOutcome[] = []): string[] {
  const parts: string[] = [];
  if (credited.length) {
    const total = cents(credited.reduce((s, r) => s + r.credit, 0));
    const n = credited.length;
    parts.push(`${n === 1 ? "a supplier return" : `${n} supplier returns`} credited back to the customer: ${formatCurrency(-total)}`);
  }
  for (const r of notCredited) {
    parts.push(
      `the ${r.supplier} return of ${formatCurrency(Math.abs(r.amount))} not credited — none of what went back was billed to the customer (its lines, or the purchase they came off, are marked as your own cost)`,
    );
  }
  for (const r of held) {
    parts.push(
      `the ${r.supplier} return (${formatCurrency(r.credit)} back to the customer) held — it is more than this invoice bills, and an invoice below zero would settle with the rest of the credit lost; it comes off the next invoice on this job that bills more than it`,
    );
  }
  return parts;
}
