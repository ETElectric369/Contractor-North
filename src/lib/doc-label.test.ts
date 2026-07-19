import { describe, expect, it } from "vitest";
import { docLabel } from "./doc-label";

describe("docLabel — the one customer-facing document word", () => {
  it("labels a T&M estimate", () => {
    expect(docLabel({ doc_type: "estimate" })).toBe("Estimate");
  });

  it("labels a fixed-price quote", () => {
    expect(docLabel({ doc_type: "quote" })).toBe("Quote");
  });

  // The historical fallback on every surface was `(doc_type ?? "quote")` — a row
  // predating the column (or a select that omitted it) must keep reading "Quote".
  it("falls back to Quote when doc_type is missing", () => {
    expect(docLabel({ doc_type: null })).toBe("Quote");
    expect(docLabel({})).toBe("Quote");
    expect(docLabel(null)).toBe("Quote");
    expect(docLabel(undefined)).toBe("Quote");
  });

  it("treats an unknown value as Quote (the CHECK constraint bars it anyway)", () => {
    expect(docLabel({ doc_type: "proposal" })).toBe("Quote");
  });
});
