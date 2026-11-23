import { formatCurrency } from "@/lib/utils";
import { shortSupplierName } from "@/lib/supplier-name";
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
 *
 * OR THE SAME CATALOGUE NUMBER (cn-v1186, the owner's papers on J-941). Two readers abbreviate the
 * same part's words differently: the ticket's reader wrote "SIEM MBK125A 125A Riser Main CB Kit" and
 * the return slip says "SIEM MBK125A 125A RISER MAIN CB KT"; "... NM3R SC Enclosure" against
 * "... NM3R SC ENCL". Neither holds the other, so a slip for goods crossed off the ticket was credited
 * in full and the filing door said no line carried its words. The words differ; the NUMBER is the
 * part. So two descriptions also name the same part when each has at least two words, the first word
 * (the maker) is the same, the second word is the same, and that second word is a catalogue number.
 * Exact words, still nothing fuzzy: "MBK125A" is not "MBK200A".
 *
 * A SIZE IS NOT A PART NUMBER (skeptic #88). "Letters and digits, five or more" took "15AMP", "250FT",
 * "12AWG", "100PK" and "4000K" for part numbers, so a 12/2 coil and a 14/2 coil of the same length were
 * one part, and a return of the one was spent against the other. A catalogue number is now:
 *   - digits only, at least 5 ("53890"); or
 *   - letters and digits mixed, at least 7 characters, and NOT a size or a count with its unit or word
 *     after it: not one to four digits followed only by letters ("1000AMP", "4SQUARE", "3PHASE"), and
 *     not digits followed by one to four letters ("10000FT").
 * Anything else, a rating, a schedule, a cable category or a lamp type in second place ("125A", "Q120",
 * "2POLE", "SCH40", "CAT6A", "PAR38", "NEMA3R"), names a kind of part and never one part.
 */
const isCatalogueNumber = (w: string): boolean => {
  if (/^[0-9]+$/.test(w)) return w.length >= 5;
  if (!/[a-z]/.test(w) || !/[0-9]/.test(w)) return false;
  return w.length >= 7 && !/^\d{1,4}[a-z]+$/.test(w) && !/^\d+[a-z]{1,4}$/.test(w);
};

export function sameItem(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.split(" ").length < 2) return false;
  if (` ${long} `.includes(` ${short} `)) return true;
  const [makerA, numberA] = a.split(" ");
  const [makerB, numberB] = b.split(" ");
  return makerA === makerB && numberA === numberB && isCatalogueNumber(numberA);
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
 * A RETURN COMES OFF THE LINE THAT WENT BACK FIRST (cn-v1186, the owner's papers on J-941). A part
 * bought on two lines of one ticket: three kept and billed, five crossed out as returned (0417) and
 * billed to nobody. The slip for the five was held only to what the matching lines billed, and the
 * three that billed were what was left to hold it to: the customer was credited for five parts he was
 * never charged for, and the three he kept came off his bill. So a purchase line marked `returned`
 * whose `returned_credit_bill_id` is still null carries a second size: what of it already LEFT the
 * bill (its cost less what it still bills). A return line spends that size, and is credited nothing
 * for it, ONLY WHEN THE SLIP'S OWN NUMBERS SAY IT IS THAT LINE (skeptic #88):
 *   - the same unit price: both lines carry a quantity that is not zero, and amount / quantity on the
 *     two agree within a cent or half a percent, whichever is larger. A line with no quantity (a price
 *     correction, "price adj") never spends it;
 *   - the whole line: what is left of the return is at least that line's whole size, to the cent. A
 *     slip covers a crossed-out line entirely or leaves it alone; it never spends part of one.
 * The matching lines are tried largest size first (ties in the fixed order below), so the answer does
 * not hang on how the lines were listed. Why so narrow: a slip smaller than the crossed-out line could
 * be part of it, or goods the customer kept, was billed for, and then sent back; the papers cannot say
 * which. Reading it as "already went back" credits the customer nothing for a part he paid for.
 * Reading it the other way can only credit too much, and the filing door settles that. Whatever the
 * return has not spent is held to what the matching lines billed, exactly as above. The same order
 * rules (claimed first, then filing order, then the bill id) decide which return spends a size first.
 *   - A line a filed credit already CLOSED (`returned_credit_bill_id` set) gives no such size: that
 *     credit's own line is off the bill already, and a second slip for the same part must still
 *     reach the lines that billed.
 *   - A line that does not carry the `returned` key at all (a read without 0417's columns) gives no
 *     such size, and the matcher reads exactly as it did before.
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
/** A bill line as the matcher reads it: with 0417's two columns when the caller's read lists them. */
export type ReturnAwareLine = BillLine & { returned?: boolean | null; returned_credit_bill_id?: unknown };

/** What of a purchase line already LEFT the bill as a return nobody's credit has closed yet: its cost
 *  less what it still bills. 0 for a line not marked returned, and for one a filed credit closed. */
function sizeGoneBack(l: ReturnAwareLine): number {
  if (l.returned !== true) return 0;
  const closedBy = l.returned_credit_bill_id;
  if (closedBy != null && String(closedBy).trim() !== "") return 0;
  return cents(Math.max(0, billLineCost(l) - billLineBilledCost(l)));
}

/** A line's price for one, as a size: |amount| / |quantity|. null when it carries no quantity (or 0). */
function unitSize(l: BillLine): number | null {
  const qty = Math.abs(Number(l.quantity));
  if (!Number.isFinite(qty) || qty === 0) return null;
  return Math.abs(billLineCost(l)) / qty;
}

/** Two prices for one agree: within a cent or half a percent, whichever is larger. */
function sameUnitPrice(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.01, 0.005 * Math.max(a, b)) + 1e-9;
}

export function returnLinesAgainstPurchases<T extends { id?: unknown; amount?: unknown; created_at?: unknown }>(
  bills: readonly T[],
  linesOf: (b: T) => ReturnAwareLine[] | null | undefined,
  /** Bill ids already on a non-void invoice (the caller's claim set). Optional: without it the
   *  order is filing order alone. */
  claimed?: { has(id: string): boolean } | null,
): Map<T, BillLine[]> {
  const byId = (x: unknown, y: unknown) => String(x ?? "").localeCompare(String(y ?? ""));
  /** `left`: what the line still bills, to hold a return to. `back`: what of it already went back
   *  (sizeGoneBack), spent first and credited nothing. */
  const budgets: { words: string; left: number; back: number; unit: number | null }[] = [];
  const purchases = bills
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => Number(b.amount) > 0)
    .sort((x, y) => byId(x.b.id, y.b.id) || x.i - y.i);
  for (const { b } of purchases) {
    const lines = (linesOf(b) ?? []).map((l, i) => ({ l, i })).sort((x, y) => byId(x.l.id, y.l.id) || x.i - y.i);
    for (const { l } of lines) {
      if (isTaxLine(l) || !(billLineCost(l) > 0)) continue;
      const words = itemWords(l.description);
      if (words) budgets.push({ words, left: cents(billLineBilledCost(l)), back: sizeGoneBack(l), unit: unitSize(l) });
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
      // What already went back on a matching purchase line is spent first and credits nothing, but only
      // a WHOLE line at the SAME unit price, largest first (see the header: a slip smaller than the
      // crossed-out line may be goods the customer kept and paid for).
      let spent = 0;
      const unit = unitSize(l);
      if (unit != null) {
        const sizes = matches
          .filter((p) => p.back > 0 && p.unit != null && sameUnitPrice(p.unit, unit))
          .sort((x, y) => y.back - x.back);
        for (const p of sizes) {
          if (Math.round((size - spent) * 100) < Math.round(p.back * 100)) continue;
          spent = cents(spent + p.back);
          p.back = 0;
        }
      }
      // Only what is left of the return is held to what the matching lines billed, as before.
      const want = Math.min(billedPortion(size, l.billed_amount) ?? size, cents(size - spent));
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

/* ════════════════════════════════════════════════════════════════════════════════════════════
   A RETURN FILED TO THE SHELF (Shop Stock, Phase 4; migration 0350).

   Everything above is a return on a JOB: the pieces were the customer's, so what went back is
   credited to the customer. Shelf stock is the other case. The pieces were never any customer's:
   they sat on the shelf at what they cost the company (a lot, 0303). When they go back to CED:
     · a supplier_return move lowers the roll by what those pieces cost (the database stamps it);
     · CED's credit memo is filed to the SHELF (bills.on_shelf, no job) and tied to that move, so no
       job's materials import can ever read it, and no customer is ever credited for it;
     · what the pieces cost minus what CED gave back is written off (Stock Lost), and said.
   The functions below are the words and the arithmetic for that. They match the return to the
   roll it came off, never to a job.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** A supplier's credit filed to the shop shelf: below $0, on no job, and on the shelf. The one kind
 *  of return that never reaches a customer's invoice. */
export function isShelfCredit(bill: { amount?: unknown; job_id?: unknown; on_shelf?: unknown } | null | undefined): boolean {
  return !!bill && isReturnBill(bill.amount) && !bill.job_id && bill.on_shelf === true;
}

/** A credit a shelf return may be tied to: a credit on no job, not set aside (one already on the
 *  shelf, or one with no job that the return files there). A credit filed on a JOB is never offered:
 *  it would come off that job's customer bill. */
export function canTieToShelfReturn(bill: { amount?: unknown; job_id?: unknown; superseded_by_bill_id?: unknown } | null | undefined): boolean {
  return !!bill && isReturnBill(bill.amount) && !bill.job_id && !bill.superseded_by_bill_id;
}

/** "Return to CED": the supplier named on the roll's ticket, said short (shortSupplierName), for
 *  every supplier; "Return to Supplier" for a roll with no supplier on it (Wave 0: a name regex
 *  hard-coded one supplier and folded a different company into it). */
export function returnDoorLabel(supplier: string | null | undefined): string {
  const name = String(supplier ?? "").trim();
  return name ? `Return to ${shortSupplierName(name)}` : "Return to Supplier";
}

export type ShelfReturnMoney = {
  /** What the pieces going back cost off the roll (with any earlier returns tied to the same credit). */
  cost: number;
  /** What the supplier's credit gives back, as a positive figure (0 with no credit tied). */
  credit: number;
  /** cost - credit: written off as Stock Lost. Below 0 when the supplier gave back more. */
  lost: number;
  /** The sentence the office reads, before and after. */
  words: string;
};

/**
 * WHAT A RETURN FROM THE SHELF COMES TO. `cost` is what these pieces cost off the roll (the
 * database stamps it: pieces x the roll's cost per piece, or the roll's exact remainder when it
 * empties it). `creditAmount` is the tied credit bill's amount (negative, as it is stored), or null
 * with none tied. `otherReturnsCost` is what earlier returns already tied to the same credit cost:
 * one CED memo can cover two rolls, and the difference is the memo's, not each roll's.
 */
export function shelfReturnMoney(input: {
  qty: number;
  unit: string;
  supplier?: string | null;
  cost: number;
  creditAmount: number | null;
  otherReturnsCost?: number;
}): ShelfReturnMoney {
  const who = String(input.supplier ?? "").trim() ? shortSupplierName(input.supplier) : "the supplier";
  const qty = Math.round(Number(input.qty) * 1000) / 1000;
  const unit = String(input.unit ?? "").trim();
  const own = cents(Number(input.cost) || 0);
  const others = cents(Number(input.otherReturnsCost) || 0);
  const tail = " No customer is credited for it.";
  if (input.creditAmount == null) {
    return {
      cost: own,
      credit: 0,
      lost: own,
      words: `${qty} ${unit} went back to ${who}. They cost ${formatCurrency(own)} off the roll, and no credit from ${who} is tied to them, so ${formatCurrency(own)} is written off as Stock Lost.${tail}`,
    };
  }
  const cost = cents(own + others);
  const credit = cents(Math.abs(Number(input.creditAmount) || 0));
  const lost = cents(cost - credit);
  const what = others > 0 ? `these and the pieces already returned on it cost ${formatCurrency(cost)}` : `they cost ${formatCurrency(cost)} off the roll`;
  const head = `${qty} ${unit} went back to ${who}. ${who}'s credit gives back ${formatCurrency(credit)}, and ${what}`;
  const words =
    lost > 0
      ? `${head}, so the ${formatCurrency(lost)} difference is written off as Stock Lost.${tail}`
      : lost < 0
        ? `${head}, so ${who} gave back ${formatCurrency(-lost)} more than they cost. That counts as money back.${tail}`
        : `${head}, so nothing is written off.${tail}`;
  return { cost, credit, lost, words };
}
