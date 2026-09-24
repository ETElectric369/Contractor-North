import { describe, it, expect } from "vitest";
import { groupInvoiceLines, isSuppliesAndTaxLine, mergeSuppliesAndTax, SUPPLIES_AND_TAX_LABEL } from "@/lib/invoice-math";

/**
 * ONE "SUPPLIES & TAX" LINE ON THE CUSTOMER'S COPY (Erik, INV-074, 2026-09-23).
 *
 * A display change on a money document, so the rule is the one every display change here lives
 * under: the lines the customer reads must add up to exactly the same cents as before. Every test
 * below checks that, not only the ones about the merge itself.
 */

type Row = { id: string; description: string; quantity: number; unit: string; unit_price: number; line_total: number; import_source: string | null };
const row = (id: string, description: string, line_total: number, import_source: string | null = "costs", quantity = 1): Row => ({
  id,
  description,
  quantity,
  unit: "ea",
  unit_price: Math.round((line_total / quantity) * 100) / 100,
  line_total,
  import_source,
});
const cents = (rows: { line_total: number }[]) => rows.reduce((t, r) => t + Math.round(r.line_total * 100), 0);

/** INV-074 as Kathy Walker received it: labor, three receipts, each with its own tax row (the
 *  three he renamed by hand to drop the supplier, which is why they read "Supplies & tax —"). */
const INV_074: Row[] = [
  row("labor", "Labor", 375, "labor", 3),
  row("flex", "Duct Flex", 20.79),
  row("st1", "Supplies & tax —", 1.45),
  row("fan", "PANIS fan", 176.42),
  row("st2", "Supplies & tax —", 15.26),
  row("timer", "Timer", 31.19),
  row("plate", "Wallplate", 2.07),
  row("st3", "Supplies & tax —", 2.31),
];

describe("mergeSuppliesAndTax — several receipts become one line", () => {
  it("prints INV-074's three tax rows as one $19.02 'Supplies & Tax', where the last one was", () => {
    const shown = mergeSuppliesAndTax(INV_074);
    expect(shown.map((r) => r.id)).toEqual(["labor", "flex", "fan", "timer", "plate", "st3"]);
    const merged = shown[shown.length - 1];
    expect(merged).toMatchObject({ description: SUPPLIES_AND_TAX_LABEL, quantity: 1, unit: "ea", unit_price: 19.02, line_total: 19.02, import_source: "costs" });
  });

  it("THE SAME CENTS: the shown lines add up to exactly what the stored lines do", () => {
    const shown = mergeSuppliesAndTax(INV_074);
    expect(cents(shown)).toBe(cents(INV_074));
    expect(cents(shown)).toBe(62449); // $624.49, the total Kathy was sent
  });

  it("the cost breakdown still files it under Materials, to the cent", () => {
    const before = groupInvoiceLines(INV_074);
    const after = groupInvoiceLines(mergeSuppliesAndTax(INV_074));
    expect(after.materials.subtotal).toBe(before.materials.subtotal);
    expect(after.labor.subtotal).toBe(before.labor.subtotal);
  });

  it("names no supplier — the importer's own labels merge too", () => {
    const rows = [
      row("a", "Wire", 40),
      row("sa", "Supplies & tax — Swigard's True Value", 3.1),
      row("b", "Box", 10),
      row("sb", "Supplies & tax — Consolidated Electrical Distributors, Inc. (CED)", 0.87),
    ];
    const shown = mergeSuppliesAndTax(rows);
    expect(shown.filter((r) => r.description.includes("Swigard") || r.description.includes("CED"))).toEqual([]);
    expect(shown.filter(isSuppliesAndTaxLine)).toHaveLength(1);
    expect(cents(shown)).toBe(cents(rows));
  });

  it("sums in whole cents, so float dust never moves a penny", () => {
    const rows = [row("s1", "Supplies & tax — A", 0.1), row("s2", "Supplies & tax — B", 0.2), row("s3", "Supplies & tax — C", 0.7)];
    const shown = mergeSuppliesAndTax(rows);
    expect(shown).toHaveLength(1);
    expect(shown[0].line_total).toBe(1); // 0.1 + 0.2 + 0.7 in floats is 0.9999999999999999
    expect(cents(shown)).toBe(100);
  });
});

