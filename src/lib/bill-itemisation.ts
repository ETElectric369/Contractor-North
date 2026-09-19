/**
 * HOW MUCH OF A SUPPLIER BILL THE CUSTOMER PAYS — THE ARITHMETIC, ON ITS OWN.
 *
 * Lifted out of billing/actions.ts (cn-v952) for two reasons, and the second is the real one.
 *
 * The first is testability: a "use server" module may only export async server actions, so the
 * single piece of code that decides what a customer is charged for a Home Depot run could never
 * be asserted on directly. It is now.
 *
 * The second is Erik's receipt, 2026-09-18. One trip puts the panel, the wire, the drill bit, the
 * gloves and the Smartwater on ONE piece of paper, and the importer billed all of it. The only
 * thing it held back from the ITEMISED lines was tax — and tax is still charged, because it lands
 * inside the per-bill "Supplies & tax" remainder row. That remainder row exists to make the anchor
 * invariant true (a bill's rows sum to exactly the marked-up bill total), which means that before
 * migration 0268 there was no way to leave a line OFF a customer's invoice at all: filtering it out
 * of the itemisation only moved its money into the lump. His customer paid for a bottle of water,
 * a BodyArmor, a ten cent bottle deposit and a pair of gloves on INV-069.
 *
 * The cost of that was bigger than eight dollars — he stopped scanning receipts to avoid it ("i
 * have another receipt that i didnt scan specifically because it was mostly snacks and a $3
 * part"), so the $3 part never became a job cost either. The app was teaching him to keep worse
 * books.
 *
 * `billable = false` is therefore TWO exclusions, not one: the line is kept out of the itemisation
 * AND its marked-up money is taken off the target the remainder row trues up to, so the remainder
 * cannot re-bill it. "Not itemised" and "not billed" are different ideas and this column is only
 * the second one — TAX IS UNTOUCHED and still passes through in the remainder, because sales tax
 * paid on the customer's own materials is a real cost of their job.
 */

/** A row this file hands back for the invoice. (Structurally the importer's ImportRow, minus the
 *  claim: WHICH bill a row claims is the caller's business, not the arithmetic's.) */
