import { describe, it, expect } from "vitest";
import { billedPartMoved, claimedMoveRefusal } from "./claim-words";

describe("claim words", () => {
  it("claimedMoveRefusal names the invoice and the way out", () => {
    const s = claimedMoveRefusal({ id: "x", invoice_number: "INV-048" });
    expect(s).toContain("INV-048 already bills this shift");
    expect(s).toContain("void or adjust");
    expect(s).toContain("Nothing was changed.");
  });

  it("names an invoice with no number yet", () => {
    expect(claimedMoveRefusal({ id: "x", invoice_number: null })).toMatch(/^an invoice already bills/);
  });

  it("billedPartMoved says both figures and that the invoice keeps its own", () => {
    const s = billedPartMoved({ id: "x", invoice_number: "INV-078" }, 5.5, 4.5);
    expect(s).toContain("INV-078 bills 5.50 h of this shift and that part now reads 4.50 h.");
    expect(s).toContain("The invoice keeps its figure");
  });
});
