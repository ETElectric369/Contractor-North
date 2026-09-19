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

import { billedPortion, billLineCost, excludedReceiptCost } from "@/lib/bill-itemisation";
import { formatCurrency } from "@/lib/utils";

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
  /**
   * WITHOUT THESE TWO THE CARD AND THE INVOICE READ THE SAME LINE DIFFERENTLY (review, 2026-09-19),
   * and it is the projection law wearing the same hat as the tax gap below.
   *
   * `billLineCost` is `amount ?? unit_price * (qty || 1)`: a line whose stored extension is $0.00
   * with a real price beside it - CED's standard back-order print, and there is one on his 85
   * Whitney receipt right now - costs $38.98 to the importer and $0.00 to this card. Because the
   * tax share here is PROPORTIONAL, a short denominator then skews every other exclusion on the
   * same receipt too. A type too narrow to ask the right question is how two screens end up
   * disagreeing about one dollar, which is the exact sentence the tax note below was written for.
   */
  unitPrice?: number | null;
  quantity?: number | null;
  billable?: boolean | null;
  /** Dollars of this line THIS job took, when only part of the container was the customer's
   *  (0272). Null means the whole line, which is what every row written before 0272 means. */
  billedAmount?: number | null;
  /**
   * WITHOUT THIS THE CARD COULD NOT SEE TAX, AND THAT WAS THE WHOLE BUG (review of cn-v964).
   *
   * The invoice takes the excluded share of sales tax off along with the lines it excludes, and
   * this type had no way to know which line was the tax - so the card's figure and the invoice's
   * figure were guaranteed to differ by exactly that share, $7.86 on the wave's own fixture. A
   * type too narrow to ask the right question is how two screens end up disagreeing about one
   * dollar.
   */
  category?: string | null;
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
  /** How many lines bill only part of themselves: a container that went on the shelf and gave
   *  this job a handful. Counted separately from the switched-off lines because they are a
   *  different sentence — "not billed" and "billed in part" are not the same fact, and a card
   *  that blurred them would be the screen disagreeing with the invoice all over again. */
  partBilledCount: number;
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
  let notBilledCount = 0;
  let partBilledCount = 0;
  for (const l of lines ?? []) {
    if (l?.billable === false) {
      notBilledCount += 1;
      continue;
    }
    // billLineCost, not `amount`: a split on a line whose extension is $0.00 with a real price
    // beside it used to count as no split at all, so the card said nothing while the invoice took
    // the money off. That is the silent direction, and worse than a wrong figure.
    if (billedPortion(billLineCost({ id: 0, amount: l?.amount, quantity: l?.quantity, unit_price: l?.unitPrice }), l?.billedAmount) != null)
      partBilledCount += 1;
  }
  /**
   * THE SAME READING THE INVOICE USES, NOT A SECOND ONE (review of cn-v964).
   *
   * This loop used to do its own subtraction - line cost minus the billed portion - and it was
   * right about the lines and silent about the tax. The invoice takes the excluded share of sales
   * tax off as well, because four fifths of a box left on the shelf takes four fifths of the tax
   * charged on that box with it. So on a $139.65 receipt with the Twister box split to $13.00 the
   * card promised $44.29 was coming off and the importer took $36.43: a $7.86 gap between a
   * sentence on a screen and what the money actually did, which is the INV-069 shape wearing a new
   * hat. excludedReceiptCost is now the only place that arithmetic exists.
   */
  const eaten = excludedReceiptCost(
    (lines ?? []).map((l, i) => ({
      // The shared reading keys nothing off the id; it is required by the importer's own row type,
      // so an index keeps the shapes compatible without inventing a database id here.
      id: i,
      amount: l?.amount,
      // The two the importer's own projection carries, so billLineCost reads one line one way.
      quantity: l?.quantity,
      unit_price: l?.unitPrice,
      category: l?.category ?? null,
      billable: l?.billable,
      billed_amount: l?.billedAmount,
    })),
  );
  const billed = Math.max(0, round2(cost - round2(eaten)));
  // notBilled is DERIVED from billed rather than from `eaten` so the two figures on the card
  // always add up to the figure on the receipt, even when the clamp above bit.
  return { cost, billed, notBilled: round2(cost - billed), notBilledCount, partBilledCount };
}

