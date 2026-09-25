import { describe, it, expect } from "vitest";
import {
  groupInvoiceLines,
  handLineKind,
  kindFromPriceBook,
  pickableLineKind,
  priceBookCodeKey,
  priceBookLineKind,
  priceBookUnits,
  storedLineKind,
  customerLines,
  mergeSuppliesAndTax,
} from "@/lib/invoice-math";
import { lineGroup, sectionLines } from "@/lib/portal/line-kind";
import { buildJobLedger } from "@/lib/portal/stretch-ledger";
import { kitSelectionToLines, type KitPickerRow } from "@/lib/kit-picker";

/**
 * A LINE SAYS WHAT IT IS (Erik, 2026-09-25, INV-079 on J-055: "Other instead of materials in
 * invoice"; migration 0342).
 *
 * INV-079 as production holds it: the labor import's "Labor - Erik Taylor" and three lines Erik added
 * from his price list with no importer behind them. Before 0342 the three read Other, because a
 * price-book line's words are a code and a catalog name. With line_kind stored (by the picker, or
 * by 0342's backfill, which the read-only practice run showed filing exactly these three), every
 * reader files them under Materials: Labor $531.25 / Materials $25.50, nothing under Other.
 */
const INV_079 = [
  { sort_order: 0, description: "Labor - Erik Taylor", unit: "hr", quantity: 4.25, unit_price: 125, line_total: 531.25, import_source: "labor", line_kind: null },
  { sort_order: 1, description: "1597TRW — 15A 125V GFCI RCPT", unit: "ea", quantity: 1, unit_price: 21.04, line_total: 21.04, import_source: null, line_kind: "materials" },
  { sort_order: 2, description: "TM870LA — S5A 125V 1P SWITCH", unit: "ea", quantity: 1, unit_price: 2.55, line_total: 2.55, import_source: null, line_kind: "materials" },
  { sort_order: 3, description: "3232TRI — 15A 125V DPLX RCPT", unit: "ea", quantity: 1, unit_price: 1.91, line_total: 1.91, import_source: null, line_kind: "materials" },
];
const withoutKind = INV_079.map(({ line_kind: _k, ...rest }) => rest);
// ET Electric's book, as far as these lines go (price_list_items: code, unit).
const BOOK = priceBookUnits([
  { code: "1597TRW", unit: "ea" },
  { code: "TM870LA", unit: "ea" },
  { code: "3232TRI", unit: "ea" },
  { code: "SVC-HR", unit: "hr" },
  { code: "  ", unit: "ea" },
]);

describe("INV-079: the price-book lines file under Materials", () => {
  it("the root: without a stored kind the three book lines read Other (what Erik saw)", () => {
    const g = groupInvoiceLines(withoutKind);
    expect(g.labor.subtotal).toBe(531.25);
    expect(g.materials.subtotal).toBe(0);
    expect(g.other.subtotal).toBe(25.5);
  });

  it("the /i Cost Breakdown and print (groupInvoiceLines): Labor $531.25 / Materials $25.50, no Other", () => {
    const g = groupInvoiceLines(INV_079);
    expect(g.labor.subtotal).toBe(531.25);
    expect(g.materials.subtotal).toBe(25.5);
    expect(g.other.lines).toHaveLength(0);
    expect(g.credits.lines).toHaveLength(0);
    expect(g.hasBreakdown).toBe(true);
  });

  it("the customer's copy keeps the kind through the scrub and the Supplies & Tax merge, and sections the same", () => {
    const lines = mergeSuppliesAndTax(customerLines(INV_079));
    const sections = sectionLines(lines, "standard");
    expect(sections.map((s) => [s.label, s.subtotal])).toEqual([
      ["Labor", 531.25],
      ["Materials", 25.5],
    ]);
    // Classification only: the words, amounts and order are exactly the stored ones.
    expect(lines.map((l) => [l.description, l.line_total])).toEqual(INV_079.map((l) => [l.description, l.line_total]));
  });

  it("the portal ledger files them under Materials too, and each row is a material", () => {
    const l = buildJobLedger({
      stretches: [],
      invoices: [{ id: "inv-079", invoice_number: "INV-079", status: "sent", subtotal: 556.75, tax: 0, total: 556.75, amount_paid: 0, created_at: "2026-09-25T18:00:00Z", invoice_kind: "standard" }],
      lines: INV_079.map((x) => ({ ...x, invoice_id: "inv-079" })),
      payments: [],
      tz: "America/Los_Angeles",
    });
    expect(Object.fromEntries(l.split.lines.map((x) => [x.group, x.amount]))).toEqual({ labor: 531.25, materials: 25.5 });
    const items = l.stretches.flatMap((s) => s.days.flatMap((d) => d.items));
    expect(items.filter((i) => i.group === "materials").map((i) => i.kind)).toEqual(["material", "material", "material"]);
  });
});

