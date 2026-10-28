import { describe, it, expect } from "vitest";
import { renderers, text } from "./editor-test-mocks";

/**
 * SALES TAX, THE SWITCH (0352, rule g), on the one estimate editor's two doors (cn-v1132).
 *
 *  - A new estimate: no switches stored / on renders with the default rate seeded, the tax field and
 *    the Tax row drawn. Off: no default seeds it, no tax field and no "Tax $0.00" row.
 *  - A saved estimate: an untaxed one shows no tax row and no tax field while off; a taxed one keeps
 *    both, so its total still reads whole.
 */

const { EstimateEditor } = await import("./estimate-editor");
const { unsaved, saved } = renderers(EstimateEditor);

const RATES = [{ id: "r1", name: "County", rate: 8.25, is_default: true }];
const panel = { description: "Panel", quantity: 1, unit: "ea", unit_price: 1000 };
const builder = (cat: Record<string, unknown> = {}) => unsaved({ items: [panel] }, { taxRates: RATES, salesTax: true, ...cat });

describe("a new estimate", () => {
  it("no switches stored / on: the default rate seeds it, the field and the Tax row are drawn", () => {
    const today = builder();
    expect(today).toContain('id="tax"');
    expect(today).toMatch(/<option value="r1" selected="">County/);
    // $1,000 at 8.25%.
    expect(text(today)).toContain("Tax $82.50");
    expect(text(today)).toContain("Total $1,082.50");
  });

  it("off: no default seeds it, no tax field, no Tax row; the total is the subtotal", () => {
    const off = builder({ salesTax: false });
    expect(off).not.toContain('id="tax"');
    expect(text(off)).not.toMatch(/\bTax \$/);
    expect(text(off)).toContain("Total $1,000.00");
  });
});

describe("a saved estimate", () => {
  const row = { id: "li-1", description: "Panel", quantity: 1, unit: "ea", unit_price: 1000, category: null, detail: null, sort_order: 0 };

  it("no switches stored / on: the Tax row and the rate field", () => {
    const today = saved({}, [row], {}, { taxRates: RATES, salesTax: true });
    expect(text(today)).toContain("Tax $0.00");
    expect(today).toContain('id="tax"');
    expect(today).toMatch(/<option value="" selected="">No Tax/);
  });

  it("off, untaxed: no Tax row and no tax field", () => {
    const off = saved({}, [row], {}, { taxRates: RATES, salesTax: false });
    expect(text(off)).not.toMatch(/\bTax \$/);
    expect(off).not.toContain('id="tax"');
    expect(off).toContain('id="valid"');
  });

  it("off, already taxed: the Tax row and the field stay, the total is untouched; a rate that is nobody's reads as the percent it is", () => {
    const off = saved({ tax_rate: 0.0825 }, [row], {}, { taxRates: RATES, salesTax: false });
    expect(text(off)).toContain("Tax $82.50");
    expect(text(off)).toContain("$1,082.50");
    expect(off).toMatch(/<input[^>]*id="tax"[^>]*value="8.25"/);
    // Switch on with the org's rate matching: the select, with County chosen.
    const on = saved({ tax_rate: 0.0825 }, [row], {}, { taxRates: RATES, salesTax: true });
    expect(on).toMatch(/<option value="r1" selected="">County/);
  });

  it("locked: the rate reads as text with the reason, never as an input that can only be refused", () => {
    const locked = saved({ tax_rate: 0.0825 }, [row], { lock: { reason: "A draw was already billed against it." } }, { taxRates: RATES, salesTax: true });
    expect(locked).not.toMatch(/<select[^>]*id="tax"/);
    expect(text(locked)).toContain("8.25%");
    expect(text(locked)).toContain("Changing the rate would change the total. A draw was already billed against it.");
  });
});