export type BillItemRow = {
  import_key: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

/** One line off a scanned receipt. Everything is loosely typed because it arrives straight from
 *  PostgREST, where a numeric column is a string and an old row's `billable` may be undefined. */
export type BillLine = {
  id: string | number;
  description?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  amount?: unknown;
  category?: string | null;
  billable?: boolean | null;
};

/** The bill itself — its amount is the anchor everything else trues up to. */
export type BillForItemisation = {
  id: string | number;
  supplier?: string | null;
  bill_number?: string | null;
  amount?: unknown;
};

/**
 * What a line actually cost, as the importer has always read it: the stored `amount` when the
 * receipt reader captured one, otherwise unit × qty (with a bare unit price counting as one).
 *
 * Exported because the SAME reading has to serve both sides of the new subtraction. If the sum
 * that comes off the target were computed any differently from the sell price the line would have
 * carried, the remainder row would silently absorb the difference — which is precisely the leak
 * 0268 exists to close, rebuilt one layer down.
 */
export function billLineCost(l: BillLine): number {
  const qty = Number(l.quantity) || 0;
  return l.amount != null && Number(l.amount) !== 0 && !isNaN(Number(l.amount))
    ? Number(l.amount)
    : (Number(l.unit_price) || 0) * (qty || 1);
}

/**
 * ── THE ANCHOR INVARIANT (adversarial-review fix, 7/24; amended for 0268) ─────────────────────
 * A bill's rows sum to EXACTLY the marked-up BILLABLE total — mark(bill.amount) before 0268, and
 * mark(bill.amount − the cost of every line marked not billable) now. That is the same figure the
 * lump path bills and the same one livePurchaseOrders' PO-supersede math subtracts. Itemisation
 * changes PRESENTATION, never the total. Mechanically:
 *  • line sell = round(signed line AMOUNT × (1+m)) — never per-unit rounding × qty (a 1000-count
 *    $25 line billed $30 that way). qty×unit renders whenever the rounded unit lands within
 *    pennies of the sell — the per-bill remainder row (which exists to absorb tax + rounding)
 *    trues up the cents, so the INVARIANT still holds while the customer sees "6 ea × $43.54"
 *    instead of a count buried in the description. Erik was hand-splitting "(N ea)" bundles line
 *    by line ("no per item price which is exactly what i need"); only a pathological split (drift
 *    past the cap, or a sub-cent unit) still folds the qty into the description.
 *  • negatives (discounts/returns) stay negative rows — dropping or abs()ing them overbilled
 *    above the bill's net.
 *  • receipt tax lines aren't itemised as fake marked-up "Sales Tax" rows; they land in the
 *    per-bill remainder row ("Supplies & tax"), same opacity as the lump always had.
 *  • the remainder row absorbs tax + rounding + unreadable/unpriced lines, so a bill whose lines
 *    are junk still bills its full amount (never $0), and a corrected bill.amount always wins
 *    over stale lines.
 *  • lines marked NOT BILLABLE are subtracted from the target before any of that, so there is no
 *    lump left for them to hide in.
 *
 * Returns the rows for ONE bill, in order. An empty array means this bill has nothing to charge
 * the customer for — every line on it was the company's own cost.
 */
export function billItemisation(
  bill: BillForItemisation,
  allLines: BillLine[],
  markup: unknown,
): BillItemRow[] {
  const rate = 1 + (Number(markup) || 0) / 100;
  const mark = (cost: number) => Math.round(cost * rate * 100) / 100;

  // Snacks, a tool bought for the truck, anything on the receipt that is not the customer's. The
  // sum comes off the BILL before markup so there is one rounding, not two, and the rows below
  // still land on the cent.
  const isTaxLine = (l: BillLine) => /tax/i.test(String(l.category ?? ""));
  const sumCost = (ls: BillLine[]) => ls.reduce((sum, l) => Math.round((sum + billLineCost(l)) * 100) / 100, 0);
  const purchased = allLines.filter((l) => !isTaxLine(l));
  const excludedPurchased = purchased.filter((l) => l.billable === false);
  const purchasedCost = sumCost(purchased);
  const excludedPurchasedCost = sumCost(excludedPurchased);

  /**
   * TAX RIDES WITH WHAT IT TAXES (review of this wave, 2026-09-18).
   *
   * Sales tax on the customer's materials is a real cost of their job and passes through — that
   * is why tax has never been itemised but has always been billed, inside the remainder row. Tax
   * on the company's OWN snacks is not. Leaving the whole tax line in the target rebuilt the leak
   * one layer down: Erik's skipped receipt, $5.50 of snacks with $0.40 of tax, every purchased
   * line switched off, still billed his customer 48 cents under a row that said "Materials".
   *
   * A receipt never says which cents of tax belong to which item, so the honest reading is the
   * proportional one: the share of the purchase that was the company's own takes the same share
   * of the tax with it. An all-snacks receipt therefore takes ALL of its tax off and bills
   * nothing; a Home Depot run with one BodyArmor on it takes a few cents off and bills the rest,
   * unchanged to the customer. A tax line somebody switched off by hand is simply gone in full —
   * they said what they meant.
   */
  const taxLines = allLines.filter(isTaxLine);
  const excludedTaxDirect = sumCost(taxLines.filter((l) => l.billable === false));
  const sharedTax = sumCost(taxLines.filter((l) => l.billable !== false));
  const excludedShare = purchasedCost > 0 ? excludedPurchasedCost / purchasedCost : 0;
  const excludedTaxShare = Math.round(sharedTax * excludedShare * 100) / 100;

  const excludedCost = Math.round((excludedPurchasedCost + excludedTaxDirect + excludedTaxShare) * 100) / 100;
  const target = mark(Number(bill.amount) - excludedCost);
  // The whole receipt was the company's own (Erik's "mostly snacks and a $3 part", with the part
  // flipped off too). There is nothing to put in front of the customer, and a $0 or negative
  // "Materials" row on their invoice would be worse than no row at all. The bill still counts as
  // a job cost — that reads bills.amount and never comes through here.
  if (excludedCost > 0 && !(target > 0)) return [];

  const lines = allLines.filter((l) => l.billable !== false && !/tax/i.test(String(l.category ?? "")));
  const billRows: BillItemRow[] = [];
  let emitted = 0;
  for (const l of lines) {
    const qty = Number(l.quantity) || 0;
    const rawAmt = billLineCost(l);
    if (!rawAmt) continue; // unpriced line → its cost stays in the remainder row
    const sell = Math.round(rawAmt * rate * 100) / 100;
    if (!sell) continue;
    const desc = String(l.description || "Materials").slice(0, 300);
    const unitExact = qty > 0 ? Math.round((sell / qty) * 100) / 100 : sell;
    // What qty × rounded-unit actually bills — within pennies of the sell it's the honest
    // presentation and the remainder row eats the difference; past the cap (huge counts of
    // sub-cent parts) the qty still folds into the description to protect the total.
    const split = Math.round(unitExact * qty * 100) / 100;
    if (qty > 0 && Number.isInteger(qty) && unitExact !== 0 && Math.abs(split - sell) <= 0.5) {
      billRows.push({ import_key: `bli:${l.id}`, description: desc, quantity: qty, unit: "ea", unit_price: unitExact });
      emitted = Math.round((emitted + split) * 100) / 100;
    } else {
      billRows.push({ import_key: `bli:${l.id}`, description: qty > 1 ? `${desc} (${qty} ea)` : desc, quantity: 1, unit: "ea", unit_price: sell });
      emitted = Math.round((emitted + sell) * 100) / 100;
    }
  }

  // A bill with no readable lines (hand-entered, or a receipt whose lines are junk) still bills
  // its full billable amount as the one opaque lump it always was.
  //
  // BUT NOT WHEN THE LINES WERE READ AND EVERY ONE OF THEM CAME OFF (review of this wave). The
  // lump is the answer to "we could not itemise this", never to "there is nothing here for the
  // customer". Gated on billRows alone it fired for the all-snacks receipt and billed a lump
  // labelled "Materials" for the residue — the same silent charge under a new name, in the code
  // written to end it. If something on this receipt was still billable, an empty itemisation
  // really does mean unreadable, and the lump is right.
  if (!billRows.length) {
    if (purchased.length > 0 && !purchased.some((l) => l.billable !== false)) return [];
    return [{
      import_key: `bill:${bill.id}`,
      description: `Materials — ${bill.supplier}${bill.bill_number ? ` (bill #${bill.bill_number})` : ""}`,
      quantity: 1,
      unit: "lot",
      unit_price: target,
    }];
  }
  const remainder = Math.round((target - emitted) * 100) / 100;
  if (Math.abs(remainder) >= 0.01) {
    billRows.push({ import_key: `bill:${bill.id}:remainder`, description: `Supplies & tax — ${bill.supplier}`, quantity: 1, unit: "ea", unit_price: remainder });
  }
  return billRows;
}
