import { describe, it, expect } from "vitest";
import { invoiceAmount } from "./invoice-amount";

// Made-up figures only: this repo is public.
describe("invoiceAmount — what is due, and what it is due against", () => {
  it("leads with the total and says nothing more when nothing is paid", () => {
    expect(invoiceAmount(1000, 0)).toEqual({ due: "$1,000.00", detail: null });
    expect(invoiceAmount(1000, null)).toEqual({ due: "$1,000.00", detail: null });
    expect(invoiceAmount(1000, 0.004)).toEqual({ due: "$1,000.00", detail: null });
  });

  it("shows the balance with the total and the paid amount under it on a partial", () => {
    expect(invoiceAmount(1000, 250)).toEqual({ due: "$750.00", detail: "of $1,000.00 · $250.00 paid" });
  });

  it("reads $0.00 and paid in full when settled", () => {
    expect(invoiceAmount(1000, 1000)).toEqual({ due: "$0.00", detail: "of $1,000.00 · paid in full" });
    // Float dust is still paid in full.
    expect(invoiceAmount(0.03, 0.01 + 0.02)).toEqual({ due: "$0.00", detail: "of $0.03 · paid in full" });
  });

  it("names an overpayment instead of hiding it in a $0.00", () => {
    expect(invoiceAmount(1000, 1040)).toEqual({
      due: "$0.00",
      detail: "of $1,000.00 · $1,040.00 paid · $40.00 over",
    });
  });

  it("prints a credit memo's negative total and calls it a credit, never $0.00", () => {
    expect(invoiceAmount(-250, 0)).toEqual({ due: "-$250.00", detail: "credit" });
    expect(invoiceAmount(-250, null)).toEqual({ due: "-$250.00", detail: "credit" });
  });

  it("never prints NaN", () => {
    expect(invoiceAmount(Number.NaN, Number.NaN)).toEqual({ due: "$0.00", detail: null });
    expect(invoiceAmount(undefined, 50).due).toBe("$0.00");
  });
});
