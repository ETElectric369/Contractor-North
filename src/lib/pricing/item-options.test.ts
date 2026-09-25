import { describe, it, expect } from "vitest";
import {
  ITEM_OPTIONS_EMBED,
  ITEM_OWN_OPTION_ID,
  ITEM_OWN_OPTION_LABEL,
  baseLineDescription,
  chooseItemOption,
  defaultItemOptionId,
  hasItemOptions,
  itemOptionChoices,
  missingOptionMessage,
  normalizeItemOptions,
  type OptionedPriceItem,
  type PriceItemOptionRow,
} from "@/lib/pricing/item-options";
import type { PriceItemLite } from "@/components/add-line-items";

/**
 * THE REAL ROW. Vivian Builders' code 830 as it sits in the database today:
 * "Windows (Materials) (Allowance)", $830.00, unit ea, markup 0.00, no supplier — and the org's
 * default_markup_pct is 0, which is why this org is the sharp test case. Every number here is
 * either theirs or a maker price hung under it; the strings are strings because PostgREST hands
 * numerics back as strings and a Number() that isn't there is a wrong price.
 */
const item830 = (options?: PriceItemOptionRow[] | PriceItemOptionRow | null): OptionedPriceItem => ({
  code: "830",
  description: "Windows (Materials) (Allowance)",
  unit: "ea",
  buy_price: "830.00",
  markup_pct: "0.00",
  price_list_item_options: options ?? null,
});

const ANDERSEN: PriceItemOptionRow = {
  id: "opt-andersen",
  vendor: "Andersen",
  label: "400 Series",
  part_number: null,
  unit: null,
  buy_price: "1240.00",
  markup_pct: null, // falls through to the item's, then the org default
  is_default: true,
  sort_order: 1,
};
const MILGARD: PriceItemOptionRow = {
  id: "opt-milgard",
  vendor: "Milgard",
  label: "Tuscany",
  part_number: "TUS-3050",
  unit: null,
  buy_price: "980.00",
  markup_pct: null,
  is_default: false,
  sort_order: 2,
};
const MARVIN: PriceItemOptionRow = {
  id: "opt-marvin",
  vendor: "Marvin",
  label: "Elevate",
  part_number: null,
  unit: null,
  buy_price: "1610.00",
  markup_pct: "12.50", // this maker states its own
  is_default: false,
  sort_order: 0,
};
const THREE = [ANDERSEN, MILGARD, MARVIN];

describe("an item with NO makers is untouched by any of this", () => {
  it("offers exactly one choice, and it is the item as it stands", () => {
    const choices = itemOptionChoices(item830(), {});
    expect(choices).toHaveLength(1);
    expect(choices[0].isItemOwn).toBe(true);
    expect(choices[0].id).toBe(ITEM_OWN_OPTION_ID);
    expect(choices[0].makerLabel).toBe(ITEM_OWN_OPTION_LABEL);
  });

  it("writes the SAME line the pickers already write (code — description, item unit, item price)", () => {
    const [own] = itemOptionChoices(item830(), {});
    expect(own.description).toBe("830 — Windows (Materials) (Allowance)");
    expect(own.unit).toBe("ea");
    // Vivian: item markup 0, org default 0 → the line is the allowance, to the penny.
    expect(own.unitPrice).toBe(830);
  });

  it("hasItemOptions is false, so a picker knows not to render a dropdown at all", () => {
    expect(hasItemOptions(item830())).toBe(false);
    expect(hasItemOptions(item830([]))).toBe(false);
    expect(hasItemOptions(null)).toBe(false);
  });

  it("an item with no code still gets a plain description", () => {
    expect(baseLineDescription({ code: null, description: "Windows", buy_price: 830 })).toBe("Windows");
  });
});

describe("WHICH maker is chosen", () => {
  it("the flagged one opens selected", () => {
    expect(defaultItemOptionId(item830(THREE))).toBe("opt-andersen");
  });

  it("nothing flagged → the item's own allowance price, not the cheapest or the first maker", () => {
    const unflagged = THREE.map((o) => ({ ...o, is_default: false }));
    expect(defaultItemOptionId(item830(unflagged))).toBe(ITEM_OWN_OPTION_ID);
    expect(chooseItemOption(item830(unflagged), defaultItemOptionId(item830(unflagged)), {})!.unitPrice).toBe(830);
  });

  it("the allowance is first, then the flagged maker, then the org's own order", () => {
    // Deliberately the SAME order the price-list screen lists them in
    // (price-list/item-options-math.ts → sortItemOptions). Two screens, one order, or picking
    // "the second one" means two different windows depending which screen you were looking at.
    const rows = itemOptionChoices(item830(THREE), {});
    expect(rows.map((r) => r.makerLabel)).toEqual([
      ITEM_OWN_OPTION_LABEL,
      "Andersen 400 Series", // flagged, so it sits right under the allowance
      "Marvin Elevate", // then sort_order 0
      "Milgard Tuscany", // then 2
    ]);
  });

  it("an empty pick means the allowance — an unselected dropdown is not a failure", () => {
    expect(chooseItemOption(item830(THREE), "", {})!.isItemOwn).toBe(true);
    expect(chooseItemOption(item830(THREE), null, {})!.isItemOwn).toBe(true);
    expect(chooseItemOption(item830(THREE), undefined, {})!.unitPrice).toBe(830);
  });

  it("a pick that is no longer on the code returns NULL, never the allowance", () => {
    // The Marvin row was archived while the estimate sat open. Quoting $830 for it would be the
    // exact wrong number this whole feature exists to prevent, so the caller has to say so.
    expect(chooseItemOption(item830([ANDERSEN, MILGARD]), "opt-marvin", {})).toBeNull();
    expect(missingOptionMessage(item830())).toContain("830");
  });
});

