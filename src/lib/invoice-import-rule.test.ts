import { describe, it, expect } from "vitest";
import { shouldImportActuals } from "./invoice-import-rule";

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
