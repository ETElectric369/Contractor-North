import { formatCurrency } from "@/lib/utils";
import {
  PART_USED_SUFFIX,
  billItemisation,
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
 * THE IMPORT SUMMARY'S WORDS FOR RETURNS - one part per fact, in the office's language.
 *
 *   credited      "a supplier return credited back to the customer: -$59.32"
 *   not credited  "the Consolidated Electrical Dist. return of $51.58 not credited - every line on
 *                  it is marked as your own cost, so none of it was the customer's"
 *
 * The second one is the INV-078 case, said rather than swallowed: the return is a real piece
 * of paper on the job, and an import that neither credits it nor mentions it is a screen that
 * disagrees with what he can see.
 */
export function returnsSummaryParts(credited: ReturnOutcome[], notCredited: ReturnOutcome[]): string[] {
  const parts: string[] = [];
  if (credited.length) {
    const total = cents(credited.reduce((s, r) => s + r.credit, 0));
    const n = credited.length;
    parts.push(`${n === 1 ? "a supplier return" : `${n} supplier returns`} credited back to the customer: ${formatCurrency(-total)}`);
  }
  for (const r of notCredited) {
    parts.push(
      `the ${r.supplier} return of ${formatCurrency(Math.abs(r.amount))} not credited — every line on it is marked as your own cost, so none of it was the customer's`,
    );
  }
  return parts;
}
