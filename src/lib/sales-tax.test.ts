import { describe, it, expect } from "vitest";
import { summarizeSalesTax } from "./sales-tax";

describe("sales tax by rate (the Tax Report's arithmetic, now shared with the accountant download)", () => {
  it("counts issued invoices only, names a rate by its jurisdiction, and keeps 0% out of taxable sales", () => {
    const s = summarizeSalesTax(
      [
        { tax_rate: 0.0725, tax: 72.5, subtotal: 1000, status: "sent" },
        { tax_rate: 0.0725, tax: 7.25, subtotal: 100, status: "paid" },
        { tax_rate: 0, tax: 0, subtotal: 500, status: "paid" },
        { tax_rate: 0.0725, tax: 999, subtotal: 9999, status: "draft" },
        { tax_rate: 0.0725, tax: 999, subtotal: 9999, status: "void" },
      ],
      [{ name: "Placer County", rate: 7.25 }],
    );
    expect(s.totalTax).toBeCloseTo(79.75, 2);
    expect(s.totalTaxable).toBe(1100);
    expect(s.rows).toEqual([
      { name: "Placer County", pct: expect.closeTo(7.25, 6), taxable: 1100, tax: expect.closeTo(79.75, 6), count: 2 },
      { name: "No tax", pct: 0, taxable: 500, tax: 0, count: 1 },
    ]);
  });

  it("a rate with no named jurisdiction says its percent", () => {
    expect(summarizeSalesTax([{ tax_rate: 0.08, tax: 8, subtotal: 100, status: "sent" }], []).rows[0].name).toBe("8.000%");
  });
});