describe("WHAT THE DESCRIPTION BECOMES — the customer reads it, the crew orders from it", () => {
  it("names the maker and the product line", () => {
    expect(chooseItemOption(item830(THREE), "opt-andersen", {})!.description).toBe(
      "830 — Windows (Materials) (Allowance) (Andersen 400 Series)",
    );
  });

  it("carries the part number when the org typed one", () => {
    expect(chooseItemOption(item830(THREE), "opt-milgard", {})!.description).toBe(
      "830 — Windows (Materials) (Allowance) (Milgard Tuscany, #TUS-3050)",
    );
  });

  it("a maker with no product line is just the maker", () => {
    const bare = { ...MARVIN, label: null, id: "opt-bare" };
    expect(chooseItemOption(item830([bare]), "opt-bare", {})!.description).toBe(
      "830 — Windows (Materials) (Allowance) (Marvin)",
    );
  });
});

describe("WHAT IT COSTS — through the one markup rule, never re-derived here", () => {
  it("Vivian's org default of 0: the line is the maker's cost, to the penny", () => {
    const pricing = { levelPct: null, orgDefaultPct: 0 };
    expect(chooseItemOption(item830(THREE), "opt-andersen", pricing)!.unitPrice).toBe(1240);
    expect(chooseItemOption(item830(THREE), "opt-milgard", pricing)!.unitPrice).toBe(980);
    // Marvin states 12.5% of its own, so it is NOT net even at an org default of 0.
    expect(chooseItemOption(item830(THREE), "opt-marvin", pricing)!.unitPrice).toBe(1811.25);
  });

  it("an option that states no markup falls through to the item's, then the org default", () => {
    // Item 830's own markup is 0 = "no markup set", so the org default lands.
    const viaOrg = chooseItemOption(item830(THREE), "opt-andersen", { orgDefaultPct: 20 })!;
    expect(viaOrg.markupPct).toBe(20);
    expect(viaOrg.unitPrice).toBe(1488);
    // Give the ITEM a real markup and it wins over the org default, as it always has.
    const marked = { ...item830(THREE), markup_pct: "35.00" };
    expect(chooseItemOption(marked, "opt-andersen", { orgDefaultPct: 20 })!.markupPct).toBe(35);
    expect(chooseItemOption(marked, "opt-andersen", { orgDefaultPct: 20 })!.unitPrice).toBe(1674);
  });

  it("an option that states its own markup wins over the item's", () => {
    const marked = { ...item830(THREE), markup_pct: "35.00" };
    expect(chooseItemOption(marked, "opt-marvin", { orgDefaultPct: 20 })!.markupPct).toBe(12.5);
  });

  it("a maker typed at 0.00 sells at cost — a typed zero is a decision, an empty box is not", () => {
    // The price-list screen shows this option's sell price under the same reading
    // (price-list/item-options-math.ts → optionView), and the two must agree to the penny or the
    // number Justin sets is not the number his customer is quoted.
    const atCost = { ...ANDERSEN, id: "opt-at-cost", markup_pct: "0.00" };
    const marked = { ...item830([atCost]), markup_pct: "35.00" };
    const pick = chooseItemOption(marked, "opt-at-cost", { orgDefaultPct: 20 })!;
    expect(pick.markupPct).toBe(0);
    expect(pick.unitPrice).toBe(1240);
    // Blank on the same maker is an absence, so the item's 35% answers instead.
    const blank = chooseItemOption({ ...marked, price_list_item_options: [{ ...atCost, markup_pct: null }] }, "opt-at-cost", {
      orgDefaultPct: 20,
    })!;
    expect(blank.markupPct).toBe(35);
  });

  it("a level still outranks a maker typed at 0.00", () => {
    const atCost = { ...ANDERSEN, id: "opt-at-cost", markup_pct: "0.00" };
    expect(chooseItemOption(item830([atCost]), "opt-at-cost", { levelPct: 5, orgDefaultPct: 20 })!.markupPct).toBe(5);
  });

  it("the customer's pricing level still wins over every maker's markup — including at 0%", () => {
    const level = { levelPct: 5, orgDefaultPct: 20 };
    expect(chooseItemOption(item830(THREE), "opt-marvin", level)!.unitPrice).toBe(1690.5);
    expect(chooseItemOption(item830(THREE), "opt-andersen", level)!.unitPrice).toBe(1302);
    // A level of 0 means this customer buys at net; it must not fall through to the org default.
    expect(chooseItemOption(item830(THREE), "opt-marvin", { levelPct: 0, orgDefaultPct: 20 })!.unitPrice).toBe(1610);
  });

  it("rounds to cents the way sellPrice does — numeric(12,4) costs do not leak fractions of a cent", () => {
    const odd = { ...MARVIN, id: "opt-odd", buy_price: "1240.3333", markup_pct: "12.50" };
    // 1240.3333 * 1.125 = 1395.3749625 → 1395.37
    expect(chooseItemOption(item830([odd]), "opt-odd", {})!.unitPrice).toBe(1395.37);
  });

  it("reports the cost and the markup it used, so a screen can show its work", () => {
    const pick = chooseItemOption(item830(THREE), "opt-marvin", { orgDefaultPct: 20 })!;
    expect(pick.buyPrice).toBe(1610);
    expect(pick.markupPct).toBe(12.5);
  });
});

