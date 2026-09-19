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
 *
 * ── THE THIRD STATE: A CONTAINER BOUGHT WHOLE AND USED IN PIECES (Erik, 2026-09-19; 0272) ─────
 * Reading his own invoice he stopped on a line:
 *
 *   "the Twister box i was confused about and i remebered that is a whole ccontainer of wire nuts
 *    that we uses some of but is certainly stock and shouldnt be charged to the customer in full
 *    however necessary for the job"
 *
 * IDEAL 30641, 500 Twister wire nuts, $108.36 — 21.7 cents each. The customer was billed $135.00
 * for the whole box. The same receipt carries an eight ounce jar of anti-oxidant at $20.65, used a
 * dab at a time. Neither line is a snack and neither belongs to one job, so the boolean had no
 * answer for them: billed meant the whole box, not billed meant he ate a cost his customer really
 * did incur. He worked around it by hand — sixty nuts at twenty-seven cents typed onto the invoice,
 * the jar line deleted — which is rewriting his own books to get past the app.
 *
 * `billed_amount` is the same idea as the boolean with a number instead: bill X, and take
 * (cost − X) off the target, PROPORTIONAL TAX AND ALL. That last clause is the whole trick. The
 * boolean's own tax leak was found one layer down once already (the all-snacks receipt that still
 * billed 48 cents of sales tax under a row saying "Materials"), and a partial line rebuilds it
 * exactly if the tax rides on the full line while only part of the line is billed. So there is one
 * reading of "what this line bills" — billLineBilledCost — and both the itemisation and the
 * subtraction are written in terms of it. They cannot drift apart because there is nothing to
 * drift.
 *
 * `is_stock` is deliberately NOT read here. It is the classification (this went on the shelf); the
 * money is `billed_amount` and nothing else. Two columns that both mean money is precisely how two
 * screens end up disagreeing about the same dollar, which is the bug this whole wave came from.
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
  /** Dollars of this line THIS job takes, when only part of it was the customer's (0272). Null —
   *  and every row written before 0272 — means the whole line, unchanged. */
  billed_amount?: unknown;
  /** Shop stock: the container went on the shelf. A label, never money — see the file header. */
  is_stock?: boolean | null;
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
 * HOW MUCH OF A LINE THE CUSTOMER PAYS FOR, when only part of it was theirs.
 *
 * Returns null for "the whole line" — the answer for every row written before 0272 and for every
 * row nobody has split since, so the default is exactly the behaviour of the minute before this
 * shipped. A number is Erik saying "this job used this much of it".
 *
 * THREE REFUSALS, EACH ONE A FIGURE THIS APP WILL NOT INVENT:
 *  • a negative or unreadable stored value reads as "the whole line", never as zero. Zero is a
 *    real decision (the container went on the shelf and this job used none of it); junk is not a
 *    decision at all, and reading it as one would quietly stop billing a line nobody touched.
 *  • it is clamped to the line's own cost. Migration 0272 has a CHECK that says the same thing,
 *    and it is said twice on purpose: a constraint protects the table, this protects the customer
 *    from a row that got in before the constraint did.
 *  • a zero or negative line cost (a return, a discount, an unpriced line) ignores the split
 *    entirely. Splitting a credit is not a thing anyone has asked for, and "half of minus nine
 *    dollars" is an invented number wearing arithmetic's clothes.
 */
export function billedPortion(lineCost: number, rawBilledAmount: unknown): number | null {
  if (rawBilledAmount == null || !(lineCost > 0)) return null;
  // An empty string is PostgREST handing back a blank, not a person typing zero. Number("") is 0,
  // which would read a blank as the decision "this job used none of it" and stop billing a line
  // nobody touched — the silent direction, so it is spelled out rather than left to coercion.
  if (typeof rawBilledAmount === "string" && rawBilledAmount.trim() === "") return null;
  const n = Number(rawBilledAmount);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n * 100) / 100, Math.round(lineCost * 100) / 100);
}

/**
 * THE ONE READING OF "WHAT THIS LINE BILLS", in dollars of cost. Both halves of the subtraction
 * are written in terms of this — what goes onto the invoice, and what comes off the target the
 * remainder row trues up to — for the same reason billLineCost is shared: two readings of one
 * figure is how the remainder row silently absorbs a difference, which is the leak 0268 closed
 * and the one a partial line would have reopened.
 */
export function billLineBilledCost(l: BillLine): number {
  if (l.billable === false) return 0;
  const cost = billLineCost(l);
  const part = billedPortion(cost, l.billed_amount);
  return part == null ? cost : part;
}

/**
 * Does this line still put ANY money in front of the customer? A person switched it off, or a
 * person said this job used none of the container — either way it is the company's own.
 *
 * An unpriced line (cost 0) is not "off": nobody decided anything about it, its money is simply
 * unreadable, and the remainder row is where unreadable money has always lived. That distinction
 * is what keeps a hand-entered bill billing its lump instead of vanishing.
 */
function stillBills(l: BillLine): boolean {
  return l.billable !== false && billedPortion(billLineCost(l), l.billed_amount) !== 0;
}

/**
 * ── THE ANCHOR INVARIANT (adversarial-review fix, 7/24; amended for 0268 and 0272) ────────────
 * A bill's rows sum to EXACTLY the marked-up BILLABLE total — mark(bill.amount) before 0268, and
 * mark(bill.amount − everything this receipt does not bill) now, where "does not bill" is a line
 * switched off, the shelf's share of a container split by 0272, and the proportional tax on both. That is the same figure the
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
 *    lump left for them to hide in. A line billed IN PART (0272) is the same subtraction with a
 *    number instead of a boolean: bill X, take (cost − X) and its share of the tax off the target,
 *    and emit one row for the part the job used rather than a count nobody typed.
 *
 * Returns the rows for ONE bill, in order. An empty array means this bill has nothing to charge
 * the customer for — every line on it was the company's own cost.
 */
