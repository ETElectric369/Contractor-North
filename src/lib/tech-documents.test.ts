import { describe, expect, it } from "vitest";
import { documentsForViewer, isTechDocument } from "./tech-documents";

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
});
