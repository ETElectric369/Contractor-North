import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ITEM_OPTIONS_EMBED,
  bookLineBuy,
  describeChoice,
  optionNamedIn,
  pickerChoices,
  pickerSummary,
  priceBookLine,
  type BookPricing,
  type OptionedPriceItem,
} from "@/lib/pricing/item-options";
import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";
import { defaultVendorNote, optionView } from "@/app/(app)/price-list/item-options-math";
import { mapEstimatorLine, type BookRow } from "@/lib/estimate/line-map";
import { priceMaterial } from "@/lib/pricing/price-material";

/**
 * AUDIT v994, VP1 + VP2: ONE PRICE PER BOOK ITEM, WHOEVER ASKS.
 *
 * VP1. ET's live numbers: org default 25%, levels Local 15% / Normal 25%, every one of the 152
 * items at markup 0 (a net-cost import). The Add Vendor form sends a blank markup. The price-list
 * sheet said Leviton at $100 sells for $125; every quote picker listed it at $100.00, and "No
 * Vendor Picked" at $100.00 too, because no picker passed the customer's level or the org default
 * to the vendor rows. The item had been $115 / $125 before a vendor existed.
 *
 * VP2. The top picker was the only door that knew a code had a default vendor: the per-line swap,
 * the invoice picker, the estimator and Nort all priced 830 Windows at its $830 allowance while
 * the price list said it priced at the Marvin the org had made the default.
 */

const ET: BookPricing = { levelPct: null, orgDefaultPct: 25 };
const ET_LOCAL: BookPricing = { levelPct: 15, orgDefaultPct: 25 };

const receptacle = (options: OptionedPriceItem["price_list_item_options"] = []): OptionedPriceItem & { id: string } => ({
  id: "rcpt",
  code: "R20",
  description: "20A receptacle",
  unit: "ea",
  buy_price: 100,
  markup_pct: 0,
  price_list_item_options: options,
});
const LEVITON = { id: "o-lev", vendor: "Leviton", label: null, part_number: null, unit: null, buy_price: 100, markup_pct: null, is_default: false, sort_order: 0 };

describe("VP1: a blank-markup vendor sells at what the price-list sheet says, on every picker", () => {
  it("with no customer level, the vendor row and the own row both sell at the org default", () => {
    const rows = pickerChoices(receptacle([LEVITON]), ET);
    const sheet = optionView(LEVITON as never, { unit: "ea", markup_pct: 0 }, 25);
    expect(sheet.sell).toBe(125);
    expect(rows.find((r) => r.makerLabel === "Leviton")!.unitPrice).toBe(sheet.sell);
    expect(rows.find((r) => r.isItemOwn)!.unitPrice).toBe(125);
  });

  it("a Local-level customer gets 15% on the vendor exactly as on the item, never net cost", () => {
    const rows = pickerChoices(receptacle([LEVITON]), ET_LOCAL);
    expect(rows.map((r) => r.unitPrice)).toEqual([115, 115]);
    expect(pickerSummary(receptacle([LEVITON]), ET_LOCAL).ownChoice.unitPrice).toBe(115);
  });

  it("an item with no vendors prices exactly as the old markupFor closure did", () => {
    for (const pricing of [ET, ET_LOCAL, { levelPct: 0, orgDefaultPct: 25 }, { levelPct: null, orgDefaultPct: null }]) {
      for (const markup_pct of [0, 10]) {
        const item = { ...receptacle(), markup_pct };
        const old = sellPrice(100, effectiveMarkupPct({ levelPct: pricing.levelPct, itemPct: markup_pct, orgDefaultPct: pricing.orgDefaultPct }));
        expect(priceBookLine(item, pricing).unitPrice).toBe(old);
        expect(priceBookLine(item, pricing).description).toBe("R20 — 20A receptacle");
      }
    }
  });
});

