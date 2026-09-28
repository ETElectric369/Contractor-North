import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OPEN VENDORS IS THE OFFICE'S DOOR (W2-13). The line under Category ("Suppliers and subcontractors
 * live in Price List › Vendors" and Open Vendors) sits inside the add/edit form, which renders only
 * for staff (canEdit). A tech reads Resources (he needs the inspector's number) and never gets a link
 * to the Price List, where the prices are.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({ createResource: vi.fn(), updateResource: vi.fn(), deleteResource: vi.fn() }));
vi.mock("./fill-from-site", () => ({ fillFromSite: vi.fn() }));

import { ResourcesManager, type Resource } from "./resources-manager";
import { VENDORS_HREF } from "./categories";

const rows: Resource[] = [
  { id: "r1", name: "County Building Department", category: "Building Department", contact_name: null, phone: "(530) 555-0110", email: null, website: "county.example/building", address: null, notes: null },
  { id: "r2", name: "Acme Electric Supply", category: "Supplier / Distributor", contact_name: null, phone: "(530) 555-0150", email: null, website: null, address: null, notes: null },
];

describe("Open Vendors is staff only", () => {
  it("a tech's read-only Resources has no Open Vendors and no link to the Price List", () => {
    const html = renderToStaticMarkup(createElement(ResourcesManager, { resources: rows, canEdit: false }));
    expect(html).toContain("County Building Department");
    expect(html).not.toContain("Open Vendors");
    expect(html).not.toContain("/price-list");
    expect(html).not.toContain("Add Contact");
  });

  it("an old Supplier / Distributor row still groups under its own heading", () => {
    const html = renderToStaticMarkup(createElement(ResourcesManager, { resources: rows, canEdit: false }));
    expect(html).toContain(">Supplier / Distributor</h3>");
    expect(html).toContain("Acme Electric Supply");
  });

  it("the line and its 44px Title Case link live inside the staff-only form, under Category, to the Vendors tab", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/resources/resources-manager.tsx"), "utf8");
    const form = src.slice(src.indexOf("{canEdit && (adding || editingId) && ("), src.indexOf("{resources.length === 0 ? ("));
    expect(form.length).toBeGreaterThan(0);
    expect(form).toContain("{SUPPLIERS_LIVE_IN_VENDORS}");
    expect(form).toMatch(/<Link href=\{VENDORS_HREF\} className="inline-flex min-h-11 items-center[^"]*">\s*Open Vendors\s*<\/Link>/);
    expect(form.indexOf('id="r-cat"')).toBeLessThan(form.indexOf("Open Vendors"));
    expect(src.split("Open Vendors").length - 1).toBe(1);
    expect(VENDORS_HREF).toBe("/price-list?tab=options");
  });
});