describe("mergeSuppliesAndTax — one row, and none", () => {
  it("ONE row still loses its supplier's name and keeps its amount", () => {
    const rows = [row("a", "Wire", 40), row("sa", "Supplies & tax — CED", 3.1), row("b", "Labor", 95, "labor")];
    const shown = mergeSuppliesAndTax(rows);
    expect(shown.map((r) => r.id)).toEqual(["a", "sa", "b"]);
    expect(shown[1]).toMatchObject({ description: SUPPLIES_AND_TAX_LABEL, line_total: 3.1, unit_price: 3.1, quantity: 1 });
    expect(cents(shown)).toBe(cents(rows));
  });

  it("NONE: an invoice without one is printed exactly as stored", () => {
    const rows = [row("a", "Wire", 40), row("b", "Labor", 95, "labor")];
    expect(mergeSuppliesAndTax(rows)).toEqual(rows);
    expect(mergeSuppliesAndTax([])).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    const rows = INV_074.map((r) => ({ ...r }));
    mergeSuppliesAndTax(rows);
    expect(rows).toEqual(INV_074);
  });
});

describe("mergeSuppliesAndTax — negative and credit rows", () => {
  it("a negative remainder (old data, before the lump fallback) nets into the one line", () => {
    const rows = [row("a", "Panel", 300), row("s1", "Supplies & tax — CED", -40.28), row("b", "Wire", 50), row("s2", "Supplies & tax — HD", 4.12)];
    const shown = mergeSuppliesAndTax(rows);
    expect(shown.find(isSuppliesAndTaxLine)).toMatchObject({ line_total: -36.16, unit_price: -36.16 });
    expect(cents(shown)).toBe(cents(rows));
  });

  it("a net of zero still prints its line: nothing is dropped from a money document", () => {
    const rows = [row("s1", "Supplies & tax — A", 5), row("s2", "Supplies & tax — B", -5)];
    const shown = mergeSuppliesAndTax(rows);
    expect(shown).toHaveLength(1);
    expect(shown[0].line_total).toBe(0);
  });

  it("the prior-billings credit and a hand-typed discount are not supplies, and stay put", () => {
    const rows = [
      row("s1", "Supplies & tax — A", 2),
      row("credit", "Less previous billings", -500, "draw_credit"),
      row("disc", "Discount", -25, null),
      row("s2", "Supplies & tax — B", 3),
    ];
    const shown = mergeSuppliesAndTax(rows);
    expect(shown.map((r) => r.id)).toEqual(["credit", "disc", "s2"]);
    expect(shown[2].line_total).toBe(5);
    expect(cents(shown)).toBe(cents(rows));
  });
});

describe("isSuppliesAndTaxLine — only the importer's remainder rows", () => {
  it("a hand-typed line with those words is the office's own and is not merged", () => {
    expect(isSuppliesAndTaxLine({ description: "Supplies & tax", import_source: null, line_total: 4 })).toBe(false);
  });

  it("a remainder row renamed to something else prints as the office wrote it", () => {
    expect(isSuppliesAndTaxLine({ description: "Misc parts", import_source: "costs", line_total: 4 })).toBe(false);
  });

  it("a receipt line and a whole-bill lump are materials, not the tax row", () => {
    expect(isSuppliesAndTaxLine({ description: "Supplies box 12x12", import_source: "costs", line_total: 4 })).toBe(false);
    expect(isSuppliesAndTaxLine({ description: "Materials — CED (bill #88)", import_source: "costs", line_total: 4 })).toBe(false);
  });

  it("reads both spellings the rows actually carry", () => {
    expect(isSuppliesAndTaxLine({ description: "Supplies & tax — CED", import_source: "costs", line_total: 4 })).toBe(true);
    expect(isSuppliesAndTaxLine({ description: "Supplies & tax —", import_source: "costs", line_total: 4 })).toBe(true);
  });
});

describe("the customer's copy uses it, and only the customer's copy", () => {
  it("InvoiceDocument prints the merged lines and feeds them to the breakdown", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/invoice-document.tsx", "utf8");
    expect(src).toMatch(/const lines = mergeSuppliesAndTax\(items\)/);
    expect(src).toMatch(/\{lines\.map\(/);
    expect(src).toMatch(/<CostBreakdown items=\{lines\}/);
    expect(src).not.toMatch(/\{items\.map\(/);
  });

  it("the office editor does not", async () => {
    const { readFileSync } = await import("node:fs");
    const editor = readFileSync("src/app/(app)/billing/[id]/invoice-detail.tsx", "utf8");
    expect(editor).not.toContain("mergeSuppliesAndTax");
  });
});
