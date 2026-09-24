import { formatCurrency } from "@/lib/utils";

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
 * What a line actually cost: the stored `amount` — the supplier's own extension — and only when
 * there is no extension at all, unit × qty (a bare unit price counting as one).
 *
 * Exported because the SAME reading has to serve both sides of the subtraction. If the sum that
 * comes off the target were computed any differently from the sell price the line would have
 * carried, the remainder row would silently absorb the difference — which is precisely the leak
 * 0268 exists to close, rebuilt one layer down.
 *
 * $0.00 IS AN ANSWER, NOT A BLANK (review, 2026-09-19). This used to read an explicit zero the
 * same as a missing one and fall through to unit × qty, and a supply house prints exactly that
 * shape: a BACK-ORDERED line carries the price of the part beside an extension of $0.00, because
 * nothing shipped. On his 85 Whitney receipt that is a $38.98 luminaire; on the next CED invoice
 * with a back-ordered plate it is "50.00" per HUNDRED × 5, and this function returned $250.00 of
 * cost for merchandise that never left the counter. Itemised, that put a $312.50 row on a
 * customer's invoice and drove the supplies-and-tax row NEGATIVE to keep the total honest; switched
 * off as "not the customer's", it took $250 off a receipt that never held it and billed the job's
 * real $202.35 of chargers at nothing at all.
 *
 * `amount` is not null in the database, so the fallback now only answers a row that reaches here
 * from somewhere other than a stored bill line. That is the right shape either way: an extension
 * of zero means the line cost zero, and every other reading of it was a guess.
 */
export function billLineCost(l: BillLine): number {
  const qty = Number(l.quantity) || 0;
  return l.amount != null && !isNaN(Number(l.amount))
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
/** A receipt's tax line, by its category. Exported so a supplier return names its tax share with
 *  the same test the purchase side uses to keep tax out of the itemisation. */
export const isTaxLine = (l: BillLine) => /tax/i.test(String(l.category ?? ""));
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
  /**
   * A TAX LINE A PERSON HAS ACTED ON IS ALREADY EXACT (review of cn-v966).
   *
   * Nothing stops him from tapping "Bill Only What This Job Used" on the Sales Tax row itself -
   * the card renders the same switch and the same modal on every line - and when he does, he has
   * said what he means: bill the customer this much of this tax. That is the rule the boolean has
   * always had ("a tax line somebody switched off by hand is simply gone in full").
   *
   * Only tax NOBODY has touched carries the proportional share of the purchased lines that came
   * off. Otherwise the same dollars are cut twice by two independent mechanisms: split the Twister
   * box to $13 and type $2.00 on the tax line, and the $2 he typed reaches the customer as about
   * 52 cents, because the box's 74% is applied a second time to a figure that was already his
   * decision. A number he did not choose, on a screen that never shows it.
   *
   * For an untouched line billLineCost === billLineBilledCost, so every receipt in his books today
   * bills the identical cent; only the hand-split case moves.
   */
  const untouchedTax = taxLines.filter(
    (l) => l.billable !== false && billedPortion(billLineCost(l), l.billed_amount) == null,
  );
  const sharedTax = sumBy(untouchedTax, billLineCost);
  const excludedShare = purchasedCost > 0 ? excludedPurchasedCost / purchasedCost : 0;
  const excludedTaxShare = Math.round(sharedTax * excludedShare * 100) / 100;
  return Math.round((excludedPurchasedCost + excludedTaxDirect + excludedTaxShare) * 100) / 100;
}

/**
 * WHAT A RECEIPT PUTS IN FRONT OF THE CUSTOMER, AT COST - the figure every panel that promises to
 * equal the invoice has to sum (review of cn-v966).
 *
 * 0268 and 0272 made a receipt's TOTAL stop being the answer to "what will this bill". The
 * importer has known that since cn-v964; the Unbilled card and the work-to-date panel did not, and
 * they both say in their own headers that their figure is the figure a draft built from them will
 * carry. On Erik's OSH run for Jason Waldow that promise was off by his own ice cream bar with 25%
 * on top: the card said $20.35 of unbilled material, the button that bills it wrote $8.13, and the
 * $12.22 in between was presented to him as money a customer owed.
 *
 * So this is billItemisation's own two answers to "is there anything here for the customer",
 * hoisted out and shared, rather than a second arithmetic that can drift from it:
 *   - every purchased line came off (all snacks, the container that went on the shelf) -> nothing,
 *     the same empty itemisation the importer produces, residue on the bill and all;
 *   - otherwise the bill less what a person took off it, tax share included, floored at zero.
 * A bill with NO lines (hand-entered, or a scan that read nothing) is its lump, unchanged.
 */
export function billableBillCost(amount: unknown, lines: BillLine[] | null | undefined): number {
  const amt = Number(amount) || 0;
  const all = lines ?? [];
  const purchased = all.filter((l) => !isTaxLine(l));
  if (purchased.length > 0 && !purchased.some(stillBills)) return 0;
  const net = Math.round((amt - excludedReceiptCost(all)) * 100) / 100;
  return net > 0 ? net : 0;
}

/** The words on a row that bills only part of a line (0272). Exported so a supplier RETURN of
 *  that same container can say the credit is only the part this job was billed, in its own words,
 *  without a second copy of the phrase to drift from this one. */
