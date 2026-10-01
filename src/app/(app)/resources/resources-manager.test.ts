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

import { LEAVE_FOR_VENDORS, ResourcesManager, formHasWork, resourceForm, type Form, type Resource } from "./resources-manager";
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
    expect(form).toMatch(/<Link href=\{VENDORS_HREF\} className="inline-flex min-h-11 items-center[^"]*" onClick=\{openVendors\}>\s*Open Vendors\s*<\/Link>/);
    expect(form.indexOf('id="r-cat"')).toBeLessThan(form.indexOf("Open Vendors"));
    // One link: the only other "Open Vendors" is the question it asks before leaving typed work.
    expect(src.match(/>\s*Open Vendors\s*</g)?.length).toBe(1);
    expect(src.match(/href=\{VENDORS_HREF\}/g)?.length).toBe(1);
    expect(VENDORS_HREF).toBe("/price-list?tab=options");
  });
});

/**
 * OPEN VENDORS NEVER THROWS TYPED WORK AWAY WITHOUT ASKING. The form is inline (not a guarded
 * sheet) and lives only in this page's state, so leaving for the Vendors tab loses it. Someone
 * adding a supplier pastes its site, Fill From Their Site fills the boxes, they read "Suppliers ...
 * live in Price List › Vendors" and tap Open Vendors: they are asked first, the same way Type It
 * In's Open Snap Or Note asks. A form with nothing in it just goes.
 */
describe("Open Vendors asks before leaving typed work", () => {
  const empty: Form = { name: "", category: "Building Department", contact: "", phone: "", email: "", website: "", address: "", notes: "" };

  it("a new contact with nothing typed leaves without asking; spaces alone are not work", () => {
    expect(formHasWork(empty, empty)).toBe(false);
    expect(formHasWork({ ...empty, name: "   " }, empty)).toBe(false);
  });

  it("any box typed or filled from their site is work: name, contact, phone, email, website, address, notes, category", () => {
    const boxes: (keyof Form)[] = ["name", "contact", "phone", "email", "website", "address", "notes"];
    for (const k of boxes) expect(formHasWork({ ...empty, [k]: "x" }, empty)).toBe(true);
    expect(formHasWork({ ...empty, category: "Inspector" }, empty)).toBe(true);
    // Fill From Their Site's usual answer.
    expect(formHasWork({ ...empty, website: "acme-supply.example", name: "Acme Supply", phone: "(530) 555-0150", address: "1 Main St" }, empty)).toBe(true);
  });

  it("an edit asks only when something differs from the saved contact", () => {
    const saved = resourceForm(rows[0]);
    expect(saved.phone).toBe("(530) 555-0110");
    expect(formHasWork(saved, saved)).toBe(false);
    expect(formHasWork({ ...saved, phone: "(530) 555-0199" }, saved)).toBe(true);
    expect(formHasWork({ ...saved, notes: "Inspections before 10" }, saved)).toBe(true);
    // An old Supplier / Distributor row keeps its category, and opening it to look is not work.
    const old = resourceForm(rows[1]);
    expect(old.category).toBe("Supplier / Distributor");
    expect(formHasWork(old, old)).toBe(false);
  });

  it("the link confirms in plain words when the form holds work, and stays put when they cancel", () => {
    expect(LEAVE_FOR_VENDORS).toBe("Open Vendors? What you typed here won't be saved.");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/resources/resources-manager.tsx"), "utf8");
    const guard = src.slice(src.indexOf("function openVendors("), src.indexOf("FILL FROM THEIR SITE"));
    expect(guard).toContain("resources.find((r) => r.id === editingId)");
    expect(guard).toContain("row ? resourceForm(row) : EMPTY_FORM");
    expect(guard).toMatch(/formHasWork\(form, start\) && !window\.confirm\(LEAVE_FOR_VENDORS\)\) e\.preventDefault\(\)/);
  });
});