describe("the UNIT comes from the maker when it has one, then the item", () => {
  it("falls back to the item's unit", () => {
    expect(chooseItemOption(item830(THREE), "opt-andersen", {})!.unit).toBe("ea");
  });

  it("a maker that sells by a different unit says so", () => {
    const pair = { ...MILGARD, id: "opt-pair", unit: "pr" };
    expect(chooseItemOption(item830([pair]), "opt-pair", {})!.unit).toBe("pr");
  });

  it("never lands on an empty unit", () => {
    const noUnit: OptionedPriceItem = { ...item830([{ ...ANDERSEN, unit: "" }]), unit: null };
    expect(chooseItemOption(noUnit, "opt-andersen", {})!.unit).toBe("ea");
    expect(itemOptionChoices(noUnit, {})[0].unit).toBe("ea");
  });
});

describe("reading the embed (THE PROJECTION LAW)", () => {
  it("the select names every column the choice logic reads", () => {
    for (const col of ["id", "vendor", "label", "part_number", "unit", "buy_price", "markup_pct", "is_default", "sort_order"]) {
      expect(ITEM_OPTIONS_EMBED).toContain(col);
    }
    expect(ITEM_OPTIONS_EMBED.startsWith("price_list_item_options(")).toBe(true);
  });

  it("a single-row embed arriving as a bare object is still a maker, not a dropped one", () => {
    expect(normalizeItemOptions(ANDERSEN)).toHaveLength(1);
    expect(hasItemOptions(item830(ANDERSEN))).toBe(true);
  });

  it("null, junk rows and a blank vendor are not makers", () => {
    expect(normalizeItemOptions(null)).toEqual([]);
    expect(normalizeItemOptions([{ ...ANDERSEN, vendor: "  " }])).toEqual([]);
    expect(normalizeItemOptions([{ ...ANDERSEN, id: "" }])).toEqual([]);
  });

  it("an archived maker is never offered, even if a caller hands one over", () => {
    const rows = [{ ...ANDERSEN, archived: true }, MILGARD] as PriceItemOptionRow[];
    expect(normalizeItemOptions(rows).map((o) => o.id)).toEqual(["opt-milgard"]);
  });

  /**
   * THE HAND-OFF SHAPE, held by the compiler. The pickers pass their own PriceItemLite rows
   * straight into this module; if that type and this one ever stop lining up, the dropdown would
   * be wired with a cast and a cast is where a dropped field hides (THE PROJECTION LAW). A row
   * from the picker's type, plus the embed, must BE an OptionedPriceItem with no coercion.
   */
  it("a picker's own row, plus the embed, is an OptionedPriceItem", () => {
    const fromPicker: PriceItemLite & { price_list_item_options?: PriceItemOptionRow[] } = {
      id: "a5094866-b2b3-443d-ae32-fff79cda4125",
      code: "830",
      description: "Windows (Materials) (Allowance)",
      category: null,
      unit: "ea",
      buy_price: 830,
      markup_pct: 0,
      price_list_item_options: [ANDERSEN],
    };
    const asItem: OptionedPriceItem = fromPicker; // compile-time: no cast, no widening
    expect(defaultItemOptionId(asItem)).toBe("opt-andersen");
    expect(chooseItemOption(asItem, "opt-andersen", {})!.unitPrice).toBe(1240);
  });
});
