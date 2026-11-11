import { describe, expect, it } from "vitest";
import { TECH_DOCUMENT_CATEGORIES, documentsForViewer, isTechDocument } from "./tech-documents";
import { NOT_A_COST_CATEGORY } from "./job-photos";

/**
 * J-011's receipts on a tech's Photos tab (audit v994, HB-2): every live category on ET's books,
 * and the four J-011 receipts that sat in the job's own folder, readable by any member.
 */
const J011 = [
  { id: "r1", name: "1790110350928-image.jpg", category: "Receipt" },
  { id: "r2", name: "1790235950185-IMG_2375.jpg", category: "Receipt" },
  { id: "b1", name: "Consolidated Electrical Dist. — $323.71", category: "Bill" },
  { id: "i1", name: "CED invoice.pdf", category: "Invoice" },
  { id: "p1", name: "panel.jpg", category: "Photo" },
  { id: "pl", name: "plans.pdf", category: "Plan" },
  { id: "pe", name: "permit.jpg", category: "Permit" },
  { id: "o1", name: "note.jpg", category: "Other" },
  { id: "n1", name: "mystery.jpg", category: null },
];

describe("a tech is handed no cost paper", () => {
  it("a tech gets photos, plans, permits and other job papers; never a receipt, bill or invoice", () => {
    expect(documentsForViewer(J011, false).map((d) => d.id)).toEqual(["p1", "pl", "pe", "o1"]);
  });

  it("a paper with no category is left out by choice, not by a NULL slipping through a NOT IN", () => {
    expect(isTechDocument({ category: null })).toBe(false);
    expect(isTechDocument({ category: "Materials" })).toBe(false);
  });

  it("the office keeps every paper", () => {
    expect(documentsForViewer(J011, true)).toHaveLength(J011.length);
  });

  // 2026-11-10: Needs You's Not a Cost files a paper that was a Receipt and never was one (a
  // supplier's quote, with his prices on it) under its own category. Saying what a paper is NOT must
  // leave its audience as it was: the Receipt was the office's alone, and so is this.
  it("a paper the office called Not a Cost stays the office's: a tech is handed it no more than the Receipt it was", () => {
    const quote = { id: "q1", name: "supplier-quote.jpg", category: NOT_A_COST_CATEGORY };
    expect(NOT_A_COST_CATEGORY).toBe("Not a Cost");
    expect(isTechDocument(quote)).toBe(false);
    expect(TECH_DOCUMENT_CATEGORIES as readonly string[]).not.toContain(NOT_A_COST_CATEGORY);
    expect(documentsForViewer([...J011, quote], false).map((d) => d.id)).toEqual(["p1", "pl", "pe", "o1"]);
    expect(documentsForViewer([...J011, quote], true).map((d) => d.id)).toContain("q1");
    // Filed as Other it WOULD be the crew's, which is why the door never writes that word.
    expect(isTechDocument({ ...quote, category: "Other" })).toBe(true);
  });
});