/**
 * WHEN THE PAPER IS NOT PRICED FOR HIM YET (Erik, 2026-09-18).
 *
 * He bought at the CED branch near Sunnyvale on his Truckee account. What came back was not a bill:
 *
 *   "my account gets priced by truckee thats why the final lines are blank so that is just a
 *    preview of sunnyvale retail counter price not my prices which havent come back yet"
 *   "thats why the invoice has all the *****"
 *
 * CED masks the contract price with asterisks and prints the branch's retail counter price beside
 * it. The reader took the retail column and stored it as his cost, so eight electrical lines - a
 * 125A load centre, Square D breakers - went into the price book at a rate he is never charged
 * (learned_prices reads bill_line_items live). The real Truckee-priced invoice arrives later, by
 * the same email import that already brought his statements in, which is how the SAME purchase
 * gets counted twice on one job.
 *
 * The asterisks are the tell, and they are the one part of this a machine can see. This says so;
 * `bills.pricing_provisional` (0271) is what it sets, and the price book skips those rows.
 */
export const MASKED_PRICE_PROMPT_RULE =
  'Set "pricing_provisional": true when the document does NOT show this account\'s own prices - a price column masked with asterisks (*****), left blank, or shown as "N/A", a quote or counter preview, or a header saying the pricing is pending. Supply houses print asterisks where a contract price will go and show the branch retail price beside it, and that retail figure is NOT what this contractor pays. Still transcribe the numbers you can read, and still set the total, but say the pricing is provisional so nothing downstream treats it as settled cost.';

/**
 * The asterisk run a supply house prints where a contract price belongs. Three or more, so a
 * footnote marker or a single emphasis star is never mistaken for a masked price.
 *
 * AND NOT A MASKED CARD NUMBER (review, 2026-09-19). The vision prompt asks the reader to
 * transcribe every readable line AND to treat "a card number/••••" as evidence the receipt was
 * paid at the register - so a Home Depot receipt ending "VISA ****1234" would have been read as a
 * counter preview, quietly pulling a perfectly ordinary purchase out of the price book. A masked
 * PRICE stands where a number was removed; a masked CARD is followed by the last four. Requiring
 * no digits after the run tells them apart without guessing at either.
 */
// `(?!\*)` before the digit test is load-bearing, not decoration: without it the engine simply
// backtracks to a SHORTER run and matches "***" out of "************9012", with the twelfth
// asterisk satisfying "not a digit". Forcing the match to consume the whole run first is what makes
// the digit test apply to the run's real end. A test asserts the twelve-star case.
const MASKED_PRICE = /\*{3,}(?!\*)(?!\s*\d)/;

/** True when transcribed text carries the mask itself - a second chance at the same fact for a
 *  document whose reader did not answer the question, and the reason it is a plain function rather
 *  than only a prompt instruction. Never guesses from a missing number alone: plenty of honest
 *  lines have no extended price. */
export function looksProvisionallyPriced(text: string | null | undefined): boolean {
  return MASKED_PRICE.test(String(text ?? ""));
}