describe("VP2: priceBookLine is the default vendor when the org made one", () => {
  const MARVIN = { id: "o-mar", vendor: "Marvin", label: null, part_number: null, unit: null, buy_price: 1610, markup_pct: null, is_default: true, sort_order: 0 };
  const ANDERSEN = { id: "o-and", vendor: "Andersen", label: "400 Series", part_number: null, unit: null, buy_price: 1240, markup_pct: null, is_default: false, sort_order: 1 };
  const windows = (opts: unknown[]): OptionedPriceItem => ({
    code: "830",
    description: "Windows (Materials) (Allowance)",
    unit: "ea",
    buy_price: 830,
    markup_pct: 0,
    price_list_item_options: opts as never,
  });
  const VIVIAN: BookPricing = { levelPct: null, orgDefaultPct: 0 };

  it("prices at the default vendor and names it, not the allowance", () => {
    const line = priceBookLine(windows([ANDERSEN, MARVIN]), VIVIAN);
    expect(line.unitPrice).toBe(1610);
    expect(line.buyPrice).toBe(1610);
    expect(line.isItemOwn).toBe(false);
    expect(line.description).toBe("830 — Windows (Materials) (Allowance) (Marvin)");
  });

  it("with vendors but no default, the item's own price stands", () => {
    expect(priceBookLine(windows([ANDERSEN]), VIVIAN).unitPrice).toBe(830);
    expect(priceBookLine(windows([ANDERSEN]), VIVIAN).isItemOwn).toBe(true);
  });

  it("agrees with the picker's first row, which is the default vendor", () => {
    const item = windows([ANDERSEN, MARVIN]);
    expect(priceBookLine(item, ET_LOCAL)).toEqual(pickerChoices(item, ET_LOCAL)[0]);
  });

  it("describeChoice names the vendor on a caller's own words and leaves the own price alone", () => {
    const item = windows([ANDERSEN, MARVIN]);
    expect(describeChoice("New windows", item, priceBookLine(item, VIVIAN))).toBe("New windows (Marvin)");
    expect(describeChoice("New windows", windows([]), priceBookLine(windows([]), VIVIAN))).toBe("New windows");
  });

  it("the AI estimator prices a book code at the default vendor, named, with its [CODE]", () => {
    const row = { ...windows([ANDERSEN, MARVIN]), code: "830" } as BookRow & { code: string };
    const l = mapEstimatorLine(
      { kind: "material", description: "Replace windows", quantity: 2, unit: "ea", catalog: "830", unit_cost: 830 },
      { rate: 125, byCode: new Map([["830", row]]), levelPct: 10, orgDefaultPct: 0 },
    );
    expect(l.unit_price).toBe(1771); // 1610 + the customer's 10% level
    expect(l.description).toBe("Replace windows (Marvin) [830]");
  });

  it("the order sheet costs an estimator line at the vendor it was sold at, not the allowance", () => {
    const item = windows([ANDERSEN, MARVIN]);
    const row = { ...item, code: "830" } as BookRow & { code: string };
    const l = mapEstimatorLine(
      { kind: "material", description: "Replace windows", quantity: 2, unit: "ea", catalog: "830", unit_cost: 830 },
      { rate: 125, byCode: new Map([["830", row]]), levelPct: null, orgDefaultPct: 0 },
    );
    // What createMaterialListFromQuote does with the saved line: take the [CODE] off, then cost it.
    const cleanDesc = l.description.replace(/\[([^\]]+)\]/, "").trim();
    expect(cleanDesc).toBe("Replace windows (Marvin)");
    expect(bookLineBuy(item, cleanDesc).buyPrice).toBe(1610);
    expect(bookLineBuy(item, cleanDesc).option?.vendor).toBe("Marvin");
    // A line that names no vendor was sold at the code's own number, and costs at it.
    expect(bookLineBuy(item, "Replace windows").buyPrice).toBe(830);
    expect(bookLineBuy(item, "Replace windows").option).toBeNull();
  });

  it("reads the vendor the way describeWithMaker writes it, longest name first", () => {
    const PLAIN = { ...ANDERSEN, id: "o-and-plain", label: null, buy_price: 990, is_default: false };
    const item = windows([PLAIN, ANDERSEN, { ...MARVIN, part_number: "M-1" }]);
    expect(optionNamedIn(item, "830 — Windows (Andersen 400 Series)")?.id).toBe("o-and");
    expect(optionNamedIn(item, "830 — Windows (Andersen)")?.id).toBe("o-and-plain");
    expect(optionNamedIn(item, "830 — Windows (Marvin, #M-1)")?.id).toBe("o-mar");
    expect(optionNamedIn(item, "Marvin windows")).toBeNull(); // not the picker's shape: no guess
  });

  it("Nort's price_material quotes the default vendor too", async () => {
    const rows = [{ ...windows([ANDERSEN, MARVIN]), category: null, supplier: null }];
    const q: any = {
      select: () => q, eq: () => q, order: () => q, limit: () => q, ilike: () => q, or: () => q,
      then: (res: any) => res({ data: rows, error: null }),
    };
    const sb = { from: () => q, rpc: async () => ({ data: [], error: null }) } as any;
    const r = await priceMaterial(sb, { description: "830", levelPct: null, orgDefaultPct: 25 });
    expect(r.source).toBe("book");
    expect(r.buy_price).toBe(1610);
    expect(r.sell_price).toBe(2012.5);
    expect(r.vendor).toBe("Marvin");
    expect(r.description).toContain("Marvin");
  });
});