describe("a stored kind is read first, by every reader", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ description: "10/3 romex", import_source: null, line_kind: "materials" }, "materials"],
    [{ description: "Emergency service call", import_source: null, line_kind: "labor" }, "labor"],
    [{ description: "Labor - Brian", unit: "hr", import_source: null, line_kind: "other" }, "other"],
    [{ description: "Materials — CED", import_source: "costs", line_kind: "other" }, "other"],
    [{ description: "Labor - Erik", import_source: "labor", line_kind: "materials" }, "materials"],
    [{ description: "Referral credit", import_source: null, line_kind: "credit" }, "credit"],
    [{ description: "Permit", import_source: "quote", line_kind: "materials" }, "materials"],
    // An unknown word is no kind at all: the line is read as before.
    [{ description: "Labor - Brian", import_source: null, line_kind: "bogus" }, "labor"],
  ];
  it("lineGroup (portal) and groupInvoiceLines (/i, print) agree on every case", () => {
    for (const [line, want] of cases) {
      expect([line.description, lineGroup(line as never)]).toEqual([line.description, want]);
      const g = groupInvoiceLines([{ ...(line as object), line_total: 10 }]);
      const bucket = g.labor.lines.length ? "labor" : g.materials.lines.length ? "materials" : g.credits.lines.length ? "credit" : "other";
      expect([line.description, bucket]).toEqual([line.description, want]);
    }
  });

  it("handLineKind: a stored kind wins, and a stored Other is Other (null)", () => {
    expect(handLineKind({ description: "10/3 romex", line_kind: "materials" })).toBe("materials");
    expect(handLineKind({ description: "Labor - Brian", line_kind: "other" })).toBeNull();
    expect(handLineKind({ description: "Labor - Brian", line_kind: null })).toBe("labor");
  });

  it("a deposit bill's own line the office filed says what it was filed as", () => {
    expect(lineGroup({ import_source: null, description: "Deposit", line_kind: null }, "deposit")).toBe("deposit");
    expect(lineGroup({ import_source: null, description: "Deposit", line_kind: "materials" }, "deposit")).toBe("materials");
  });

  it("only the four kinds are kinds; only three are pickable", () => {
    expect(["labor", "materials", "other", "credit", "Labor", "", null, 3].map(storedLineKind)).toEqual(["labor", "materials", "other", "credit", null, null, null, null]);
    expect(["labor", "materials", "other", "credit", undefined].map(pickableLineKind)).toEqual(["labor", "materials", "other", null, null]);
  });
});

describe("the price-book rule (the doors, and 0342's backfill twin)", () => {
  it("the code is the text before ' — ', trimmed, case ignored", () => {
    expect(priceBookCodeKey("TM870LA — S5A 125V 1P SWITCH")).toBe("tm870la");
    expect(priceBookCodeKey("  3232TRI  — 15A")).toBe("3232tri");
    expect(priceBookCodeKey("830 — Windows (Marvin)")).toBe("830");
    expect(priceBookCodeKey("Labor - Brian")).toBeNull();
    expect(priceBookCodeKey("TM870LA-S5A")).toBeNull();
    expect(priceBookCodeKey(" — no code")).toBeNull();
    expect(priceBookCodeKey(null)).toBeNull();
  });

  it("a line whose code is in the book is materials; sold by the hour, labor; anything else says nothing", () => {
    expect(kindFromPriceBook({ description: "TM870LA — S5A 125V 1P SWITCH", unit: "ea" }, BOOK)).toBe("materials");
    expect(kindFromPriceBook({ description: "tm870la — renamed by hand", unit: "ea" }, BOOK)).toBe("materials");
    expect(kindFromPriceBook({ description: "SVC-HR — Service hour", unit: "ea" }, BOOK)).toBe("labor");
    expect(kindFromPriceBook({ description: "TM870LA — S5A 125V 1P SWITCH", unit: "hrs" }, BOOK)).toBe("labor");
    expect(kindFromPriceBook({ description: "NOPE123 — not in this org's book", unit: "ea" }, BOOK)).toBeNull();
    expect(kindFromPriceBook({ description: "Emergency service call", unit: "ea" }, BOOK)).toBeNull();
    expect(kindFromPriceBook({ description: "TM870LA — S5A 125V 1P SWITCH", unit: "ea" }, new Map())).toBeNull();
  });

  it("one code on two rows: hours on either wins", () => {
    const book = priceBookUnits([{ code: "X1", unit: "hr" }, { code: "x1", unit: "ea" }]);
    expect(kindFromPriceBook({ description: "X1 — thing", unit: "ea" }, book)).toBe("labor");
  });

  it("the picker's own rule: materials, labor for an item sold by the hour", () => {
    expect(priceBookLineKind("ea")).toBe("materials");
    expect(priceBookLineKind("SQ FT")).toBe("materials");
    expect(priceBookLineKind("hr")).toBe("labor");
    expect(priceBookLineKind("ea", "hrs")).toBe("labor");
  });
});

describe("a kit's linked lines are book lines; its typed lines say nothing", () => {
  const row = (over: Partial<KitPickerRow>): KitPickerRow => ({ description: "x", quantity: 1, unit: "ea", unit_price: 1, sort_order: 0, checked: true, ...over });
  it("linked -> materials (labor by the hour); unlinked -> no kind", () => {
    const lines = kitSelectionToLines("Service", [
      row({ description: "TM870LA — S5A 125V 1P SWITCH", linked: true, sort_order: 0 }),
      row({ description: "SVC-HR — Service hour", linked: true, unit: "hr", sort_order: 1 }),
      row({ description: "Misc. hardware", linked: false, sort_order: 2 }),
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["materials", "labor", undefined]);
    // Nothing else about the line changes.
    expect(lines[0]).toMatchObject({ description: "TM870LA — S5A 125V 1P SWITCH", quantity: 1, unit: "ea", unit_price: 1, group: "Service" });
  });
});
