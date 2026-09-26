import { describe, it, expect } from "vitest";
import { estimateIsTheContract, jobBillsItsActuals, shouldImportActuals } from "./invoice-import-rule";

describe("shouldImportActuals — the contract-vs-actuals rule", () => {
  it("a QUOTED job does not import actuals by default (the double-bill guard)", () => {
    // The regression: three entry points (job Invoices tab, /billing Create Invoice,
    // Nort's finish verb) pass no flags. Quote lines + labor + materials = double bill.
    expect(shouldImportActuals(true, undefined)).toBe(false);
  });

  it("a T&M job (no quote) imports actuals by default — unchanged behavior", () => {
    expect(shouldImportActuals(false, undefined)).toBe(true);
  });

  it("an explicit true still forces T&M on top of a quote (FinishJobButton's toggle)", () => {
    expect(shouldImportActuals(true, true)).toBe(true);
  });

  it("an explicit false always suppresses, quote or not", () => {
    expect(shouldImportActuals(true, false)).toBe(false);
    expect(shouldImportActuals(false, false)).toBe(false);
  });
});

describe("estimateIsTheContract - on T&M the estimate is a guide (Erik, Tao J-002)", () => {
  it("a T&M job's accepted estimate is not the bill; the hours and receipts are", () => {
    expect(estimateIsTheContract("tm", true)).toBe(false);
    expect(shouldImportActuals(estimateIsTheContract("tm", true), undefined)).toBe(true);
    // ...so the running total shows on it (the same answer the card and the portal read).
    expect(jobBillsItsActuals("tm", 0)).toBe(true);
  });
  it("a fixed-price job's live estimate is still the contract; no estimate, no contract", () => {
    expect(estimateIsTheContract("fixed", true)).toBe(true);
    expect(estimateIsTheContract(null, true)).toBe(true);
    expect(estimateIsTheContract("fixed", false)).toBe(false);
    expect(estimateIsTheContract("tm", false)).toBe(false);
  });
});
