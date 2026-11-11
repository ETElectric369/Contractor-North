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
  // The breakdown is the one editor's (cn-v1132: quotes/task-breakdown.tsx serves both estimate pages).
  const surfaces = ["src/components/quote-document.tsx", "src/app/(app)/quotes/task-breakdown.tsx"];
  it("the document and the editor's breakdown print a part through partMoney", () => {
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

/**
 * THE ONE MATERIALS LINE COUNTS AS THE PARTS DID (cn-v1158). Under the "grouped" format the paper
 * prints the parts as one figure, and that figure has to be the very sum the itemised paper's bullets
 * add up to — each part rounded as printed, then added — or the two papers of one estimate would
 * disagree by a cent. So it is taskMoney's own parts figure (the line pinned above), decided in ONE
 * place (paperBreakdown) and only drawn by the document; and the figure the customer's page is handed
 * in place of the parts (public_quote's materials_total) goes through the same arithmetic as one part,
 * never through a sum of its own.
 */
describe("one arithmetic for the Materials line", () => {
  const rule = src("src/lib/estimate/task-lines.ts");
  const doc = src("src/components/quote-document.tsx");
  /** A function's body: from its declaration to the first closing brace at column 0. */
  const body = (decl: string) => {
    const at = rule.indexOf(decl);
    expect(at, decl).toBeGreaterThan(-1);
    const open = rule.indexOf("{\n", rule.indexOf(")", at + decl.length));
    return rule.slice(open, rule.indexOf("\n}\n", open));
  };

  it("the figure is taskMoney's parts — the decision adds nothing up itself", () => {
    const decision = body("export function paperBreakdown(");
    expect(decision).toContain("const figure = taskMoney(d).parts;");
    expect(decision).toContain("if (!detailExplains(d, line)) return null;"); // the one gate, for both shapes
    expect(decision).not.toMatch(/[+*]|\.reduce\(|Math\./);
  });

  it("the wire's total is read as ONE part (so partMoney and taskMoney count it), and only when no parts are in hand", () => {
    const wire = body("function partsInHandOrWire(");
    expect(wire).toContain("if (d.materials.length > 0) return d;");
    expect(wire).toContain("qty: 1, cost: null, sell: total");
    expect(wire).not.toMatch(/[+*]|\.reduce\(|Math\./);
    // materials_total is read in ONE place, off the raw detail — never by the readers a save goes through.
    expect(rule.match(/\)\.materials_total\b/g)).toHaveLength(1);
    expect(body("function wireMaterialsTotal(")).toContain("(raw as Record<string, unknown>).materials_total");
    expect(body("export function coerceTaskDetail(")).not.toContain("materials_total");
    expect(body("export function normalizeTaskDetail(")).not.toContain("materials_total");
  });

  it("the document draws the decision: the Materials figure and each labor row through the one arithmetic, no sum of its own", () => {
    expect(doc).toMatch(/import \{[^}]*\bpaperBreakdown\b[^}]*\} from "@\/lib\/estimate\/task-lines"/);
    expect(doc).toContain("const breakdown = paperBreakdown(it, estimateFormat);");
    expect(doc).toContain("<li>Materials · {formatCurrency(breakdown.materials)}</li>");
    expect(doc).toContain("formatCurrency(laborMoney(row))");
    expect(doc).not.toMatch(/\.reduce\(|row\.hours \* row\.rate|taskMoney\(/);
    // The format is the decision's to read, never the document's: no branch on the word here.
    expect(doc).not.toMatch(/estimateFormat === |=== "detailed"|=== "grouped"/);
  });
});
