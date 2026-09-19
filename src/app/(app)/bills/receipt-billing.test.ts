import { describe, it, expect } from "vitest";
import {
  FOOD_AND_DRINK,
  RECEIPT_LINE_CATEGORIES,
  RECEIPT_LINE_CATEGORY_CHOICES,
  defaultBillable,
  normalizeBillable,
  splitReceiptBilling,
} from "./receipt-billing";

describe("what the receipt reader bills by default", () => {
  it("bills everything except food and drink", () => {
    for (const c of RECEIPT_LINE_CATEGORIES) {
      expect(defaultBillable(c)).toBe(c !== FOOD_AND_DRINK);
    }
  });

  // Erik chose food and drink ONLY. A tool on a job receipt is his call, line by line — it must
  // not quietly stop billing the day this ships, or a customer's invoice changes without him.
  it("still bills tools, and still bills tax", () => {
    expect(defaultBillable("Tools")).toBe(true);
    expect(defaultBillable("Tax")).toBe(true);
  });

  it("bills an unknown or missing category — the safe direction", () => {
    expect(defaultBillable(null)).toBe(true);
    expect(defaultBillable(undefined)).toBe(true);
    expect(defaultBillable("")).toBe(true);
    expect(defaultBillable("Strut & Clamp")).toBe(true);
  });

  it("recognises the category however the model spells it", () => {
    expect(defaultBillable("food and drink")).toBe(false);
    expect(defaultBillable("FOOD & DRINK")).toBe(false);
    expect(defaultBillable("Food/Drink")).toBe(false);
  });

  it("offers the new category to both prompts in one string", () => {
    expect(RECEIPT_LINE_CATEGORY_CHOICES).toContain('"Food & Drink"');
    expect(RECEIPT_LINE_CATEGORY_CHOICES).toContain('"Materials"');
    expect(RECEIPT_LINE_CATEGORY_CHOICES).toContain('"Tax"');
  });
});

describe("a decision already made survives being re-filed", () => {
  // organized_items.line_items is jsonb, re-read verbatim when a tray item is filed or moved to
  // another job. Without this, moving a receipt would re-bill the snacks Erik had switched off.
  it("keeps an explicit false on a line the default would bill", () => {
    expect(normalizeBillable(false, "Tools")).toBe(false);
  });

  it("keeps an explicit true on a food line Erik decided to bill", () => {
    expect(normalizeBillable(true, FOOD_AND_DRINK)).toBe(true);
  });

  it("falls back to the default when no decision was stored", () => {
    expect(normalizeBillable(undefined, FOOD_AND_DRINK)).toBe(false);
    expect(normalizeBillable(null, "Materials")).toBe(true);
    // A legacy row predates the column AND the category, so it stays billed.
    expect(normalizeBillable(undefined, "Other")).toBe(true);
  });

  it("ignores a non-boolean the model or an old row might carry", () => {
    expect(normalizeBillable("false", FOOD_AND_DRINK)).toBe(false);
    expect(normalizeBillable("false", "Materials")).toBe(true);
    expect(normalizeBillable(0, "Materials")).toBe(true);
  });
});

describe("what the customer gets billed for a receipt", () => {
  it("bills the whole receipt when every line is the customer's", () => {
    const split = splitReceiptBilling(120.5, [
      { amount: 100, billable: true },
      { amount: 20.5, billable: true },
    ]);
    expect(split).toEqual({ cost: 120.5, billed: 120.5, notBilled: 0, notBilledCount: 0 });
  });

  it("subtracts only the lines that are switched off", () => {
    // The INV-069 shape: a bottle of water, a BodyArmor and a ten cent bottle deposit.
    const split = splitReceiptBilling(100, [
      { amount: 90, billable: true },
      { amount: 2.49, billable: false },
      { amount: 3.29, billable: false },
      { amount: 0.1, billable: false },
    ]);
    expect(split.billed).toBe(94.12);
    expect(split.notBilled).toBe(5.88);
    expect(split.notBilledCount).toBe(3);
  });

  it("always adds back up to what the receipt cost", () => {
    const split = splitReceiptBilling(6412.64, [
      { amount: 1.99, billable: false },
      { amount: 0.1, billable: false },
      { amount: 6410.55, billable: true },
    ]);
    expect(round(split.billed + split.notBilled)).toBe(split.cost);
  });

  it("treats a missing flag as billed", () => {
    const split = splitReceiptBilling(50, [{ amount: 50 }]);
    expect(split.billed).toBe(50);
    expect(split.notBilledCount).toBe(0);
  });

  // A misread transcription can claim more non-billable money than the receipt holds. Billing a
  // negative amount would be inventing a figure; the clamp is the refusal to do that.
  it("never bills a negative amount", () => {
    const split = splitReceiptBilling(10, [{ amount: 40, billable: false }]);
    expect(split.billed).toBe(0);
    expect(split.notBilled).toBe(10);
    expect(round(split.billed + split.notBilled)).toBe(split.cost);
  });

  it("rounds to cents instead of trailing float dust", () => {
    const split = splitReceiptBilling(10.1, [
      { amount: 0.1, billable: false },
      { amount: 0.2, billable: false },
    ]);
    expect(split.billed).toBe(9.8);
    expect(split.notBilled).toBe(0.3);
  });

  it("survives a bill with no lines at all", () => {
    expect(splitReceiptBilling(75, [])).toEqual({ cost: 75, billed: 75, notBilled: 0, notBilledCount: 0 });
    expect(splitReceiptBilling(null, null)).toEqual({ cost: 0, billed: 0, notBilled: 0, notBilledCount: 0 });
  });

  // A returned snack is a credit the company keeps, so the customer's half can legitimately come
  // out above the receipt's net total. That is arithmetic, not a bug — assert it stays that way.
  it("handles a returned line that was never the customer's", () => {
    const split = splitReceiptBilling(97, [
      { amount: 100, billable: true },
      { amount: -3, billable: false },
    ]);
    expect(split.billed).toBe(100);
    expect(split.notBilled).toBe(-3);
  });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
