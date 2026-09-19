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

/**
 * The same instruction, moved to where the model is actually deciding. cn-v961 appended
 * FOOD_AND_DRINK_PROMPT_RULE beneath both schemas and the very next receipt still filed chips and
 * an ice cream bar as "Other" — a rule at the bottom of a long prompt is a rule that gets skimmed,
 * while the schema line sits beside the field being filled in. Both say it now, because both cost
 * nothing, and neither one is trusted on its own: looksLikeFoodAndDrink below is the part that
 * holds when the model ignores all of it.
 */
export const RECEIPT_LINE_CATEGORY_SCHEMA_HINT = `one of ${RECEIPT_LINE_CATEGORY_CHOICES}. Snacks, drinks, ice, candy and bottle deposits are "Food & Drink" even in the middle of a hardware receipt: "Kettle Chips Salt/Pepper" and "Ice Cream Bar" are "Food & Drink", never "Other"`;

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

/**
 * ── THE SECOND INCIDENT (Erik, 2026-09-19, twelve minutes after cn-v961 shipped) ──────────────
 * He scanned an OSH receipt into the Waldow job at 05:37 UTC. The reader had the whole of
 * FOOD_AND_DRINK_PROMPT_RULE in front of it, in the same request, and filed this:
 *
 *   Kettle Chip Honey Dijon    2.09   "Other"      billed to the customer
 *   Kettle Chips Salt/Pepper   2.09   "Other"      billed to the customer
 *   Ice Cream Bar Choc Almond  4.99   "Other"      billed to the customer
 *
 * The prompt was correct and present. The model read it and filed chips as "Other" anyway. So the
 * lesson is not "write a better sentence" — it is that A PROMPT IS NOT A MECHANISM. A sentence is
 * a request; this is the part that holds when the request is ignored.
 *
 * ── THE TWO RULES THAT KEEP THIS HONEST ───────────────────────────────────────────────────────
 * 1. IT ONLY EVER RECLASSIFIES UPWARD, OUT OF A SHRUG. "Other", "Misc", blank — those are the
 *    model saying it does not know, and filling in a blank is not overruling anybody. A line it
 *    actually filed as "Fasteners" or "Electrical" is left exactly alone, forever, however much
 *    the words look like lunch. And a flag a PERSON has already switched outranks all of this:
 *    decideReceiptLine hands the stored decision straight through.
 * 2. WHEN IN DOUBT, KEEP BILLING. A snack billed by mistake is one tap on the receipt card and
 *    Erik can see it sitting there. A real part silently zeroed is money he never invoices and
 *    never notices, which is the worse failure and the quieter one. Every judgement call below
 *    was made in that direction, which is why the term list is short and the trap list is long.
 */

/** Categories that are the model shrugging rather than deciding. Only these get a second look. */
const UNCLASSIFIED_KEYS = new Set([
  "",
  "other",
  "misc",
  "miscellaneous",
  "unknown",
  "uncategorized",
  "uncategorised",
  "unclassified",
  "na",
  "none",
]);

/** Did the model actually choose a category for this line, or did it shrug? */
export function isUnclassifiedCategory(category: string | null | undefined): boolean {
  return UNCLASSIFIED_KEYS.has(categoryKey(category));
}

/**
 * A description reduced to space-separated words and padded at both ends, so a plain
 * `includes(" chip ")` is a WORD-BOUNDARY match and never a substring one. This is the whole
 * defence against the class of bug where "chip" fires on "chipboard", "ice" on "device" and
 * "bar" on "rebar": a substring scan over a hardware receipt would misfile half of it.
 * "Kettle Chips Salt/Pepper" → " kettle chips salt pepper ".
 */
function descriptionWords(description: string | null | undefined): string {
  const flat = String(description ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return flat ? ` ${flat} ` : "";
}

/** Does `haystack` (already word-padded) contain `phrase` as whole words, in order? */
function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = descriptionWords(phrase);
  return needle.length > 0 && haystack.includes(needle);
}

/**
 * The words that mean somebody ate it. Deliberately SHORT.
 *
 * Every word that did not make this list lost for the same reason: on a hardware receipt it is
 * more often a part than a meal, and rule 2 says keep billing when in doubt. The ones that lost,
 * so nobody re-adds them at midnight without the reason:
 *   nuts    — wire nuts, lock nuts, coupling nuts. Half an electrician's receipt.
 *   salt    — rock salt and ice melt, bought by the bag, not eaten.
 *   water   — water heater, water pump, waterproof, drinking-water-safe hose.
 *   ice     — Ice & Water Shield, ice melt, icemaker line, de-icer cable.
 *   bar     — pry bar, rebar, bus bar, bar clamp.
 *   pop     — pop rivet.
 *   muffin  — a muffin fan is a cooling fan.
 *   honey   — honey oak, the stain colour.
 *   apple   — Candy Apple Red, the paint colour.
 *   mint    — also a paint colour.
 *   taco    — Taco make circulator pumps.
 *   monster — Monster make cable.
 * Multi-word entries match as a phrase, which is how "bottled water" can be here while "water"
 * cannot, and how "ice cream" can be here while "ice" cannot.
 */
