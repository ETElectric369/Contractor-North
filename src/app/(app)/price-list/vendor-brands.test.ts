import { describe, it, expect } from "vitest";
import { markupFromSell, sellPrice } from "@/lib/pricing/markup";
import {
  chooseItemOption,
  defaultItemOptionId,
  optionChoice,
  pickerChoices,
  pickerSummary,
  ITEM_OWN_OPTION_LABEL,
} from "@/lib/pricing/item-options";
import {
  canonicalVendorName,
  cleanOptionFields,
  cleanVendorCard,
  knownVendorNames,
  markupForSell,
  optionSellPatch,
  optionView,
  showPct,
  summarizeVendors,
  vendorKey,
  websiteHref,
  type ItemOption,
  type VendorCard,
} from "./item-options-math";
import { costLooksLikeCode, type PriceItem } from "./price-list-math";

/**
 * VENDORS ARE BRANDS, EACH WITH ITS OWN COST AND SELL (Erik for Justin, Vivian Builders,
 * 2026-09-24). The money in here is the difference between an $830 allowance and a $1,610 Marvin
 * window, so every direction of the arithmetic is pinned to the cent.
 */

const item = (over: Partial<PriceItem> = {}): PriceItem => ({
  id: "i830",
  code: "830",
  description: "Windows (Materials) (Allowance)",
  category: null,
  supplier: null,
  unit: "ea",
  buy_price: 830,
  markup_pct: 0,
  archived: false,
  ...over,
});

const opt = (over: Partial<ItemOption> = {}): ItemOption => ({
  id: "o1",
  item_id: "i830",
  vendor: "Andersen",
  label: null,
  part_number: null,
  unit: null,
  buy_price: 1200,
  markup_pct: null,
  is_default: false,
  archived: false,
  sort_order: 1,
  ...over,
});

