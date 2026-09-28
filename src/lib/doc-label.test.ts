import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docLabel, isFixedPrice } from "./doc-label";

describe("isFixedPrice — the office's Fixed chip (W1-25)", () => {
  it("only a row that says quote is fixed-price", () => {
    expect(isFixedPrice({ doc_type: "quote" })).toBe(true);
    expect(isFixedPrice({ doc_type: "estimate" })).toBe(false);
  });

  // Strict, unlike docLabel's fallback: a row read without the column is never called fixed on a guess.
  it("a missing or unknown doc_type draws no chip", () => {
    for (const q of [{ doc_type: null }, {}, null, undefined, { doc_type: "proposal" }]) expect(isFixedPrice(q)).toBe(false);
  });

  it("the lists draw the Fixed pill and no Est / Quote pill", () => {
    for (const f of ["src/app/(app)/quotes/quotes-list.tsx", "src/app/(app)/jobs/[id]/page.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/isFixedPrice\(q\) && <span className=\{FIXED_PILL_CLASS\}>Fixed<\/span>/);
      expect(src, f).not.toContain('"Est" : "Quote"');
    }
  });
});

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