/**
 * DROPPED ON PURPOSE, AND WHY THE LIST GETS SHORTER RATHER THAN THE TRAPS LONGER (cn-v962 review).
 *
 * "popcorn" and "milk" were here and both fired on real trade stock: popcorn ceiling texture,
 * popcorn patch, a popcorn scraper, milk glass shades, a milk crate. Their trap lists could have
 * grown to cover those, but a trap only ever defends the exact inflection somebody thought to
 * write - the same review found "soda blast" shipped without "soda blasting" - so a term whose
 * false positives are ordinary supply-house vocabulary is a term this list should not carry at
 * all. "honey", "apple" and "mint" came out earlier for exactly this reason.
 *
 * The asymmetry is deliberate and it points one way: a snack billed by mistake is one tap for Erik
 * on the receipt card, while a real part silently excluded is money he never sees again. So when
 * a word is arguable, it does not go in the list, and the model's own classification stands.
 */
export const FOOD_AND_DRINK_TERMS: readonly string[] = [
  // snacks off the rack by the register
  "chip",
  "chips",
  "snack",
  "snacks",
  "candy",
  "chocolate",
  "cookie",
  "cookies",
  "cracker",
  "crackers",
  "pretzel",
  "pretzels",
  "granola",
  "jerky",
  "trail mix",
  "peanut butter",
  "ice cream",
  "candy bar",
  "energy bar",
  "protein bar",
  "granola bar",
  "cheese",
  "sandwich",
  "burrito",
  "pizza",
  "hot dog",
  // a meal, however it is written on the paper
  "lunch",
  "breakfast",
  "dinner",
  "meal",
  "deli",
  // drinks
  "soda",
  "soda pop",
  "soft drink",
  "energy drink",
  "drinks",
  "beverage",
  "bottled water",
  "smartwater",
  "smart water",
  "dasani",
  "aquafina",
  "gatorade",
  "powerade",
  "bodyarmor",
  "body armor",
  "red bull",
  "redbull",
  "coca cola",
  "cocacola",
  "coke",
  "pepsi",
  "sprite",
  "dr pepper",
  "mountain dew",
  "root beer",
  "juice",
  "lemonade",
  "iced tea",
  "tea",
  "coffee",
  "creamer",
  "beer",
  // the charges that ride along with a drink — INV-069's ten cent one started all of this
  "crv",
  "bottle deposit",
  "bottle dep",
  "ca redemption",
  "redemption value",
];

/**
 * THE TRAPS: real things off a real hardware shelf that contain a food word. If any of these
 * appears anywhere in the description the line is left completely alone, whatever else it says.
 *
 * This list is also the STANDING RECORD of every trap anyone has thought of, including traps for
 * words that are not terms today ("pop rivet"). That is on purpose: the day someone adds "pop" to
 * the list above, the rivets are already defended, instead of the trap being rediscovered by a
 * customer who was not charged for them.
 */
export const NOT_FOOD_PHRASES: readonly string[] = [
  // "chip" is the term that earns its keep and the term that can hurt
  "chip brush",
  "chip brushes",
  "wood chip",
  "wood chips",
  "paint chip",
  "paint chips",
  "chip seal",
  "carbide chip",
  "chip resistant",
  // a Coke-bottle lens is a lens
  "coke bottle",
  // not a term today. Written down anyway — see the note above.
  "pop rivet",
  "pop rivets",
  // paint and stain colours are named after the snack aisle
  "candy cane",
  "candy apple",
  "chocolate brown",
  "coffee table",
  "coffee bean",
  "coffee beans",
  "coffee brown",
  "milk paint",
  // shop and garden chemistry
  "soda ash",
  "baking soda",
  "washing soda",
  "caustic soda",
  "soda blast",
  "soda blasting",
  "bone meal",
  "blood meal",
  "kelp meal",
  // things that are shaped like the word
  "cheese cloth",
  "tea light",
  "tea lights",
  "sandwich panel",
  "beer tap",
  "beer line",
  "beer faucet",
  // words that are not terms today, kept for the same reason as the rivets
  "drinking water",
  "water heater",
  "ice melt",
  "ice maker",
  "ice machine",
  "ice and water",
];

/**
 * Is this line plainly food or drink, from its words alone? Traps are checked FIRST and win
 * outright, so a description that is both ("chip brush and a bag of chips") stays billable —
 * rule 2 again.
 */
export function looksLikeFoodAndDrink(description: string | null | undefined): boolean {
  const words = descriptionWords(description);
  if (!words) return false;
  for (const trap of NOT_FOOD_PHRASES) if (containsPhrase(words, trap)) return false;
  for (const term of FOOD_AND_DRINK_TERMS) if (containsPhrase(words, term)) return true;
  return false;
}

/**
 * The category a line should carry. The model's answer stands whenever the model gave one; only a
 * shrug is filled in, and only when the words are plainly food.
 */
export function resolveReceiptLineCategory(
  description: string | null | undefined,
  category: string | null | undefined,
): string | null {
  const stated = category != null && String(category).trim() !== "" ? String(category) : null;
  if (!isUnclassifiedCategory(stated)) return stated;
  return looksLikeFoodAndDrink(description) ? FOOD_AND_DRINK : stated;
}

export interface ReceiptLineDecision {
  /** What the line is: the model's category, or Food & Drink filled into its shrug. */
  category: string | null;
  /** Whether the customer pays for it. */
  billable: boolean;
}

/**
 * THE ONE ENTRY POINT. Category and flag are decided together, in this order, because the order
 * IS the invariant: the net may rename a shrug, and the person's stored switch still outranks
 * whatever it renamed it to. Callers that did these two steps separately could get that backwards,
 * so there is nothing to get backwards any more.
 */
export function decideReceiptLine(
  description: string | null | undefined,
  category: string | null | undefined,
  storedBillable: unknown,
): ReceiptLineDecision {
  const resolved = resolveReceiptLineCategory(description, category);
  return { category: resolved, billable: normalizeBillable(storedBillable, resolved) };
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
