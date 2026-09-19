/**
 * WHOSE LINE IS IT — the rules behind `bill_line_items.billable` (migration 0268).
 *
 * ── THE INCIDENT (Erik, 2026-09-18) ──────────────────────────────────────────────────────────
 * A Home Depot run puts the panel, the wire, the drill bit, the gloves and the Smartwater on ONE
 * piece of paper. The receipt reader transcribed all of it, the importer marked all of it up, and
 * INV-069 charged a homeowner for a bottle of water and a ten cent bottle deposit. The cost of
 * that reached a great deal further than eight dollars:
 *
 *   "i have another receipt that i didnt scan specifically because it was mostly snacks and a $3
 *    part"
 *
 * So the $3 part never became a job cost and the snacks never became a deduction. The app was
 * teaching him to keep worse books. This file is the half of the fix that is pure arithmetic and
 * pure vocabulary, kept out of the server actions so it can be tested without a database and
 * shared by the two places that must agree: the reader that WRITES the flag (organize/actions.ts)
 * and the card that SHOWS it (receipt-billing-card.tsx).
 *
 * ── THE ONE DEFAULT, AND ONLY THIS ONE ───────────────────────────────────────────────────────
 * Asked what should stop being billed without him saying so, Erik chose food and drink and
 * nothing else. Tools, bits, blades and gloves keep billing exactly as they always have; the
 * switch exists per line for when he wants it. Nothing a customer is charged today may change on
 * its own — a default that quietly widened later would be the same betrayal as the one it fixes,
 * pointed the other way.
 *
 * TAX IS NOT TOUCHED. Sales tax paid on the customer's materials is a pass-through cost and stays
 * billed, inside the importer's per-bill remainder row, exactly as it is today. "Not itemised" and
 * "not billed" are two different ideas and this column is only the second one.
 */

/** The per-line category the receipt reader must choose from. `Food & Drink` is the new one. */
export const RECEIPT_LINE_CATEGORIES = [
  "Materials",
  "Electrical",
  "Tools",
  "Fasteners",
  "Lumber",
  "Plumbing",
  "Paint",
  "Rental",
  "Food & Drink",
  "Tax",
  "Other",
] as const;

export type ReceiptLineCategory = (typeof RECEIPT_LINE_CATEGORIES)[number];

export const FOOD_AND_DRINK: ReceiptLineCategory = "Food & Drink";

/**
 * The category list exactly as it appears inside the vision prompts. There are TWO prompts that
 * itemise a receipt — the Organize My classifier and the job-receipt reader — and they drifted
 * apart once already. One string, interpolated into both, is the only way they stay identical.
 */
export const RECEIPT_LINE_CATEGORY_CHOICES = RECEIPT_LINE_CATEGORIES.map((c) => `"${c}"`).join(" | ");

/**
 * What the model is told the new category MEANS. Without this it filed a bottle of Smartwater
 * under "Other", which is also where a legitimate odd bit of hardware lands, so nothing
 * downstream could tell a snack from a strut clamp. Named things are separable things.
 */
export const FOOD_AND_DRINK_PROMPT_RULE =
  'Use "Food & Drink" for anything a person eats or drinks and for the charges that ride along with it: bottled water, soda, energy drinks, coffee, ice, snacks, candy, lunch or any meal, and any bottle or container deposit and its redemption. These are real costs but they are the crew\'s, not the customer\'s, so they must never be filed as "Other".';

/** Category names compare loosely: "Food & Drink", "food and drink" and "Food/Drink" are one thing. */
function categoryKey(category: string | null | undefined): string {
  return String(category ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z]/g, "");
}

const FOOD_KEYS = new Set(["foodanddrink", "fooddrink"]);

/**
 * Should a freshly-read line be billed to the customer? Everything is billed except food and
 * drink. A category the model invented, or none at all, bills — the safe direction, because a
 * wrongly-billed line is a conversation and a wrongly-unbilled one is money Erik never gets back
 * and never sees go missing.
 */
export function defaultBillable(category: string | null | undefined): boolean {
  return !FOOD_KEYS.has(categoryKey(category));
}

/**
 * The flag for a line, honouring a decision already made. A tray item's parsed lines are stored as
 * jsonb on `organized_items.line_items` and re-read verbatim when the item is filed (or re-filed)
 * later, so an explicit true or false made on the receipt must survive that round trip — otherwise
 * moving a receipt from one job to another would silently re-bill the snacks.
 *
 * Legacy rows carry no flag at all and no `Food & Drink` category, so they fall through to
 * defaultBillable and stay billed. Nothing a customer is charged today changes on its own.
 */
export function normalizeBillable(raw: unknown, category: string | null | undefined): boolean {
  if (raw === true || raw === false) return raw;
  return defaultBillable(category);
}

/** Money lives in cents; every figure on the card is rounded once, here. */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface BillingSplitLine {
  amount: number | null;
  billable?: boolean | null;
}

export interface ReceiptBillingSplit {
  /** What the receipt actually cost — `bills.amount`, the whole piece of paper. Job cost, always. */
  cost: number;
  /** What the customer is billed for it, at cost, before the invoice's markup. */
  billed: number;
  /** The rest: what the company eats. Always exactly `cost - billed`, so the card adds up. */
  notBilled: number;
  /** How many lines are switched off — what the collapsed row needs to say without opening. */
  notBilledCount: number;
}

/**
 * Split a receipt into the customer's half and the company's half.
 *
 * THE ANCHOR IS `bills.amount`, NOT THE SUM OF THE LINES, and that is deliberate. The importer's
 * standing invariant is that a bill's invoice rows sum to its marked-up TOTAL, with a remainder
 * row absorbing tax, rounding and anything the model could not read. If this card summed the
 * lines instead, a receipt whose transcription was a few cents light would show Erik one number
 * while the invoice showed another — the exact shape of the INV-069 confusion, where a screen and
 * a database disagreed and the person in the middle was told he was wrong.
 *
 * So: start from what he paid, subtract only the lines he has switched off, and never go below
 * zero. A junk transcription can make `notBilled` exceed the whole receipt; billing a negative
 * amount would be inventing a figure, which this app does not do.
 */
export function splitReceiptBilling(
  billAmount: number | null | undefined,
  lines: BillingSplitLine[] | null | undefined,
): ReceiptBillingSplit {
  const cost = round2(Number(billAmount) || 0);
  let eaten = 0;
  let notBilledCount = 0;
  for (const l of lines ?? []) {
    if (l?.billable === false) {
      eaten += Number(l.amount) || 0;
      notBilledCount += 1;
    }
  }
  const billed = Math.max(0, round2(cost - round2(eaten)));
  // notBilled is DERIVED from billed rather than from `eaten` so the two figures on the card
  // always add up to the figure on the receipt, even when the clamp above bit.
  return { cost, billed, notBilled: round2(cost - billed), notBilledCount };
}