export const PART_USED_SUFFIX = " (what this job used)";

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
      billRows.push({ import_key: `bli:${l.id}`, description: `${desc}${PART_USED_SUFFIX}`, quantity: 1, unit: "ea", unit_price: sell });
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
  const lump = (): BillItemRow[] => [{
    import_key: `bill:${bill.id}`,
    description: `Materials — ${bill.supplier}${bill.bill_number ? ` (bill #${bill.bill_number})` : ""}`,
    quantity: 1,
    unit: "lot",
    unit_price: target,
  }];

  if (!billRows.length) {
    if (purchased.length > 0 && !purchased.some(stillBills)) return [];
    return lump();
  }
  const remainder = Math.round((target - emitted) * 100) / 100;

  /**
   * LINES THAT ADD UP TO MORE THAN THE RECEIPT ARE NOT AN ITEMISATION (review, 2026-09-19).
   *
   * A negative remainder means the rows above already bill more than the whole piece of paper, and
   * the row below was keeping the TOTAL honest by putting a credit on a customer's invoice:
   * "Supplies & tax — Consolidated Electrical Distributors, Inc. (CED)   1 ea × -$40.28". The
   * total was right and the page was unreadable, and the first question it invites is one Erik
   * cannot answer from the screen.
   *
   * It happens when a scan reads two documents as one. His Tao Zhu receipt carries twenty-one
   * lines, $1,676.16 of them, against the $1,513.71 of a single CED invoice - the other $162.45 is
   * invoice 8802-1101363, in the same PDF, read into the same bill. The lines are not wrong about
   * what was bought; they are wrong about which paper they belong to, and no arithmetic here can
   * tell which. So it falls back to the answer this function already has for "we could not itemise
   * this": one row, the whole billable amount, the same total the customer would have paid anyway.
   */
  if (remainder <= -0.01) return lump();

  if (remainder >= 0.01) {
    billRows.push({ import_key: remainderKey(bill.id), description: `Supplies & tax — ${bill.supplier}`, quantity: 1, unit: "ea", unit_price: remainder });
  }
  return billRows;
}

/** The key of a bill's "Supplies & tax" row. One spelling, shared with the check below. */
export function remainderKey(billId: string | number): string {
  return `bill:${billId}:remainder`;
}

/** A bill whose hand-edited "Supplies & tax" row no longer matches its re-priced parts. */
export type EditedRemainderDrift = {
  billId: string;
  supplier: string;
  /** What the edited row bills now, which the importer never touches. */
  kept: number;
  /** What billItemisation says the row is at this markup ($0 when it no longer makes one). */
  computed: number;
  /** The bill is a supplier RETURN, so the row is its credit row ("Returned: tax"), not a
   *  "Supplies & tax" row - the warning has to name the row the office can actually see. This is
   *  that row's name as the importer writes it. */
  returnRow?: string;
};

/**
 * AN EDITED "SUPPLIES & TAX" ROW STAYS BEHIND WHEN ITS PARTS MOVE (INV-074, Kathy Walker).
 *
 * One `edited` flag covers both the words and the money on a line (0175), so renaming the row -
 * Erik took the supplier's name off all three on INV-074 - also froze its amount. When the markup
 * then went from 25% to 30%, the import re-priced the parts and left the three tax rows at their
 * 25% figures: each bill's rows stopped adding up to its marked-up total, and the invoice went
 * out 77 cents short with a toast that said only "3 of your edits kept".
 *
 * The importer is right not to touch an edited line, so this does not change what anyone is
 * charged. It names the bills where that choice now leaves a gap, with the figure the row would
 * carry, so the office decides with the number in front of it.
 *
 * A bill is named only when its parts were actually refreshed (some other row of it is on the
 * invoice and not edited). A bill the office froze entirely is internally consistent at whatever
 * numbers they typed, and nagging about it would be noise.
 */
export function editedRemainderDrift(
  bills: readonly { id: string | number; supplier?: string | null; amount?: unknown }[],
  offered: readonly { import_key: string; description?: string; quantity: number; unit_price: number; source_ids?: string[] }[],
  onInvoice: readonly { import_key?: string | null; line_total?: unknown; edited?: boolean | null }[],
): EditedRemainderDrift[] {
  const out: EditedRemainderDrift[] = [];
  for (const b of bills) {
    const id = String(b.id);
    const key = remainderKey(id);
    const kept = onInvoice.find((r) => r.import_key === key && r.edited === true);
    if (!kept) continue;
    const partKeys = new Set(offered.filter((r) => r.import_key !== key && (r.source_ids ?? []).includes(id)).map((r) => r.import_key));
    if (!onInvoice.some((r) => r.edited !== true && partKeys.has(String(r.import_key ?? "")))) continue;
    const row = offered.find((r) => r.import_key === key);
    const computed = row ? Math.round(row.quantity * row.unit_price * 100) / 100 : 0;
    const keptAmt = Math.round((Number(kept.line_total) || 0) * 100) / 100;
    if (Math.round(keptAmt * 100) === Math.round(computed * 100)) continue;
    const isReturn = Math.round((Number(b.amount) || 0) * 100) < 0;
    out.push({
      billId: id,
      supplier: String(b.supplier ?? "").trim() || "A receipt",
      kept: keptAmt,
      computed,
      ...(isReturn ? { returnRow: row?.description || "Returned: tax" } : {}),
    });
  }
  return out;
}

/** "Swigard's: your edited Supplies & tax row stayed at $1.45; at 30% it would be $1.51" - or, on a
 *  supplier return, "CED: your edited Returned: tax row stayed at -$4.88; ...". */
export function editedRemainderSentence(d: EditedRemainderDrift, markupPct: unknown): string {
  const pct = +(Number(markupPct) || 0).toFixed(2);
  const row = d.returnRow ?? "Supplies & tax";
  return `${d.supplier}: your edited ${row} row stayed at ${formatCurrency(d.kept)}; at ${pct}% it would be ${formatCurrency(d.computed)}`;
}
