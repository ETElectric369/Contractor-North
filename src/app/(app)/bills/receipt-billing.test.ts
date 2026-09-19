import { describe, it, expect } from "vitest";
import {
  FOOD_AND_DRINK,
  RECEIPT_LINE_CATEGORIES,
  RECEIPT_LINE_CATEGORY_CHOICES,
  RECEIPT_LINE_CATEGORY_SCHEMA_HINT,
  decideReceiptLine,
  defaultBillable,
  isUnclassifiedCategory,
  looksLikeFoodAndDrink,
  looksProvisionallyPriced,
  normalizeBillable,
  resolveReceiptLineCategory,
  splitReceiptBilling,
  containerCountInDescription,
  containerHint,
  perUnitCost,
  perUnitLabel,
  usedCost,
  usedCountFromCost,
} from "./receipt-billing";

describe("what the receipt reader bills by default", () => {
  it("bills everything except food and drink", () => {
    for (const c of RECEIPT_LINE_CATEGORIES) {
      expect(defaultBillable(c)).toBe(c !== FOOD_AND_DRINK);
    }
  });

  // Erik chose food and drink ONLY. A tool on a job receipt is his call, line by line — it must
  // not quietly stop billing the day this ships, or a customer's invoice changes without him.
  it("still bills tools, and still bills tax", () => {
    expect(defaultBillable("Tools")).toBe(true);
    expect(defaultBillable("Tax")).toBe(true);
  });

  it("bills an unknown or missing category — the safe direction", () => {
    expect(defaultBillable(null)).toBe(true);
    expect(defaultBillable(undefined)).toBe(true);
    expect(defaultBillable("")).toBe(true);
    expect(defaultBillable("Strut & Clamp")).toBe(true);
  });

  it("recognises the category however the model spells it", () => {
    expect(defaultBillable("food and drink")).toBe(false);
    expect(defaultBillable("FOOD & DRINK")).toBe(false);
    expect(defaultBillable("Food/Drink")).toBe(false);
  });

  it("offers the new category to both prompts in one string", () => {
    expect(RECEIPT_LINE_CATEGORY_CHOICES).toContain('"Food & Drink"');
    expect(RECEIPT_LINE_CATEGORY_CHOICES).toContain('"Materials"');
    expect(RECEIPT_LINE_CATEGORY_CHOICES).toContain('"Tax"');
  });
});

describe("a decision already made survives being re-filed", () => {
  // organized_items.line_items is jsonb, re-read verbatim when a tray item is filed or moved to
  // another job. Without this, moving a receipt would re-bill the snacks Erik had switched off.
  it("keeps an explicit false on a line the default would bill", () => {
    expect(normalizeBillable(false, "Tools")).toBe(false);
  });

  it("keeps an explicit true on a food line Erik decided to bill", () => {
    expect(normalizeBillable(true, FOOD_AND_DRINK)).toBe(true);
  });

  it("falls back to the default when no decision was stored", () => {
    expect(normalizeBillable(undefined, FOOD_AND_DRINK)).toBe(false);
    expect(normalizeBillable(null, "Materials")).toBe(true);
    // A legacy row predates the column AND the category, so it stays billed.
    expect(normalizeBillable(undefined, "Other")).toBe(true);
  });

  it("ignores a non-boolean the model or an old row might carry", () => {
    expect(normalizeBillable("false", FOOD_AND_DRINK)).toBe(false);
    expect(normalizeBillable("false", "Materials")).toBe(true);
    expect(normalizeBillable(0, "Materials")).toBe(true);
  });
});