/**
 * ── WHAT A CONTAINER LOOKS LIKE ON A RECEIPT (Erik, 2026-09-19; migration 0272) ───────────────
 *
 *   "the Twister box i was confused about and i remebered that is a whole ccontainer of wire nuts
 *    that we uses some of but is certainly stock and shouldnt be charged to the customer in full
 *    however necessary for the job"
 *
 * A 500 count box of wire nuts at $108.36 is 21.7 cents each, and his customer was billed $135.00
 * for the box. The arithmetic was never the hard part - he did it in his head in one sentence. The
 * hard part is NOTICING, halfway down a twelve line receipt, that one of those lines is a box
 * rather than a part. That is all this section does: it points at a row and says "this looks like
 * a container".
 *
 * ── AND IT IS A NUDGE, NOT A DEFAULT, FOREVER ────────────────────────────────────────────────
 * Nothing here ever sets `is_stock` or `billed_amount`. The app suggests, a person decides, and a
 * number on a customer's invoice is the last place to start guessing - a container count guessed
 * wrong changes what somebody is charged, silently, in a direction nobody asked for.
 *
 * THE QUANTITY COLUMN IS NOT THE CONTAINER COUNT, and the line that started this proves it. That
 * Twister row reads `quantity 500` because the scanner read 500 out of the PRODUCT NAME, not
 * because anyone bought five hundred boxes. On the next receipt the same column will read 1 for a
 * box of a thousand. So a big quantity is only ever a reason to LOOK at a row; the count that
 * divides the money comes from a person typing it, and from nowhere else. The next person to reach
 * for `quantity` as the divisor - it is right there, it is a number, it is tempting - is reaching
 * for a figure the receipt does not contain.
 */

/** The words a supply house prints when it is selling you a container of something. "roll", "spool"
 *  and "reel" are here because 250 feet of THHN is the same story as 500 wire nuts: bought whole,
 *  used by the piece, and never one job's to own. */
const CONTAINER_WORDS =
  /\b(?:bx|box|boxes|pk|pkg|pack|packs|ct|cnt|count|case|carton|spool|spl|roll|reel|coil|jar|tub|pail|bucket|drum|bag)\b/i;

/** A count written next to a container word: "500/BX", "100 PK", "250CT". */
const COUNTED_CONTAINER = /(\d[\d,]*)\s*(?:\/|-|\s)?\s*(?:bx|box|boxes|pk|pkg|pack|packs|ct|cnt|count)\b/i;

/**
 * THREE HEURISTICS CAME OUT OF THIS FUNCTION, AND THE REASON IS THE WHOLE POINT OF THE FEATURE
 * (review of cn-v964).
 *
 * `STANDALONE_NUMBER` looked for a round number anywhere in the description and called it a
 * container count. Run against real supply-house text it reads "SQD QO 100 AMP MAIN BREAKER" as a
 * box of 100, "50 AMP RECEPTACLE" as a box of 50, and "ROMEX 14-2 W/G 250" as 250 pieces. Those
 * are an amperage, an amperage and a footage. `PER_HUNDRED` (/C) and `PER_THOUSAND` (/M) are real
 * trade shorthand and also match "18/C" - eighteen CONDUCTOR cable - and any part number with an
 * M after a slash.
 *
 * The count was then stated as fact beside a one-press "Use N" button, which makes a wrong guess
 * one tap from a wrong invoice. And it is the same mistake in the same feature twice: Erik reached
 * for a quantity heuristic himself ("qtys of 100s might give it away") and the very line that
 * prompted all of this disproves it - the Twister row reads quantity 500 because the scanner took
 * "500/5000" out of the PRODUCT NAME.
 *
 * So only COUNTED_CONTAINER survives: a number sitting beside an actual container word. That still
 * catches "500/BX", "100 PK" and "250 CT", which is every way a supply house actually prints a
 * pack size, and it costs nothing when it is silent - the sheet asks him for the number, which is
 * where that answer was always going to come from.
 */

/**
 * The container count the DESCRIPTION states, when it states one plainly. Null is the common and
 * correct answer: a receipt line usually does not say, and saying so is what makes the person type
 * it. Never reads `quantity` - see the section header for the row that disproves it.
 */