/** A small deterministic generator, so the sweep is the same on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("typing a Sell sets the markup, and the markup gives back the Sell, to the cent", () => {
  it("a round answer stays round: $1,200 cost sold at $1,500 is 25%, not 25.000000", () => {
    expect(markupForSell(1200, 1500)).toBe(25);
    expect(markupForSell(100, 135)).toBe(35);
    expect(markupForSell(3, 10)).not.toBeNull();
  });

  it("a $12,000 window lands on the cents typed, where two decimals of percent cannot", () => {
    const cost = 12000;
    const typed = 12345.67;
    // The old two-decimal back-solve misses by more than a cent at this size...
    expect(sellPrice(cost, markupFromSell(cost, typed))).not.toBe(typed);
    // ...the vendor row's does not.
    const m = markupForSell(cost, typed)!;
    expect(sellPrice(cost, m)).toBe(typed);
    // And it is written with no more decimals than the column holds (0296: numeric(12,6)).
    expect(Math.round(m * 1e6) / 1e6).toBe(m);
  });

  it("sweeps 5,000 costs and sells from a penny to $400,000 and every one round-trips exactly", () => {
    const r = lcg(824);
    for (let n = 0; n < 5000; n += 1) {
      const cost = Math.round((0.01 + r() * 400000) * 10000) / 10000; // buy_price is numeric(12,4)
      const sell = Math.round(cost * (0.5 + r() * 2) * 100) / 100;
      const m = markupForSell(cost, sell);
      expect(m).not.toBeNull();
      expect(sellPrice(cost, m!)).toBe(sell);
    }
  });

  it("refuses what can't be a markup: no cost, a negative sell, words", () => {
    expect(markupForSell(0, 100)).toBeNull();
    expect(markupForSell(100, -1)).toBeNull();
    expect(optionSellPatch({ buy_price: 0 }, "100")).toEqual({ error: expect.stringMatching(/cost first/i) });
    expect(optionSellPatch({ buy_price: 100 }, "-5")).toEqual({ error: expect.stringMatching(/negative/i) });
    expect(optionSellPatch({ buy_price: 100 }, "abc")).toEqual({ error: expect.stringMatching(/isn't a number/i) });
    expect(optionSellPatch({ buy_price: 100 }, "0")).toEqual({ error: expect.stringMatching(/Archive/) });
  });

  it("a Sell below cost is refused on every door, so the sheet and the estimate can't disagree", () => {
    // Was: stored -10%, the sheet showed $900, the estimate charged $1,000.
    expect(optionSellPatch({ buy_price: 1000 }, "900")).toEqual({ error: expect.stringMatching(/below this vendor's cost of \$1,000\.00/) });
    expect(optionSellPatch({ buy_price: 1000 }, "999.99")).toEqual({ error: expect.stringMatching(/below/) });
    expect(optionSellPatch({ buy_price: 1000 }, "1000")).toEqual({ patch: { markup_pct: 0 }, sell: 1000 });
    expect(cleanOptionFields({ markupPct: "-10" }, "update")).toEqual({ error: expect.stringMatching(/Use 0 to sell at cost/) });
    expect(cleanOptionFields({ markupPct: "-0.000001" }, "update")).toEqual({ error: expect.stringMatching(/below 0/) });
  });

  it("an OLD negative markup reads on the sheet exactly as the estimate prices it", () => {
    const o = opt({ buy_price: 1000, markup_pct: -10 });
    const onList = optionView(o, item({ markup_pct: 0 }), 25);
    const onQuote = optionChoice(
      { code: "830", description: "Windows", unit: "ea", buy_price: 830, markup_pct: 0 },
      { ...o, buy_price: "1000", markup_pct: "-10" },
      { orgDefaultPct: 25 },
    ).unitPrice;
    expect(onList.sell).toBe(onQuote);
    expect(onList.sell).toBe(1000);
  });

  it("a typed '$1,500.00' is read the way the price list reads its cells", () => {
    const r = optionSellPatch({ buy_price: 1200 }, "$1,500.00");
    expect(r).toEqual({ patch: { markup_pct: 25 }, sell: 1500 });
  });

  it("the patch becomes the vendor's OWN markup, and the row then shows exactly the sell typed", () => {
    const o = opt({ buy_price: 1234.5678, markup_pct: null });
    const r = optionSellPatch(o, "1999.99");
    if ("error" in r) throw new Error(r.error);
    // Survives the form's own cleaner (the Undo door), which must not round it back to two places.
    const cleaned = cleanOptionFields({ markupPct: String(r.patch.markup_pct) }, "update");
    if ("error" in cleaned) throw new Error(cleaned.error);
    expect(cleaned.clean.markup_pct).toBe(r.patch.markup_pct);
    const v = optionView({ ...o, markup_pct: r.patch.markup_pct }, item(), 25);
    expect(v.source).toBe("option");
    expect(v.sell).toBe(1999.99);
  });

  it("typing a Cost keeps the markup, so the sell follows (cost 1,200 → 1,300 at 25% is 1,625)", () => {
    const before = optionView(opt({ buy_price: 1200, markup_pct: 25 }), item(), 0);
    const after = optionView(opt({ buy_price: 1300, markup_pct: 25 }), item(), 0);
    expect(before.sell).toBe(1500);
    expect(after.pct).toBe(25);
    expect(after.sell).toBe(1625);
  });

  it("the price list and the estimate compute the same sell for the same vendor, six decimals and all", () => {
    const r = lcg(2026);
    for (let n = 0; n < 500; n += 1) {
      const cost = Math.round((1 + r() * 50000) * 100) / 100;
      const sell = Math.round(cost * (1 + r()) * 100) / 100;
      const m = markupForSell(cost, sell)!;
      const o = opt({ buy_price: cost, markup_pct: m });
      const onList = optionView(o, item({ markup_pct: 35 }), 25).sell;
      const onQuote = optionChoice(
        { code: "830", description: "Windows", unit: "ea", buy_price: 830, markup_pct: 35 },
        { ...o, buy_price: String(cost), markup_pct: String(m) },
        { orgDefaultPct: 25 },
      ).unitPrice;
      expect(onQuote).toBe(onList);
      expect(onList).toBe(sell);
    }
  });

  it("the screen writes a markup with two decimals at most; the stored one prices", () => {
    expect(showPct(23.456789)).toBe("23.46");
    expect(showPct(25)).toBe("25");
  });
});

describe("the default vendor: what an estimate uses when nobody picks", () => {
  const base = { code: "830", description: "Windows (Materials) (Allowance)", unit: "ea", buy_price: "830.00", markup_pct: "0" };
  const three = [
    { id: "a", vendor: "Andersen", label: "400 Series", buy_price: "1200", markup_pct: null, is_default: false, sort_order: 1 },
    { id: "m", vendor: "Milgard", label: null, buy_price: "950", markup_pct: null, is_default: true, sort_order: 2 },
    { id: "v", vendor: "Marvin", label: null, buy_price: "1610", markup_pct: null, is_default: false, sort_order: 3 },
  ];

  it("the picker lists the default vendor FIRST, then the item's own price, then the rest", () => {
    const rows = pickerChoices({ ...base, price_list_item_options: three }, { orgDefaultPct: 25 });
    expect(rows.map((r) => r.makerLabel)).toEqual(["Milgard", ITEM_OWN_OPTION_LABEL, "Andersen 400 Series", "Marvin"]);
    expect(rows[0].isDefault).toBe(true);
    expect(rows[0].unitPrice).toBe(1187.5);
    expect(rows[0].description).toBe("830 — Windows (Materials) (Allowance) (Milgard)");
  });

  it("the collapsed row names the default vendor and its sell, and counts the vendors", () => {
    const s = pickerSummary({ ...base, price_list_item_options: three }, { orgDefaultPct: 25 });
    expect(s.count).toBe(3);
    expect(s.defaultChoice?.makerLabel).toBe("Milgard");
    expect(s.defaultChoice?.unitPrice).toBe(1187.5);
  });

  it("no default: the item's own price stays first and is what an unpicked line uses", () => {
    const none = three.map((o) => ({ ...o, is_default: false }));
    const rows = pickerChoices({ ...base, price_list_item_options: none }, { orgDefaultPct: 25 });
    expect(rows[0].makerLabel).toBe(ITEM_OWN_OPTION_LABEL);
    expect(pickerSummary({ ...base, price_list_item_options: none }, {}).defaultChoice).toBeNull();
    expect(defaultItemOptionId({ ...base, price_list_item_options: none })).toBe("");
  });

  it("an unpicked line on the server resolves to the same default the picker shows first", () => {
    const it830 = { ...base, price_list_item_options: three };
    const server = chooseItemOption(it830, defaultItemOptionId(it830), { orgDefaultPct: 25 });
    expect(server?.id).toBe(pickerChoices(it830, { orgDefaultPct: 25 })[0].id);
  });

  it("an ARCHIVED default is never offered, so the item falls back to its own price", () => {
    const archivedDefault = three.map((o) => (o.id === "m" ? { ...o, archived: true } : o));
    const it830 = { ...base, price_list_item_options: archivedDefault };
    expect(defaultItemOptionId(it830)).toBe("");
    expect(pickerChoices(it830, {}).map((r) => r.makerLabel)).not.toContain("Milgard");
    // And a pick of it that was on screen before the archive is refused, never silently re-priced.
    expect(chooseItemOption(it830, "m", {})).toBeNull();
  });

  it("restoring it brings it back as the default when nothing took the seat", () => {
    const it830 = { ...base, price_list_item_options: three };
    expect(defaultItemOptionId(it830)).toBe("m");
  });
});

describe("vendors across items: one vendor per name, never split by a spelling", () => {
  const items = [
    item(),
    item({ id: "i1006", code: "1006", description: "Fireplaces (Materials) (Allowance)", buy_price: 1006 }),
    item({ id: "old", code: "999", description: "Retired", archived: true }),
  ];
  const options: ItemOption[] = [
    opt({ id: "a1", item_id: "i830", vendor: "Andersen", buy_price: 1200, is_default: true }),
    opt({ id: "a2", item_id: "i1006", vendor: "andersen ", buy_price: 300 }),
    opt({ id: "a3", item_id: "old", vendor: "ANDERSEN", buy_price: 5 }),
    opt({ id: "m1", item_id: "i830", vendor: "Milgard", buy_price: 950, archived: true }),
    opt({ id: "v1", item_id: "i830", vendor: "Marvin", buy_price: 1610 }),
  ];
  const card = (over: Partial<VendorCard>): VendorCard => ({
    id: "c",
    name: "X",
    contact_name: null,
    phone: null,
    email: null,
    website: null,
    address: null,
    notes: null,
    archived: false,
    ...over,
  });

  it("groups case- and space-insensitively, drops archived items, and counts defaults", () => {
    const vs = summarizeVendors(options, items, [], 25);
    const andersen = vs.find((v) => v.key === "andersen")!;
    expect(andersen.items.map((r) => r.option.id)).toEqual(["a1", "a2"]); // "old" is an archived item
    expect(andersen.defaults).toBe(1);
    expect(andersen.items[0].sell).toBe(1500);
    expect(vs.map((v) => v.name)).toEqual(["Andersen", "Marvin"]); // Milgard: only archived rows, no card
  });

  it("an archived vendor row on an item stays findable under the vendor's card, not among its live items", () => {
    const milgard = summarizeVendors(options, items, [card({ id: "c3", name: "Milgard" })], 0).find((v) => v.key === "milgard")!;
    expect(milgard.items).toEqual([]);
    expect(milgard.archivedItems.map((r) => r.option.id)).toEqual(["m1"]);
  });

  it("a vendor with no card whose rows are all archived leaves the list, so Archive can't be pressed twice", () => {
    // Before 0296 no vendor has a card, so this is every vendor right after Archive <Vendor>.
    const vs = summarizeVendors(options, items, [], 0);
    expect(vs.find((v) => v.key === "milgard")).toBeUndefined();
    expect(summarizeVendors([opt({ id: "x", vendor: "Andersen", archived: true })], items, [], 0)).toEqual([]);
  });

  it("a card's spelling wins, and a card with no items yet is still a vendor", () => {
    const vs = summarizeVendors(options, items, [card({ id: "c1", name: "ANDERSEN Windows" }), card({ id: "c2", name: "Pella", phone: "5305550100" })], 0);
    expect(vs.find((v) => v.key === "pella")?.items).toEqual([]);
    expect(vs.find((v) => v.key === "pella")?.card?.phone).toBe("5305550100");
    // "ANDERSEN Windows" is a different name from "Andersen": exact only, nothing fuzzy.
    expect(vs.filter((v) => v.key.startsWith("andersen")).map((v) => v.name).sort()).toEqual(["ANDERSEN Windows", "Andersen"]);
  });

  it("an archived card with nothing on items leaves the list; one still pricing items stays", () => {
    const gone = summarizeVendors([], items, [card({ name: "Pella", archived: true })], 0);
    expect(gone).toEqual([]);
    const stays = summarizeVendors(options, items, [card({ name: "Marvin", archived: true })], 0);
    expect(stays.find((v) => v.key === "marvin")?.items.length).toBe(1);
  });

  it("the names offered for the next item reuse the org's own spelling", () => {
    expect(knownVendorNames(options, [card({ name: "Pella" }), card({ name: "Old", archived: true })])).toEqual([
      "Andersen",
      "Marvin",
      "Milgard",
      "Pella",
    ]);
    expect(canonicalVendorName("  andersen ", ["Andersen", "Marvin"])).toBe("Andersen");
    expect(canonicalVendorName("Jeld-Wen", ["Andersen"])).toBe("Jeld-Wen");
    expect(vendorKey("  Andersen ")).toBe(vendorKey("andersen"));
  });
});

describe("a vendor's card: what gets written", () => {
  it("a new vendor needs a name; blanks are null; only what was passed is touched", () => {
    expect(cleanVendorCard({}, "create")).toEqual({ error: expect.stringMatching(/Name the vendor/) });
    expect(cleanVendorCard({ name: " Andersen ", phone: "", email: " rep@andersen.com " }, "create")).toEqual({
      clean: { name: "Andersen", phone: null, email: "rep@andersen.com" },
    });
    expect(cleanVendorCard({ phone: "(530) 555-0100" }, "update")).toEqual({ clean: { phone: "(530) 555-0100" } });
  });

  it("an email without an @ and a domain is refused in words", () => {
    expect(cleanVendorCard({ email: "andersen" }, "update")).toEqual({ error: expect.stringMatching(/@ and a domain/) });
  });

  it("a website becomes a link only when it is one", () => {
    expect(websiteHref("andersenwindows.com")).toBe("https://andersenwindows.com/");
    expect(websiteHref("http://milgard.com/pro")).toBe("http://milgard.com/pro");
    expect(websiteHref("call Jim")).toBeNull();
    expect(websiteHref("javascript:alert(1)")).toBeNull();
    expect(websiteHref("")).toBeNull();
  });
});

describe("the Items list flags a cost that is really the item number", () => {
  it("Vivian's 830 at $830.00 and 005 at $5.00 are flagged", () => {
    expect(costLooksLikeCode({ code: "830", buy_price: 830 })).toBe(true);
    expect(costLooksLikeCode({ code: "005", buy_price: 5 })).toBe(true);
    expect(costLooksLikeCode({ code: "1006", buy_price: "1006.00" as unknown as number })).toBe(true);
  });

  it("a real price, a part number with letters, a blank or zero cost are not", () => {
    expect(costLooksLikeCode({ code: "830", buy_price: 1150 })).toBe(false);
    expect(costLooksLikeCode({ code: "THHN-12", buy_price: 12 })).toBe(false);
    expect(costLooksLikeCode({ code: null, buy_price: 12 })).toBe(false);
    expect(costLooksLikeCode({ code: "0", buy_price: 0 })).toBe(false);
  });
});