describe("the rest of the doors that read a vendor-priced line", () => {
  const MARVIN = { id: "o-mar", vendor: "Marvin", label: null, part_number: null, unit: null, buy_price: 1610, markup_pct: null, is_default: true, sort_order: 0 };
  const windows = (code: string, opts: unknown[]) => ({
    code,
    description: `Windows ${code}`,
    category: null,
    supplier: null,
    unit: "ea",
    buy_price: 830,
    markup_pct: 0,
    price_list_item_options: opts as never,
  });

  it("price_material's loose-match alternatives are priced like the top row, vendor and all", async () => {
    const rows = [windows("830", []), windows("831", [MARVIN])];
    let calls = 0;
    const q: any = {
      select: () => q, eq: () => q, order: () => q, limit: () => q, ilike: () => q, or: () => q,
      // exact code, code contains, phrase: nothing; "all words in description" finds both.
      then: (res: any) => res({ data: ++calls >= 4 ? rows : [], error: null }),
    };
    const sb = { from: () => q, rpc: async () => ({ data: [], error: null }) } as any;
    const r = await priceMaterial(sb, { description: "new windows", levelPct: null, orgDefaultPct: 25 });
    expect(r.flagged).toBe(true);
    expect(r.alternatives).toEqual([
      { code: "831", description: "Windows 831 (Marvin)", buy_price: 1610, sell_price: 2012.5, vendor: "Marvin" },
    ]);
  });

  it("the Make Default toast says how far a default reaches, kits included", () => {
    expect(defaultVendorNote("Marvin")).toContain("Marvin is now the default");
    expect(defaultVendorNote()).toMatch(/kit still adds the item's own number/);
  });
});

/**
 * THE DOORS, PINNED BY SOURCE. VP1 was a prop no caller passed and VP2 a select list that left the
 * embed out; both compiled. These fail the build if a picker goes back to a closure of its own or
 * a line-picker page reads the book without its vendors (THE PROJECTION LAW).
 */
describe("every picker takes the one pricing input, and every picker page reads the vendors", () => {
  const root = join(__dirname, "..", "..", "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const pickers = [
    "src/app/(app)/quotes/new/quote-builder.tsx",
    "src/app/(app)/quotes/[id]/quote-items-editor.tsx",
    "src/app/(app)/billing/[id]/invoice-detail.tsx",
  ];

  it("no AddLineItems caller hands it a markupFor closure; each passes pricing", () => {
    for (const p of pickers) {
      const src = read(p);
      const tag = src.slice(src.indexOf("<AddLineItems"), src.indexOf("onAdd=", src.indexOf("<AddLineItems")));
      expect(tag, p).toContain("pricing={");
      expect(tag, p).not.toContain("markupFor");
    }
  });

  it("every page that feeds a line picker selects the vendor embed with the archived filter", () => {
    for (const p of [
      "src/app/(app)/quotes/new/page.tsx",
      "src/app/(app)/quotes/[id]/page.tsx",
      "src/app/(app)/billing/[id]/page.tsx",
      "src/lib/pricing/price-book-search.ts",
      // runEstimator's book read (VP2): lose the embed here and every estimator line silently
      // goes back to the allowance, because the estimator test feeds options in by hand.
      "src/app/(app)/quotes/actions.ts",
      // The order sheet: lose it and a Marvin line is bought at $830 again.
      "src/app/(app)/materials/actions.ts",
    ]) {
      const src = read(p);
      expect(src, p).toContain("ITEM_OPTIONS_EMBED}");
      expect(src, p).toContain('.eq("price_list_item_options.archived", false)');
    }
    expect(ITEM_OPTIONS_EMBED).toContain("is_default");
  });

  it("runEstimator's own book read carries the embed (quotes/actions.ts has two reads; pin this one)", () => {
    const src = read("src/app/(app)/quotes/actions.ts");
    const start = src.indexOf("async function runEstimator(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("getOrgSettings(", start));
    expect(body).toContain("ITEM_OPTIONS_EMBED}");
    expect(body).toContain('.eq("price_list_item_options.archived", false)');
  });

  it("the order sheet costs a book line through bookLineBuy, never the item's bare buy_price", () => {
    const src = read("src/app/(app)/materials/actions.ts");
    expect(src).toContain("bookLineBuy(pl, cleanDesc)");
    expect(src).not.toContain("est_cost: pl ? Number(pl.buy_price)");
  });
});
