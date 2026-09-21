import { describe, it, expect } from "vitest";
import {
  cleanOptionFields,
  markupSourceNote,
  markupSourceTag,
  optionName,
  optionView,
  optionWriteRefusal,
  sortItemOptions,
} from "./item-options-math";

/** Vivian Builders' code 830: "Windows (Materials) (Allowance)", $830.00, no markup of its own. */
const item830 = { unit: "ea", markup_pct: 0 };

describe("optionView — the sell price of one maker's window", () => {
  it("an option that states its own markup uses it, over the item and over the org default", () => {
    const v = optionView({ vendor: "Andersen", label: "400 Series", unit: null, buy_price: 1200, markup_pct: 20 }, { unit: "ea", markup_pct: 35 }, 25);
    expect(v.pct).toBe(20);
    expect(v.sell).toBe(1440);
    expect(v.source).toBe("option");
  });

  it("a stated ZERO is a decision, not a blank — it sells at cost and says so", () => {
    const v = optionView({ vendor: "Milgard", label: null, unit: null, buy_price: 900, markup_pct: 0 }, { unit: "ea", markup_pct: 35 }, 25);
    expect(v.pct).toBe(0);
    expect(v.sell).toBe(900);
    expect(v.source).toBe("option");
  });

  it("no markup stated falls through to the ITEM's own", () => {
    const v = optionView({ vendor: "Marvin", label: null, unit: null, buy_price: 1000, markup_pct: null }, { unit: "ea", markup_pct: 35 }, 25);
    expect(v.pct).toBe(35);
    expect(v.sell).toBe(1350);
    expect(v.source).toBe("item");
  });

  it("no markup on the option and none on the item falls through to the org default (the 830 case)", () => {
    const v = optionView({ vendor: "Andersen", label: null, unit: null, buy_price: 1200, markup_pct: null }, item830, 25);
    expect(v.pct).toBe(25);
    expect(v.sell).toBe(1500);
    expect(v.source).toBe("org");
  });

  it("no markup anywhere sells at cost and names that as the reason", () => {
    const v = optionView({ vendor: "Andersen", label: null, unit: null, buy_price: 1200, markup_pct: null }, item830, 0);
    expect(v.sell).toBe(1200);
    expect(v.source).toBe("none");
    expect(markupSourceNote(v.source)).toMatch(/sells at cost/);
  });

  it("a blank unit means the item's unit — never a guessed 'ea' on an item priced per sq ft", () => {
    expect(optionView({ vendor: "A", label: null, unit: null, buy_price: 5, markup_pct: null }, { unit: "sq ft", markup_pct: 0 }, 0).unit).toBe("sq ft");
    expect(optionView({ vendor: "A", label: null, unit: "box", buy_price: 5, markup_pct: null }, { unit: "sq ft", markup_pct: 0 }, 0).unit).toBe("box");
  });

  it("names itself the way the row reads it", () => {
    expect(optionName({ vendor: "Andersen", label: "400 Series" })).toBe("Andersen 400 Series");
    expect(optionName({ vendor: "Milgard", label: null })).toBe("Milgard");
    expect(optionName({ vendor: "  Marvin  ", label: "  " })).toBe("Marvin");
  });
});

describe("markupSourceTag — a percentage always says where it came from", () => {
  it("names the rung in two or three words", () => {
    expect(markupSourceTag("option")).toBe("this option");
    expect(markupSourceTag("item")).toBe("the item");
    expect(markupSourceTag("org")).toBe("your default");
    expect(markupSourceTag("none")).toBe("none set");
  });
});

