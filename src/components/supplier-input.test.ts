import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/bills/known-suppliers-action", () => ({ listKnownSuppliers: vi.fn(async () => []) }));

import { SupplierInput } from "./supplier-input";

/**
 * THE SUPPLIER BOX IS ONE COMPONENT (item D, 2026-10-07), on every door a supplier is typed. A sixth
 * door that draws a plain Input for a supplier is the fork this test refuses.
 */
describe("the supplier box", () => {
  const DOORS: [string, string][] = [
    ["src/app/(app)/bills/bills-receipts.tsx", 'id="be-supplier"'],
    ["src/app/(app)/jobs/[id]/job-bills.tsx", 'id="be-supplier"'],
    ["src/components/quick-cost-button.tsx", 'id="qc-supplier"'],
    ["src/components/quick-cost-button.tsx", 'id="ti-where"'],
    ["src/components/paperwork-row.tsx", "id={`fd-vendor-${item.id}`}"],
  ];

  it("every door a supplier is typed on draws SupplierInput, never a plain Input", () => {
    for (const [file, id] of DOORS) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const at = src.indexOf(id);
      expect(at, `${file} has no ${id}`).toBeGreaterThan(-1);
      const tag = src.slice(src.lastIndexOf("<", at), at);
      expect(tag, `${file}: ${id} is drawn by ${tag.trim()}`).toMatch(/^<SupplierInput\b/);
    }
  });

  it("a business cost's Who You Pay keeps the box quiet (a landlord or a bucket word is not a supplier)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    expect(src).toMatch(/id="qc-supplier"[^>]*quiet=\{!targetJob\}/);
    expect(src).toMatch(/id="ti-where"[^>]*quiet=\{target === BUSINESS\}/);
  });

  it("draws the plain box until it is focused: no hint, no read, the same id and value", () => {
    const html = renderToStaticMarkup(createElement(SupplierInput, { id: "be-supplier", value: "Anytown Electric", onValueChange: () => {} }));
    expect(html).toContain('id="be-supplier"');
    expect(html).toContain('value="Anytown Electric"');
    expect(html).not.toContain("Did you mean");
  });

  it("the server keeps an exact spelling as the one name at every bill door, and Nort is told to spell it that way", () => {
    const core = readFileSync(join(process.cwd(), "src/app/(app)/organize/paperwork-core.ts"), "utf8");
    expect(core).toContain("export async function exactSupplierFor(");
    for (const file of ["src/app/(app)/jobs/actions.ts", "src/app/(app)/organize/actions.ts", "src/app/(app)/organize/paperwork-actions.ts"]) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), file).toContain("exactSupplierFor(");
    }
    const nort = readFileSync(join(process.cwd(), "src/lib/actions/entities/bill.ts"), "utf8");
    expect(nort.match(/supplier_balances \/ list_bills/g)?.length).toBe(2);
  });
});