const isTaxLine = (l: BillLine) => /tax/i.test(String(l.category ?? ""));
const sumBy = (ls: BillLine[], f: (l: BillLine) => number) =>
  ls.reduce((sum, l) => Math.round((sum + f(l)) * 100) / 100, 0);
/** What a line does NOT bill: the whole thing when it is switched off, the shelf's share of a
 *  container when only part of it was this job's. One expression, both states. */
const notBilledCost = (l: BillLine) => Math.round((billLineCost(l) - billLineBilledCost(l)) * 100) / 100;

/**
 * HOW MUCH OF A RECEIPT THE CUSTOMER DOES NOT PAY FOR — ONE READING, TWO SCREENS.
 *
 * Exported because the Bills card and the invoice importer were computing it differently and
 * disagreeing by exactly the tax share (review of cn-v964). On the wave's own fixture - a $139.65
 * receipt with the Twister box split to $13.00 - the card said $44.29 was coming off and the
 * invoice took $36.43. A $7.86 gap between what a screen promises and what the money does is the
 * INV-069 shape again: he is told he is wrong about his own receipt.
 *
 * The tax clause is the part that has to be shared, not the subtraction. Tax on the customer's
 * materials passes through; tax on the company's snacks does not; and four fifths of a box left on
 * the shelf takes four fifths of the tax charged on that box with it. A receipt never says which
 * cents of tax belong to which item, so the honest reading is proportional - and it has now been
 * got wrong once per layer, which is why there is exactly one copy of it.
 */
export function excludedReceiptCost(allLines: BillLine[]): number {
  const purchased = allLines.filter((l) => !isTaxLine(l));
  const purchasedCost = sumBy(purchased, billLineCost);
  const excludedPurchasedCost = sumBy(purchased, notBilledCost);
  const taxLines = allLines.filter(isTaxLine);
  const excludedTaxDirect = sumBy(taxLines, notBilledCost);
  const sharedTax = sumBy(taxLines, billLineBilledCost);
  const excludedShare = purchasedCost > 0 ? excludedPurchasedCost / purchasedCost : 0;
  const excludedTaxShare = Math.round(sharedTax * excludedShare * 100) / 100;
  return Math.round((excludedPurchasedCost + excludedTaxDirect + excludedTaxShare) * 100) / 100;
}

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
  const purchased = allLines.filter((l) => !isTaxLine(l));

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
   * of the tax with it. A PARTIAL line is the same sentence with a number in it (0272): four
   * fifths of a box of wire nuts stayed on the shelf, so four fifths of the tax charged on that
   * box did too. Leaving the tax whole while billing a fifth of the line would rebuild the leak
   * one layer down for the third time. An all-snacks receipt therefore takes ALL of its tax off and bills
   * nothing; a Home Depot run with one BodyArmor on it takes a few cents off and bills the rest,
   * unchanged to the customer. A tax line somebody switched off by hand is simply gone in full —
   * they said what they meant.
   */
  const excludedCost = excludedReceiptCost(allLines);
  const target = mark(Number(bill.amount) - excludedCost);
  // The whole receipt was the company's own (Erik's "mostly snacks and a $3 part", with the part
  // flipped off too). There is nothing to put in front of the customer, and a $0 or negative
  // "Materials" row on their invoice would be worse than no row at all. The bill still counts as
  // a job cost — that reads bills.amount and never comes through here.
  if (excludedCost > 0 && !(target > 0)) return [];

  const lines = allLines.filter((l) => stillBills(l) && !isTaxLine(l));
  const billRows: BillItemRow[] = [];
  let emitted = 0;
  for (const l of lines) {
    const qty = Number(l.quantity) || 0;
    const fullCost = billLineCost(l);
    const part = billedPortion(fullCost, l.billed_amount);
    const rawAmt = part == null ? fullCost : part;
    if (!rawAmt) continue; // unpriced line → its cost stays in the remainder row
    const sell = Math.round(rawAmt * rate * 100) / 100;
    if (!sell) continue;
    const desc = String(l.description || "Materials").slice(0, 300);
    /**
     * A PARTIAL LINE BILLS ONE ROW, NOT A COUNT — and this is a refusal, not a shortcut.
     *
     * The qty × unit presentation below is the one Erik asked for by name ("no per item price
     * which is exactly what i need"), and the obvious move is to render "60 ea × $0.27" here.
     * The app does not know the 60. What 0272 stores is DOLLARS; the container count lives with
     * the stock item, and reconstructing a count by dividing the dollars by a per-unit price
     * would put a number on a customer's invoice that nobody typed — $13.00 ÷ 21.672 cents is
     * 59.99, and rounding that to "60 nuts" is exactly the kind of invented figure this app does
     * not print. So the row says what is true: this is the part of that container the job used.
     */
    if (part != null) {
      billRows.push({ import_key: `bli:${l.id}`, description: `${desc} (what this job used)`, quantity: 1, unit: "ea", unit_price: sell });
      emitted = Math.round((emitted + sell) * 100) / 100;
      continue;
    }
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
    if (purchased.length > 0 && !purchased.some(stillBills)) return [];
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
