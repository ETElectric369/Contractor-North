/**
 * A SUPPLIER'S OWN INVOICE LINES, TURNED INTO RECEIPT LINES.
 *
 * Pure, because this is the arithmetic that decides what a customer is charged for a part and it
 * has to be testable without a database. The server action (recordSupplierInvoiceAsBill) does the
 * reading and the writing; everything that could be WRONG about a number happens here.
 *
 * THE EXTENSION IS THE PRICE. CED does not price everything by the piece: beside every price it
 * prints E for each, C for per hundred, M for per thousand. A one-gang decora plate is "50.00 C" -
 * fifty cents. 93 of the 227 lines on Erik's CED invoices are priced per hundred or per thousand,
 * and `bill_line_items` has nowhere to put the letter. Every money path in the app already reads
 * the EXTENSION and treats the unit price as decoration (billLineCost, and learned_prices since
 * 0274), so a line's unit price here is its own extension divided by its own quantity. No divisor
 * is chosen and no letter is trusted: the supplier's arithmetic decides.
 */
import { decideReceiptLine } from "./receipt-billing";

const money = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

const text = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
};

export interface SupplierInvoiceLineIn {
  description?: string | null;
  part_number?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  extension?: unknown;
}

export interface NewBillLine {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  category: string | null;
  billable: boolean;
}

export interface SupplierBillLines {
  lines: NewBillLine[];
  /** What the lines add up to, in cents-safe dollars. */
  lineSum: number;
  /** The lines say MORE than the supplier is charging: something was read wrong. Do not itemise. */
  overshoot: boolean;
  /** The supplier's total minus the lines. Rides in the invoice's supplies-and-tax row. */
  shortfall: number;
}

export function supplierBillLines(
  rows: SupplierInvoiceLineIn[],
  doc: { invoiceNumber: string; tax?: unknown; shipping?: unknown; total?: unknown },
): SupplierBillLines {
  const lines: NewBillLine[] = [];

  for (const l of rows ?? []) {
    const amount = money(l?.extension);
    const qty = Number(l?.quantity) || 0;
    /**
     * Nothing on the line at all is not a row. A BACK-ORDERED one is: CED prints the part, the
     * price it will cost, and zeroes in both the shipped column and the extension, because the
     * delivery was short. Dropping it left him with no record in the app that he is still owed
     * something - so it is kept whenever the supplier put a price or a name on it, and it costs
     * nothing (its extension is zero, and since this wave that is an answer rather than a blank).
     */
    if (!amount && !qty && !money(l?.unit_price) && !text(l?.description) && !text(l?.part_number)) continue;

    const described = text(l?.description) ?? text(l?.part_number) ?? "Materials";
    const part = text(l?.part_number);
    // The part number goes in the description because a receipt line has nowhere else to put it,
    // and it is how two spellings of one part are recognised as the same thing later. It is left
    // out when the supplier already wrote it into the description.
    const description = (
      part && !described.toUpperCase().includes(part.toUpperCase()) ? `${described} (${part})` : described
    ).slice(0, 300);

    /**
     * TWO DECIMALS, BECAUSE THE COLUMN HAS TWO (review, 2026-09-19). This computed four and
     * `bill_line_items.unit_price` is numeric(12,2), so the extra digits were discarded on the way
     * in and the code was describing a precision the database does not keep. Nothing reads this
     * figure for money - billLineCost, billItemisation and learned_prices all work from `amount` -
     * so a 21.67 cent wire nut stored as 22 cents costs nobody anything. The extension is the
     * price; this is how it reads per piece.
     *
     * BOTH GUARDS ARE LOAD-BEARING, and the tests below are what found them.
     *
     * `amount !== 0`: a BACK-ORDERED line carries a real price beside a $0.00 extension. Dividing
     * that extension would teach the price book that the fixture is free. The stated price stands
     * instead - and it is the only case in this function where a per-hundred price can still slip
     * through, because with no extension there is nothing to prove the divisor with. It is also
     * exactly what learned_prices falls back to (0274), so the two agree.
     *
     * `qty !== 0` rather than `qty > 0`: a credit memo carries a NEGATIVE quantity AND a negative
     * price, which multiply back positive. Refusing to divide a negative count would have stored
     * -5 x -$40.87 against a -$204.35 extension: a line whose own arithmetic says +$204.35, on a
     * document that exists to take money off. That sign is the same trap that made the per-unit
     * guard in ced-invoice-parse structurally dead one wave ago.
     */
    const unit_price = amount !== 0 && qty !== 0 ? money(amount / qty) : money(l?.unit_price);

    /**
     * THE ONE DOOR, ASKED THE WAY IT WAS BUILT TO BE ASKED (review, 2026-09-19).
     *
     * This passed "Materials" as the stated category and `true` as the stored flag, which made the
     * door inert: `resolveReceiptLineCategory` only fills in a SHRUG, so a stated category means
     * the food-and-drink rule can never fire, and a stated `true` means `normalizeBillable` can
     * never switch anything off. A wire nut and a twelve pack of BodyArmor came back identical.
     * A supply house is not where snacks come from, which is the only reason that was harmless -
     * and "harmless today" is how the net under the Food & Drink rule got built twice already.
     * The door decides; "Materials" is only what a shrug is called on a supplier invoice.
     */
    const decided = decideReceiptLine(description, null, undefined);
    lines.push({
      description,
      quantity: qty !== 0 ? qty : 1,
      unit_price,
      amount,
      category: decided.category ?? "Materials",
      billable: decided.billable,
    });
  }

  // TAX RIDES WITH WHAT IT TAXES, and the invoice arithmetic finds it by its CATEGORY (0268's
  // isTaxLine is /tax/i on the category). A tax line filed as "Materials" would be itemised and
  // marked up like a part.
  const tax = money(doc?.tax);
  if (tax) {
    lines.push({
      description: `Sales Tax (Invoice ${doc.invoiceNumber})`,
      quantity: 1,
      unit_price: tax,
      amount: tax,
      category: "Tax",
      billable: true,
    });
  }
  /**
   * Freight is a real cost of the customer's materials and passes through like any other line. It
   * is deliberately NOT called tax: it is not taxed proportionally and it is not exempt.
   *
   * KNOWN AND UNFIXED, because no document of his has ever carried one: `excludedReceiptCost`
   * treats every non-tax line as the base the tax was charged on, so a freight line dilutes the
   * share of tax that comes off with an excluded item. On a $400 panel, a $100 box for the shelf,
   * $100 of freight and $41.25 of tax, the box should take 100/500 of the tax ($8.25) and takes
   * 100/600 ($6.88) - $1.37 of tax on shop stock left with the customer. Every CED shipping charge
   * in his account is $0.00. Written down rather than guessed at, because the fix belongs in
   * excludedReceiptCost and needs a real receipt to test against.
   */
  const shipping = money(doc?.shipping);
  if (shipping) {
    lines.push({
      description: `Shipping (Invoice ${doc.invoiceNumber})`,
      quantity: 1,
      unit_price: shipping,
      amount: shipping,
      category: "Freight",
      billable: true,
    });
  }

  const lineSum = lines.reduce((s, l) => money(s + l.amount), 0);
  const total = money(doc?.total);
  const overshoot = lineSum > total + 0.005;
  return { lines, lineSum, overshoot, shortfall: overshoot ? 0 : money(total - lineSum) };
}
