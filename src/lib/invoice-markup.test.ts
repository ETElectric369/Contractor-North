import { describe, it, expect } from "vitest";
import { markupOnInvoice, type InvoiceCostLine } from "./invoice-markup";

/** INV-078's untouched CED bills on 2026-09-24: $199.48 → $229.40, $150.27 → $172.81, $103.99 →
 *  $119.59 - every one at 15.00% (read from Erik's database). */
const BILLS = [
  { id: "b-1", amount: "199.48" },
  { id: "b-2", amount: "150.27" },
  { id: "b-3", amount: "103.99" },
];
const line = (billId: string, total: number, extra: Partial<InvoiceCostLine> = {}): InvoiceCostLine => ({
  import_key: `bill:${billId}`,
  source_ids: [billId],
  line_total: total,
  edited: false,
  ...extra,
});
const base = { dismissed: new Set<string>(), bills: BILLS, linesByBill: new Map(), pos: [] as { id: string; total: unknown }[] };

describe("markupOnInvoice — the invoice's lines say what markup they were priced at", () => {
  it("INV-078: 15%", () => {
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 229.4), line("b-2", 172.81), line("b-3", 119.59)] })).toBe(15);
  });

  it("after the % box was set to 20", () => {
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 239.38), line("b-2", 180.32), line("b-3", 124.79)] })).toBe(20);
  });

  it("an edited bill, a deleted row, or a return has no vote", () => {
    const lines = [line("b-1", 229.4), line("b-2", 999, { edited: true }), line("b-3", 1)];
    expect(markupOnInvoice({ ...base, dismissed: new Set(["bill:b-3:remainder"]), lines })).toBe(15);
    expect(markupOnInvoice({ ...base, bills: [...BILLS, { id: "r-1", amount: "-40" }], lines: [line("b-1", 229.4), line("r-1", -46)] })).toBe(15);
  });

  it("bills priced at two different markups have no single answer", () => {
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 229.4), line("b-2", 180.32)] })).toBeNull();
  });

  it("nothing to read it from → null (the caller's markup applies)", () => {
    expect(markupOnInvoice({ ...base, lines: [] })).toBeNull();
    expect(markupOnInvoice({ ...base, lines: [line("b-1", 229.4, { edited: true })] })).toBeNull();
  });

  it("a PO line reads its total", () => {
    expect(markupOnInvoice({ ...base, bills: [], pos: [{ id: "po-1", total: 500 }], lines: [{ import_key: "po:po-1", source_ids: ["po-1"], line_total: 625, edited: false }] })).toBe(25);
  });
});
