import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A PART PRINTS AS IT COUNTS (item 4 of the deferred four, 2026-10-10). The customer's paper rounds
 * each part to cents; the line's parts figure must be the sum of exactly those cents, or the bullets
 * the customer adds up miss the Amount beside them. One helper (partMoney) does the rounding, and
 * every surface that shows a part's money calls it — nobody multiplies qty × sell on their own.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("one arithmetic for a part's money", () => {
  const surfaces = ["src/components/quote-document.tsx", "src/app/(app)/quotes/new/quote-builder.tsx"];
  it("the document and the builder print a part through partMoney", () => {
    for (const f of surfaces) {
      const text = src(f);
      expect(text, f).toContain("formatCurrency(partMoney(m))");
      expect(text, f).toMatch(/import \{[^}]*\bpartMoney\b[^}]*\} from "@\/lib\/estimate\/task-lines"/);
    }
  });
  it("nobody multiplies a part's qty × sell by hand", () => {
    for (const f of surfaces) expect(src(f), f).not.toMatch(/m\.qty \* m\.sell|qty \* m\.sell|Math\.round\(m\.qty/);
    const rule = src("src/lib/estimate/task-lines.ts");
    expect(rule).toContain("const parts = round2(d.materials.filter(named).reduce((t, m) => t + partMoney(m), 0));");
  });
});
