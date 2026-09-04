import { describe, it, expect } from "vitest";
import { mapExtraHeaders, mappedFields, parseCellNumber, patchForEdit, rowThroughMapping, rowView, undoPatch } from "./price-list-math";

const item = { buy_price: 38, markup_pct: 35, unit: "ea" };

describe("rowView — the row shows THE markup rule, not the raw column", () => {
  it("uses the item's own markup when it has one", () => {
    const v = rowView({ buy_price: 38, markup_pct: 35 }, 25);
    expect(v.pct).toBe(35);
    expect(v.sell).toBe(51.3);
    expect(v.margin).toBe(25.9);
    expect(v.usesDefault).toBe(false);
  });
  it("falls through to the org default and says so (the CED net-cost case)", () => {
    const v = rowView({ buy_price: 100, markup_pct: 0 }, 25);
    expect(v.pct).toBe(25);
    expect(v.sell).toBe(125);
    expect(v.usesDefault).toBe(true);
  });
  it("no markup anywhere → sell = cost, no tag", () => {
    const v = rowView({ buy_price: 100, markup_pct: 0 }, 0);
    expect(v.sell).toBe(100);
    expect(v.usesDefault).toBe(false);
  });
});

describe("patchForEdit — which column an inline edit writes", () => {
  it("MU% writes markup_pct only", () => {
    expect(patchForEdit("markup", "40", item)).toEqual({ patch: { markup_pct: 40 } });
  });
  it("Sell back-solves a markup and never stores the sell", () => {
    expect(patchForEdit("sell", "$51.30", item)).toEqual({ patch: { markup_pct: 35 } });
  });
  it("Sell with no cost is refused in words", () => {
    const r = patchForEdit("sell", "50", { ...item, buy_price: 0 });
    expect("error" in r && /cost first/i.test(r.error)).toBe(true);
  });
  it("Cost writes buy_price only — sell follows at the current pct", () => {
    expect(patchForEdit("cost", "1,234.567", item)).toEqual({ patch: { buy_price: 1234.57 } });
  });
  it("Margin converts to markup (20% margin = 25% markup)", () => {
    expect(patchForEdit("margin", "20%", item)).toEqual({ patch: { markup_pct: 25 } });
    expect("error" in patchForEdit("margin", "100", item)).toBe(true);
  });
  it("Unit normalizes through the one vocabulary", () => {
    expect(patchForEdit("unit", "  LF ", item)).toEqual({ patch: { unit: "ft" } });
    expect(patchForEdit("unit", "", item)).toEqual({ patch: { unit: "ea" } });
  });
  it("garbage is refused, not written as 0", () => {
    expect("error" in patchForEdit("cost", "abc", item)).toBe(true);
    expect("error" in patchForEdit("markup", "", item)).toBe(true);
  });
});

describe("parseCellNumber", () => {
  it("reads money and percent the way people type them", () => {
    expect(parseCellNumber("$1,234.50")).toBe(1234.5);
    expect(parseCellNumber("35%")).toBe(35);
    expect(parseCellNumber("-5")).toBe(-5);
    expect(parseCellNumber(".5")).toBe(0.5);
    expect(parseCellNumber("")).toBeNull();
    expect(parseCellNumber("1.2.3")).toBeNull();
  });
});

describe("undoPatch — the toast's Undo writes back exactly what was overwritten", () => {
  it("mirrors only the keys the patch touched", () => {
    expect(undoPatch({ markup_pct: 40 }, item)).toEqual({ markup_pct: 35 });
    expect(undoPatch({ buy_price: 50, unit: "ft" }, item)).toEqual({ buy_price: 38, unit: "ea" });
  });
});

describe("CSV mapping extras", () => {
  it("claims kit and quantity columns nobody else took", () => {
    const headers = ["Code", "Description", "Kit", "Qty", "Unit Price"];
    const m = mapExtraHeaders(headers, { code: 0, description: 1, buy_price: 4 });
    expect(m.kit).toBe(2);
    expect(m.quantity).toBe(3);
  });
  it("never re-claims a column an earlier field owns", () => {
    const m = mapExtraHeaders(["Kit Qty"], { code: 0 });
    expect(m.kit).toBeUndefined();
    expect(m.quantity).toBeUndefined();
  });
  it("renders a row through the mapping; unmapped → empty/null, blank qty → null", () => {
    const row = rowThroughMapping(["A1", "Wire", "Deck A", "", "$1.50"], { code: 0, description: 1, kit: 2, quantity: 3, buy_price: 4 });
    expect(row).toEqual({ code: "A1", description: "Wire", category: "", supplier: "", unit: "", buy_price: 1.5, markup_pct: null, kit: "Deck A", quantity: null });
  });
  it("a blank or unreadable price cell is null, never 0 — a 0 would overwrite a real price on re-import", () => {
    expect(rowThroughMapping(["A1", "Wire", "", "n/a"], { code: 0, description: 1, buy_price: 2, markup_pct: 3 })).toMatchObject({ buy_price: null, markup_pct: null });
    expect(rowThroughMapping(["A1", "Wire", "0"], { code: 0, description: 1, buy_price: 2 })).toMatchObject({ buy_price: 0 });
  });
  it("reports which price fields the sheet carried", () => {
    expect(mappedFields({ code: 0, description: 1, kit: 2, buy_price: 4 })).toEqual(["code", "description", "buy_price"]);
  });
});
