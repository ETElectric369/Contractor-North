import { describe, it, expect } from "vitest";
import { billedPartMoved, claimedMoveRefusal, claimedPersonRefusal } from "./claim-words";

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

  it("claimedPersonRefusal names the invoice, whose hours it billed, and the way out", () => {
    expect(claimedPersonRefusal({ id: "x", invoice_number: "INV-048" }, " Erik Taylor ")).toBe(
      "INV-048 already bills this shift as Erik Taylor's hours — void or adjust that invoice before handing the shift to someone else. Nothing was changed.",
    );
    // No name to hand (a hidden profile): still one plain sentence, never "as 's hours".
    expect(claimedPersonRefusal({ id: "x", invoice_number: null }, "")).toBe(
      "an invoice already bills this shift — void or adjust that invoice before handing the shift to someone else. Nothing was changed.",
    );
  });

  it("billedPartMoved says both figures and that the invoice keeps its own", () => {
    const s = billedPartMoved({ id: "x", invoice_number: "INV-078" }, 5.5, 4.5);
    expect(s).toContain("INV-078 bills 5.50 h of this shift and that part now reads 4.50 h.");
    expect(s).toContain("The invoice keeps its figure");
  });
});