describe("what the customer gets billed for a receipt", () => {
  it("bills the whole receipt when every line is the customer's", () => {
    const split = splitReceiptBilling(120.5, [
      { amount: 100, billable: true },
      { amount: 20.5, billable: true },
    ]);
    expect(split).toEqual({ cost: 120.5, billed: 120.5, notBilled: 0, notBilledCount: 0, partBilledCount: 0 });
  });

  it("subtracts only the lines that are switched off", () => {
    // The INV-069 shape: a bottle of water, a BodyArmor and a ten cent bottle deposit.
    const split = splitReceiptBilling(100, [
      { amount: 90, billable: true },
      { amount: 2.49, billable: false },
      { amount: 3.29, billable: false },
      { amount: 0.1, billable: false },
    ]);
    expect(split.billed).toBe(94.12);
    expect(split.notBilled).toBe(5.88);
    expect(split.notBilledCount).toBe(3);
  });

  it("always adds back up to what the receipt cost", () => {
    const split = splitReceiptBilling(6412.64, [
      { amount: 1.99, billable: false },
      { amount: 0.1, billable: false },
      { amount: 6410.55, billable: true },
    ]);
    expect(round(split.billed + split.notBilled)).toBe(split.cost);
  });

  it("treats a missing flag as billed", () => {
    const split = splitReceiptBilling(50, [{ amount: 50 }]);
    expect(split.billed).toBe(50);
    expect(split.notBilledCount).toBe(0);
  });

  // A misread transcription can claim more non-billable money than the receipt holds. Billing a
  // negative amount would be inventing a figure; the clamp is the refusal to do that.
  it("never bills a negative amount", () => {
    const split = splitReceiptBilling(10, [{ amount: 40, billable: false }]);
    expect(split.billed).toBe(0);
    expect(split.notBilled).toBe(10);
    expect(round(split.billed + split.notBilled)).toBe(split.cost);
  });

  it("rounds to cents instead of trailing float dust", () => {
    const split = splitReceiptBilling(10.1, [
      { amount: 0.1, billable: false },
      { amount: 0.2, billable: false },
    ]);
    expect(split.billed).toBe(9.8);
    expect(split.notBilled).toBe(0.3);
  });

  it("survives a bill with no lines at all", () => {
    expect(splitReceiptBilling(75, [])).toEqual({ cost: 75, billed: 75, notBilled: 0, notBilledCount: 0, partBilledCount: 0 });
    expect(splitReceiptBilling(null, null)).toEqual({ cost: 0, billed: 0, notBilled: 0, notBilledCount: 0, partBilledCount: 0 });
  });

  // A returned snack is a credit the company keeps, so the customer's half can legitimately come
  // out above the receipt's net total. That is arithmetic, not a bug — assert it stays that way.
  it("handles a returned line that was never the customer's", () => {
    const split = splitReceiptBilling(97, [
      { amount: 100, billable: true },
      { amount: -3, billable: false },
    ]);
    expect(split.billed).toBe(100);
    expect(split.notBilled).toBe(-3);
  });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * THE RECEIPT THAT BROKE IT. Erik scanned this into the Waldow job at 05:37 UTC on 2026-09-19,
 * twelve minutes after the Food & Drink prompt rule shipped. Every one of these lines is
 * transcribed exactly as the reader stored it, "Other" and all — this is the input the deployed
 * build actually produced with the correct prompt in front of it.
 */
const THE_OSH_RECEIPT = [
  { description: "Kettle Chip Honey Dijon", amount: 2.09, category: "Other" },
  { description: "Kettle Chips Salt/Pepper", amount: 2.09, category: "Other" },
  { description: "Ice Cream Bar Choc Almond", amount: 4.99, category: "Other" },
  { description: "Bulk Fastener", amount: 6.1, category: "Fasteners" },
  { description: "Tax", amount: 1.01, category: "Tax" },
];

describe("the net under the model: the OSH receipt, replayed", () => {
  const decided = THE_OSH_RECEIPT.map((l) => ({
    description: l.description,
    amount: l.amount,
    ...decideReceiptLine(l.description, l.category, undefined),
  }));
  const byName = (name: string) => decided.find((l) => l.description === name)!;

  it("catches both bags of chips, singular and plural", () => {
    // "Kettle Chip" — SINGULAR on the real paper. A plural-only list would have missed it and
    // billed the homeowner $2.09 for a bag of chips, which is the entire point of this file.
    expect(byName("Kettle Chip Honey Dijon")).toMatchObject({ category: FOOD_AND_DRINK, billable: false });
    expect(byName("Kettle Chips Salt/Pepper")).toMatchObject({ category: FOOD_AND_DRINK, billable: false });
  });

  it("catches the ice cream bar", () => {
    expect(byName("Ice Cream Bar Choc Almond")).toMatchObject({ category: FOOD_AND_DRINK, billable: false });
  });

  it("does not touch the fastener the model DID classify", () => {
    expect(byName("Bulk Fastener")).toMatchObject({ category: "Fasteners", billable: true });
  });

  it("does not touch tax — a pass-through cost stays billed", () => {
    expect(byName("Tax")).toMatchObject({ category: "Tax", billable: true });
  });

  it("leaves the customer paying for the parts and nothing else", () => {
    const eaten = decided.filter((l) => !l.billable).reduce((s, l) => s + l.amount, 0);
    expect(Math.round(eaten * 100) / 100).toBe(9.17);
    expect(decided.filter((l) => !l.billable)).toHaveLength(3);
  });
});

/**
 * THE TRAPS. Every line here is a real thing off a real hardware shelf whose name contains a food
 * word. Wrongly zeroing one of these is worse than missing a snack: a snack Erik can flip back on
 * from the receipt card, while a part quietly excluded is money he never invoices and never sees
 * go missing. These are written first and they are the reason the term list is as short as it is.
 */
describe("the traps: parts that sound like lunch stay billable", () => {
  const PARTS = [
    "Water Heater Element 4500W",
    "Drinking Water Safe Hose 25 ft",
    "Coke-Bottle Lens Fixture",
    "Pop Rivet 1/8 in 100 pk",
    "Candy Cane Wrap Spiral 1/2 in",
    "Wire Nuts Red 100 pk",
    "Rock Salt 50 lb",
    "Ice Melt 25 lb",
    "Ice & Water Shield Roll",
    "Icemaker Supply Line",
    "Chip Brush 2 in 12 pk",
    "Wood Chips 2 cu ft",
    "Paint Chip Sample Card",
    "Pry Bar 18 in",
    "Rebar Tie Wire",
    "Bus Bar Kit 200A",
    "Muffin Fan 120mm",
    "Honey Oak Stain Qt",
    "Candy Apple Red Enamel",
    "Chocolate Brown Caulk",
    "Coffee Bean Stain Qt",
    "Coffee Table Leg Set",
    "Milk Paint Quart",
    "Baking Soda 2 lb",
    "Soda Ash 5 lb",
    "Bone Meal 4 lb",
    "Cheese Cloth 5 yd",
    "Tea Light Candles 50 ct",
    "Sandwich Panel Clip",
    "Beer Tap Faucet Chrome",
    "Taco 007 Circulator Pump",
    "Monster Cable 12 ft",
    "Mint Green Spray Paint",
    "Sub Panel 100A",
    "Chipboard Underlayment",
    "Chipping Hammer",
  ];

  it.each(PARTS)("leaves %s alone", (description) => {
    expect(looksLikeFoodAndDrink(description)).toBe(false);
    expect(decideReceiptLine(description, "Other", undefined)).toEqual({ category: "Other", billable: true });
  });

  // A description holding BOTH a trap and a term is exactly the case where guessing is worst, so
  // the trap wins outright and the line keeps billing.
  it("keeps billing when a line is both at once", () => {
    expect(looksLikeFoodAndDrink("Chip Brush and Chips")).toBe(false);
  });

  it("matches on whole words, never on a substring", () => {
    // If this ever becomes a substring scan, these are the lines that start going unbilled.
    expect(looksLikeFoodAndDrink("Device Box 4 in")).toBe(false); // "ice" inside "device"
    expect(looksLikeFoodAndDrink("Teak Oil 16 oz")).toBe(false); // "tea" inside "teak"
    expect(looksLikeFoodAndDrink("Milkweed Seed")).toBe(false); // "milk" inside "milkweed"
    expect(looksLikeFoodAndDrink("Cokewood Insulator")).toBe(false); // "coke" inside a word
  });

  it("says nothing about an empty or missing description", () => {
    expect(looksLikeFoodAndDrink("")).toBe(false);
    expect(looksLikeFoodAndDrink(null)).toBe(false);
    expect(looksLikeFoodAndDrink(undefined)).toBe(false);
    expect(looksLikeFoodAndDrink("   ")).toBe(false);
  });
});

describe("the net recognises the rest of the snack aisle", () => {
  const SNACKS = [
    "SMARTWATER 1L",
    "BodyArmor Lyte 16oz",
    "GATORADE COOL BLUE",
    "Red Bull 12 oz",
    "Coca-Cola 20 oz",
    "COKE 2 LITER",
    "Mountain Dew 20 oz",
    "Snickers Candy Bar",
    "CRV",
    "Bottle Deposit",
    "Crew Lunch",
    "Coffee 12 oz",
    "Bottled Water 24 pk",
    "Beef Jerky Original",
    "Granola Bar Variety",
  ];

  it.each(SNACKS)("files %s as food and drink", (description) => {
    expect(decideReceiptLine(description, "Other", undefined)).toEqual({
      category: FOOD_AND_DRINK,
      billable: false,
    });
  });
});

describe("the net only ever reclassifies upward, out of a shrug", () => {
  it("fills in the categories that are the model shrugging", () => {
    for (const shrug of ["Other", "other", "Misc", "Miscellaneous", "Unknown", "Uncategorized", "N/A", "", null, undefined]) {
      expect(isUnclassifiedCategory(shrug)).toBe(true);
      expect(resolveReceiptLineCategory("Kettle Chips Salt/Pepper", shrug)).toBe(FOOD_AND_DRINK);
    }
  });

  // THE LINE THAT MUST NOT MOVE. A category the model actually chose is never second-guessed,
  // however much the words look like lunch — an "Ice Cream Machine Breaker" filed as Electrical
  // is an electrician's job cost, and this net has no business deciding otherwise.
  it("never second-guesses a category the model actually chose", () => {
    for (const real of ["Fasteners", "Electrical", "Materials", "Tools", "Lumber", "Plumbing", "Paint", "Rental", "Tax"]) {
      expect(isUnclassifiedCategory(real)).toBe(false);
      expect(resolveReceiptLineCategory("Ice Cream Machine Breaker 20A", real)).toBe(real);
      expect(decideReceiptLine("Chips and Soda", real, undefined).billable).toBe(true);
    }
  });

  it("leaves a category the model invented alone as well", () => {
    // Not one of ours, but it is still the model deciding rather than shrugging.
    expect(resolveReceiptLineCategory("Kettle Chips", "Strut & Clamp")).toBe("Strut & Clamp");
  });

  it("leaves a shrug alone when the words are not food", () => {
    expect(resolveReceiptLineCategory("1/2 in EMT Connector", "Other")).toBe("Other");
    expect(resolveReceiptLineCategory("1/2 in EMT Connector", null)).toBe(null);
  });
});

describe("a person's switch outranks the net", () => {
  // The net renames a shrug. It never overrules a human. Erik buying the crew lunch and deciding
  // to bill it on a T&M job is his call, and re-filing that receipt must not undo it.
  it("keeps an explicit true on a snack the net would have zeroed", () => {
    expect(decideReceiptLine("Kettle Chips Salt/Pepper", "Other", true)).toEqual({
      category: FOOD_AND_DRINK,
      billable: true,
    });
  });

  it("keeps an explicit false on a part the net would have billed", () => {
    expect(decideReceiptLine("1/2 in EMT Connector", "Electrical", false)).toEqual({
      category: "Electrical",
      billable: false,
    });
  });

  it("only treats a real boolean as a decision", () => {
    expect(decideReceiptLine("Kettle Chips", "Other", "true").billable).toBe(false);
    expect(decideReceiptLine("Kettle Chips", "Other", null).billable).toBe(false);
  });
});

describe("what the prompts are told", () => {
  it("names Food & Drink in the schema line itself, not only in the trailing rule", () => {
    expect(RECEIPT_LINE_CATEGORY_SCHEMA_HINT).toContain(RECEIPT_LINE_CATEGORY_CHOICES);
    expect(RECEIPT_LINE_CATEGORY_SCHEMA_HINT).toContain('"Food & Drink"');
    // The example is the real line off the receipt that broke it.
    expect(RECEIPT_LINE_CATEGORY_SCHEMA_HINT).toContain("Kettle Chips");
    expect(RECEIPT_LINE_CATEGORY_SCHEMA_HINT).toContain('never "Other"');
  });
});

describe("the trade words that must never read as food (cn-v962 review)", () => {
  /**
   * Every one of these is real supply-house stock an electrician buys, and every one of them was
   * classified as Food & Drink by the first version of this matcher. A snack billed by mistake is
   * one tap to fix on the receipt card; a part silently excluded is money Erik never sees again,
   * so these are the cases the list is shaped around.
   */
  const TRADE_NOT_FOOD = [
    "Popcorn Ceiling Texture Spray 14oz",
    "Popcorn Ceiling Patch",
    "Popcorn Texture Scraper",
    "Milk Glass Globe Shade 6 in",
    "Milk Glass Pendant Shade",
    "Milk Crate Storage",
    "Milk Paint Quart",
    "Soda Blasting Media 50 lb",
    "Soda Blast Abrasive",
    "Baking Soda 2 lb",
    "Water Heater Element 4500W",
    "Drinking Water Safe PEX 1/2 in",
    "Pop Rivet Assortment",
    "Pop Rivets 1/8 in",
  ];
  for (const description of TRADE_NOT_FOOD) {
    it(`leaves "${description}" alone`, () => {
      expect(looksLikeFoodAndDrink(description)).toBe(false);
    });
  }
});

describe("the OSH receipt that failed the first real test", () => {
  /**
   * Erik scanned this into the Waldow job 12 minutes after the feature shipped. The model filed
   * the chips and the ice cream bar as "Other" and left every line billable, so his customer would
   * have been charged for ice cream. The prompt told it plainly and it did not listen, which is
   * why there is a deterministic net underneath it now.
   */
  const REAL = [
    { description: "Kettle Chip Honey Dijon", food: true },
    { description: "Kettle Chips Salt/Pepper", food: true },
    { description: "Ice Cream Bar Choc Almond", food: true },
    { description: "Bulk Fastener", food: false },
    { description: "Tax", food: false },
  ];
  for (const r of REAL) {
    it(`${r.food ? "catches" : "leaves"} "${r.description}"`, () => {
      expect(looksLikeFoodAndDrink(r.description)).toBe(r.food);
    });
  }
});

describe("a masked price is not a masked card number (cn-v963 review)", () => {
  /**
   * The reader is told to transcribe every line and to read "****1234" as evidence of tender, so
   * the first version of this check pulled ordinary card-paid receipts out of the price book.
   */
  it("reads asterisks standing where a price was removed", () => {
    expect(looksProvisionallyPriced("IDEAL 30641 Twister 341-Tan    *****")).toBe(true);
    expect(looksProvisionallyPriced("Extended  *****  pricing pending Truckee")).toBe(true);
  });
  it("ignores a masked card number, spaced or not", () => {
    expect(looksProvisionallyPriced("VISA ****1234")).toBe(false);
    expect(looksProvisionallyPriced("PAID  **** 4242  THANK YOU")).toBe(false);
    expect(looksProvisionallyPriced("MASTERCARD ************9012")).toBe(false);
  });
  it("ignores a lone star or a footnote marker", () => {
    expect(looksProvisionallyPriced("Item * see reverse")).toBe(false);
    expect(looksProvisionallyPriced("Sale ** while supplies last")).toBe(false);
  });
  it("is quiet on nothing at all", () => {
    expect(looksProvisionallyPriced(null)).toBe(false);
    expect(looksProvisionallyPriced("")).toBe(false);
  });
});

describe("spotting a container on a receipt line (0272)", () => {
  /**
   * A count is offered ONLY when it sits beside a container word. "500/BX" and "100PK" are how a
   * supply house actually prints a pack size; a bare round number anywhere in the text is not.
   */
  it("offers the count a description states plainly", () => {
    expect(containerCountInDescription("Wire Nut Red 100PK")).toBe(100);
    expect(containerCountInDescription("Staples 500/BX")).toBe(500);
    expect(containerCountInDescription("1/2 in Connector 250 CT")).toBe(250);
  });

  it("will not read an amperage, a footage or a conductor count as a pack size", () => {
    /**
     * THE HEURISTICS THAT CAME OUT (review of cn-v964), each one run against real supply-house
     * text. A bare round number matched "SQD QO 100 AMP MAIN BREAKER" as a box of 100 and
     * "ROMEX 14-2 W/G 250" as 250 pieces; the /C and /M trade shorthand matched "18/C", which is
     * eighteen CONDUCTOR cable. Every one of those was then stated as fact beside a one-press
     * "Use N" button, putting a wrong guess one tap from a wrong invoice.
     */
    expect(containerCountInDescription("SQD QO 100 AMP MAIN BREAKER")).toBeNull();
    expect(containerCountInDescription("50 AMP RECEPTACLE")).toBeNull();
    expect(containerCountInDescription("ROMEX 14-2 W/G 250")).toBeNull();
    expect(containerCountInDescription("18/C 18AWG SHIELDED")).toBeNull();
    expect(containerCountInDescription("Wire Nut Tan /C")).toBeNull();
  });

  it("does not guess Erik's own Twister line, and says nothing instead", () => {
    // "IDEAL 30641 500/5000 Twister 341-Tan" is the row that started the whole feature. 30641 is a
    // part number and "500/5000" is a catalogue spec, not a pack size beside a container word - so
    // the app asks him for the count rather than offering one it read out of a product name. That
    // is the same mistake the quantity column already made on this exact line.
    expect(containerCountInDescription("IDEAL 30641 500/5000 Twister 341-Tan")).toBeNull();
  });

  it("does not read a catalogue number or a colour code as a count", () => {
    // "30641" is IDEAL's part number and "341-Tan" is the colour. Offering either as "how many
    // are in the box" would divide his money by a number that means nothing.
    expect(containerCountInDescription("IDEAL 30641 Twister 341-Tan")).toBeNull();
    expect(containerCountInDescription("Square D QO120 Breaker")).toBeNull();
    expect(containerCountInDescription("12 AWG THHN Black")).toBeNull();
    expect(containerCountInDescription("Panel 125A Main Lug")).toBeNull();
    expect(containerCountInDescription("")).toBeNull();
    expect(containerCountInDescription(null)).toBeNull();
  });

  it("flags a likely container and says why", () => {
    const box = containerHint("Wire Nut Red 100PK", 100);
    expect(box.looksLikeContainer).toBe(true);
    expect(box.count).toBe(100);
    expect(box.why).toContain("100");

    const spool = containerHint("THHN 12 AWG Black Spool", 1);
    expect(spool.looksLikeContainer).toBe(true);
    expect(spool.count).toBeNull();
  });

  it("flags a big quantity WITHOUT offering it as the count", () => {
    /**
     * The whole reason this rule is written down. Erik reached for the quantity heuristic himself
     * and his own line disproves it: that Twister row reads 500 because the scanner took it from
     * the product name, not because five hundred boxes were bought. A big quantity is a reason to
     * look at a row. It is never the number the money is divided by.
     */
    const hint = containerHint("Bulk Fastener Assorted", 240);
    expect(hint.looksLikeContainer).toBe(true);
    expect(hint.count).toBeNull();
  });

  it("leaves an ordinary part alone", () => {
    expect(containerHint("Square D QO120 Breaker", 6).looksLikeContainer).toBe(false);
    expect(containerHint("125A Main Lug Load Center", 1).looksLikeContainer).toBe(false);
    expect(containerHint(null, null).looksLikeContainer).toBe(false);
  });

  it("never decides anything - the hint carries no billing state at all", () => {
    // A suggestion that could write would be a default, and a default here changes what a
    // customer is charged without anybody saying so.
    const hint = containerHint("IDEAL 30641 Twister 341-Tan 500", 500);
    expect(Object.keys(hint).sort()).toEqual(["count", "looksLikeContainer", "why"]);
  });
});

describe("the arithmetic Erik did in his head", () => {
  it("says 21.7 cents each for the box that started this", () => {
    const unit = perUnitCost(108.36, 500);
    expect(unit).toBeCloseTo(0.21672, 5);
    expect(perUnitLabel(unit)).toBe("21.7 cents each");
  });

  it("bills sixty of them at $13.00", () => {
    // $16.25 with his 25% markup, which is the $16.20 he typed onto the invoice by hand.
    expect(usedCost(60, perUnitCost(108.36, 500))).toBe(13);
  });

  it("splits the eight ounce jar by the ounce", () => {
    expect(perUnitLabel(perUnitCost(20.65, 8))).toBe("$2.58 each");
    expect(usedCost(1, perUnitCost(20.65, 8))).toBe(2.58);
  });

  it("turns a dollar figure back into a rough count, for the shelf and never for the invoice", () => {
    // 59.99, not 60. The invoice row says dollars for exactly this reason: nobody typed a 60,
    // and rounding this one up would print a count on a customer's bill that no person chose.
    expect(usedCountFromCost(13, perUnitCost(108.36, 500))).toBeCloseTo(59.99, 2);
  });

  it("stays quiet rather than dividing by nothing", () => {
    expect(perUnitCost(108.36, 0)).toBeNull();
    expect(perUnitCost(108.36, null)).toBeNull();
    expect(perUnitCost(0, 500)).toBeNull();
    expect(perUnitLabel(null)).toBe("");
    expect(perUnitLabel(0)).toBe("");
    expect(usedCost(60, null)).toBe(0);
    expect(usedCountFromCost(13, 0)).toBeNull();
  });

  it("drops the tenth of a cent when there is not one", () => {
    expect(perUnitLabel(0.25)).toBe("25 cents each");
    expect(perUnitLabel(1)).toBe("$1.00 each");
  });
});

describe("a receipt with a container split across the shelf and the job", () => {
  it("counts the shelf's share against the customer's half", () => {
    // The real ticket: the box of Twisters, the jar of Noalox, and sixty nuts on this job.
    const split = splitReceiptBilling(139.65, [
      { amount: 108.36, billable: true, billedAmount: 13 },
      { amount: 20.65, billable: true },
      { amount: 10.64, billable: true },
    ]);
    expect(split.billed).toBe(44.29);
    expect(split.notBilled).toBe(95.36);
    expect(split.partBilledCount).toBe(1);
    expect(split.notBilledCount).toBe(0);
  });

  it("keeps the two facts apart: switched off is not the same as billed in part", () => {
    const split = splitReceiptBilling(139.65, [
      { amount: 108.36, billable: true, billedAmount: 13 },
      { amount: 20.65, billable: false },
      { amount: 10.64, billable: true },
    ]);
    expect(split.notBilledCount).toBe(1);
    expect(split.partBilledCount).toBe(1);
    expect(split.billed).toBe(23.64);
  });

  it("treats a missing split as the whole line, exactly as before 0272", () => {
    const split = splitReceiptBilling(120.5, [
      { amount: 100, billable: true },
      { amount: 20.5, billable: true, billedAmount: null },
    ]);
    expect(split).toEqual({ cost: 120.5, billed: 120.5, notBilled: 0, notBilledCount: 0, partBilledCount: 0 });
  });

  it("still adds back up to what the receipt cost", () => {
    const split = splitReceiptBilling(139.65, [
      { amount: 108.36, billable: true, billedAmount: 13 },
      { amount: 20.65, billable: true, billedAmount: 2.58 },
      { amount: 10.64, billable: true },
    ]);
    expect(round(split.billed + split.notBilled)).toBe(split.cost);
  });

  it("does not let a split bill more of a line than the line cost", () => {
    const split = splitReceiptBilling(108.36, [{ amount: 108.36, billable: true, billedAmount: 999 }]);
    expect(split.billed).toBe(108.36);
    expect(split.partBilledCount).toBe(1);
  });
});