export function containerCountInDescription(description: string | null | undefined): number | null {
  const d = String(description ?? "");
  if (!d) return null;
  const counted = d.match(COUNTED_CONTAINER);
  if (counted) {
    const n = Number(String(counted[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 2 && n <= 100000) return n;
  }
  // Nothing else guesses. A count this function cannot read off a container word is a count the
  // person types, and "we do not know" is the honest and common answer here.
  return null;
}

export interface ContainerHint {
  /** Worth a second look. Never worth a write. */
  looksLikeContainer: boolean;
  /** The count the description states, or null when it does not state one. */
  count: number | null;
  /** One plain sentence saying WHY the row is flagged, so the suggestion can be argued with. */
  why: string;
}

/**
 * Does this line look like a container bought whole? Three signals, in the order they are trusted:
 * a count printed beside a container word, a container word on its own, and a quantity over fifty.
 *
 * The third is the weakest and it is still here, because it is the one that catches the row that
 * started this: a description that says nothing about a box, sitting on a line that says 500.
 */
export function containerHint(
  description: string | null | undefined,
  quantity: number | null | undefined,
): ContainerHint {
  const d = String(description ?? "");
  const count = containerCountInDescription(d);
  const qty = Number(quantity) || 0;
  if (count != null) {
    return { looksLikeContainer: true, count, why: `This line says ${count} of them.` };
  }
  if (CONTAINER_WORDS.test(d)) {
    return { looksLikeContainer: true, count: null, why: "This line reads like a box or a spool." };
  }
  if (qty > 50) {
    return {
      looksLikeContainer: true,
      count: null,
      // The count is deliberately NOT offered here. See the section header: this number came off
      // the product name once already.
      why: `The receipt read ${qty} on this line, which is usually a container.`,
    };
  }
  return { looksLikeContainer: false, count: null, why: "" };
}

/**
 * What one of them cost, given the count a PERSON confirmed the container holds. Null when there
 * is nothing to divide by - an unasked question has no answer, and a zero would render "$0.00
 * each" beside a figure he is about to bill somebody.
 */
export function perUnitCost(lineCost: number | null | undefined, containerCount: number | null | undefined): number | null {
  const cost = Number(lineCost) || 0;
  const count = Number(containerCount) || 0;
  if (!(cost > 0) || !(count > 0)) return null;
  return cost / count;
}

/**
 * The per-unit price in the words Erik used for it: "21.7 cents each". Tenths of a cent, because
 * $108.36 over 500 is 21.672 cents and rounding that to "22 cents" loses the very arithmetic that
 * made the box obvious to him in the first place. A dollar or more reads as dollars, where a tenth
 * of a cent is noise.
 */
export function perUnitLabel(unitCost: number | null | undefined): string {
  const n = Number(unitCost);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1) return `${formatCurrency(round2(n))} each`;
  const cents = Math.round(n * 1000) / 10;
  return `${cents % 1 === 0 ? cents.toFixed(0) : cents.toFixed(1)} cents each`;
}

/**
 * How many did you use, times what one costs. THE money figure, computed the way he says it out
 * loud, and rounded once - `billed_amount` stores dollars, so this is the only conversion and it
 * happens where he can see the result before he saves it.
 */
export function usedCost(usedCount: number | null | undefined, unitCost: number | null | undefined): number {
  const count = Number(usedCount) || 0;
  const unit = Number(unitCost) || 0;
  if (!(count > 0) || !(unit > 0)) return 0;
  return round2(count * unit);
}

/**
 * The other direction, for the person who thinks in dollars: roughly how many that is.
 *
 * DISPLAY ONLY, AND HEDGED WHERE IT IS SHOWN. $13.00 divided by 21.672 cents is 59.98, and the
 * app does not put "60" anywhere a customer will read it - the invoice row says what this job used
 * in dollars, which is the number a person actually typed. This is here so the count he can picture
 * appears beside the dollars he typed, and so the stock draw has a quantity to take off the shelf.
 */
export function usedCountFromCost(cost: number | null | undefined, unitCost: number | null | undefined): number | null {
  const c = Number(cost) || 0;
  const unit = Number(unitCost) || 0;
  if (!(c > 0) || !(unit > 0)) return null;
  return Math.round((c / unit) * 100) / 100;
}