describe("cleanOptionFields — what reaches the columns", () => {
  it("a new option needs a maker and a cost, and says which is missing", () => {
    expect(cleanOptionFields({ buyPrice: 1200 }, "create")).toEqual({ error: expect.stringMatching(/who makes it/i) });
    expect(cleanOptionFields({ vendor: "Andersen" }, "create")).toEqual({ error: expect.stringMatching(/costs you/i) });
  });

  it("a blank cost is refused, NOT saved as zero", () => {
    const r = cleanOptionFields({ vendor: "Andersen", buyPrice: "" }, "create");
    expect("error" in r).toBe(true);
    const ok = cleanOptionFields({ vendor: "Andersen", buyPrice: "$1,234.5678" }, "create");
    expect("clean" in ok && ok.clean.buy_price).toBe(1234.5678);
  });

  it("a BLANK markup is null (fall through), a typed 0 is zero", () => {
    const blank = cleanOptionFields({ markupPct: "" }, "update");
    expect("clean" in blank && blank.clean.markup_pct).toBe(null);
    const zero = cleanOptionFields({ markupPct: "0" }, "update");
    expect("clean" in zero && zero.clean.markup_pct).toBe(0);
    const some = cleanOptionFields({ markupPct: "22.5%" }, "update");
    expect("clean" in some && some.clean.markup_pct).toBe(22.5);
  });

  it("garbage in the markup is refused with the way out of it", () => {
    const r = cleanOptionFields({ markupPct: "abc" }, "update");
    expect("error" in r && /leave it blank/i.test(r.error)).toBe(true);
    expect("error" in cleanOptionFields({ markupPct: "-120" }, "update")).toBe(true);
  });

  it("a blank unit stays NULL — normalizeUnit's 'ea' must not become the answer", () => {
    const blank = cleanOptionFields({ unit: "  " }, "update");
    expect("clean" in blank && blank.clean.unit).toBe(null);
    const typed = cleanOptionFields({ unit: " LF " }, "update");
    expect("clean" in typed && typed.clean.unit).toBe("ft");
  });

  it("an update touches only what was passed, so a part-number edit can't blank the price", () => {
    const r = cleanOptionFields({ partNumber: " TW2842 " }, "update");
    expect(r).toEqual({ clean: { part_number: "TW2842" } });
  });

  it("blank words become null, not empty strings (the unique index keys on coalesce(label,''))", () => {
    const r = cleanOptionFields({ label: "   ", partNumber: "" }, "update");
    expect(r).toEqual({ clean: { label: null, part_number: null } });
  });
});

describe("optionWriteRefusal — 0282's two unique indexes, said in English", () => {
  it("the same maker twice names the option and the two ways out", () => {
    const err = { message: 'duplicate key value violates unique constraint "price_list_item_options_one_per_maker"' };
    const said = optionWriteRefusal(err, { vendor: "Andersen", label: "400 Series" });
    expect(said).toMatch(/^Andersen 400 Series is already an option on this item\./);
    expect(said).toMatch(/product line/);
    expect(said).not.toMatch(/duplicate key|constraint/);
  });

  it("two defaults under one item is a race, and the answer is reload", () => {
    const err = { message: 'duplicate key value violates unique constraint "price_list_item_options_one_default"' };
    expect(optionWriteRefusal(err)).toMatch(/Reload the page/);
  });

  it("anything we don't recognise keeps the database's own words (that's the bug report)", () => {
    expect(optionWriteRefusal({ message: "connection terminated unexpectedly" })).toBe("connection terminated unexpectedly");
  });
});

describe("sortItemOptions", () => {
  it("default first, then the hand order, then the maker's name", () => {
    const rows = [
      { vendor: "Marvin", label: null, is_default: false, sort_order: 3 },
      { vendor: "Andersen", label: null, is_default: false, sort_order: 1 },
      { vendor: "Milgard", label: null, is_default: true, sort_order: 9 },
    ];
    expect(sortItemOptions(rows).map((r) => r.vendor)).toEqual(["Milgard", "Andersen", "Marvin"]);
  });
  it("leaves the caller's array alone", () => {
    const rows = [
      { vendor: "B", label: null, is_default: false, sort_order: 2 },
      { vendor: "A", label: null, is_default: false, sort_order: 1 },
    ];
    sortItemOptions(rows);
    expect(rows[0].vendor).toBe("B");
  });
});
