import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE VENDOR SCREENS, RENDERED: what Justin sees when he clicks 830 on the Price List, and what
 * the Vendors tab lists. Rendered to markup with the router and actions stubbed, so the doors are
 * counted on the real components (the dead-door lesson: run the selector, count the buttons).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./actions", () => ({
  addItemOption: vi.fn(),
  archiveItemOption: vi.fn(),
  setDefaultItemOption: vi.fn(),
  setItemOptionSell: vi.fn(),
  updateItemOption: vi.fn(),
  updatePriceItem: vi.fn(),
  archivePriceItem: vi.fn(),
  createPriceItem: vi.fn(),
  deletePriceItem: vi.fn(),
}));
vi.mock("./vendor-actions", () => ({ addVendor: vi.fn(), archiveVendor: vi.fn(), restoreVendor: vi.fn(), saveVendorField: vi.fn() }));
vi.mock("./kit-actions", () => ({ addItemsToKit: vi.fn() }));
vi.mock("./import-preview", () => ({ ImportCsvModal: () => null }));
vi.mock("./edit-price-item-button", () => ({ EditPriceItemButton: () => null }));

import { ItemSheet } from "./item-sheet";
import { VendorsManager } from "./vendors-manager";
import { PriceListManager } from "./price-list-manager";
import { summarizeVendors, type ItemOption } from "./item-options-math";
import type { PriceItem } from "./price-list-math";

const w830: PriceItem = {
  id: "i830",
  code: "830",
  description: "Windows (Materials) (Allowance)",
  category: null,
  supplier: null,
  unit: "ea",
  buy_price: 830,
  markup_pct: 0,
  archived: false,
};
const options: ItemOption[] = [
  { id: "a", item_id: "i830", vendor: "Andersen", label: "400 Series", part_number: null, unit: null, buy_price: 1200, markup_pct: null, is_default: true, archived: false, sort_order: 1 },
  { id: "m", item_id: "i830", vendor: "Milgard", label: null, part_number: null, unit: null, buy_price: 950, markup_pct: 10, is_default: false, archived: false, sort_order: 2 },
  { id: "p", item_id: "i830", vendor: "Pella", label: null, part_number: null, unit: null, buy_price: 700, markup_pct: null, is_default: false, archived: true, sort_order: 3 },
];

const count = (html: string, s: string) => html.split(s).length - 1;

describe("clicking an item opens its vendors", () => {
  const html = renderToStaticMarkup(
    createElement(ItemSheet, { item: w830, options, defaultMarkupPct: 25, knownVendors: ["Andersen", "Milgard", "Pella"], onClose: () => {} }),
  );

  it("lists each live vendor with its Cost and its Sell", () => {
    expect(html).toContain("Andersen 400 Series");
    expect(html).toContain("Milgard");
    expect(html).toContain("$1,200.00"); // Andersen cost
    expect(html).toContain("$1,500.00"); // Andersen sell at the org's 25%
    expect(html).toContain("$950.00"); // Milgard cost
    expect(html).toContain("$1,045.00"); // Milgard sell at its own 10%
  });

  it("marks one Default and offers Make Default on the other, plus the item's own price back", () => {
    expect(count(html, "Make Default")).toBe(1);
    expect(html).toContain("Use The Item’s Price");
  });

  it("Add Vendor is right there, Archive is on every live vendor, and the archived one is behind Show", () => {
    expect(html).toContain("Add Vendor");
    expect(count(html, "Archive</button>")).toBe(2);
    expect(html).toContain("Show Archived Vendors (1)");
    expect(html).not.toContain("$700.00");
  });

  it("says the cost is the item number when it is", () => {
    expect(html).toMatch(/same as the item number \(830\)/);
  });
});

describe("the Vendors tab", () => {
  const vendors = summarizeVendors(options, [w830], [], 25);

  it("lists every vendor with how many items it's on and where it's the default", () => {
    const html = renderToStaticMarkup(
      createElement(VendorsManager, { vendors, items: [w830], optionsByItem: { i830: options }, knownVendors: [], defaultMarkupPct: 25, cardsAvailable: true }),
    );
    expect(html).toContain("Andersen");
    expect(html).toContain("On 1 item · default on 1");
    expect(html).toContain("Add Vendor");
    expect(html).not.toContain("arrive with the next update");
  });

  it("before 0296 the contact door is off and says why, rather than failing on save", () => {
    const html = renderToStaticMarkup(
      createElement(VendorsManager, { vendors, items: [w830], optionsByItem: { i830: options }, knownVendors: [], defaultMarkupPct: 25, cardsAvailable: false }),
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Add Vendor/);
    expect(html).toContain("arrive with the next update");
  });
});

describe("the Items list", () => {
  it("each item opens from its description, names its vendors, and flags a cost that is its code", () => {
    const html = renderToStaticMarkup(
      createElement(PriceListManager, { items: [w830], defaultMarkupPct: 25, optionsByItem: { i830: options }, knownVendors: [] }),
    );
    expect(html).toContain("2 Vendors · default Andersen 400 Series");
    expect(html).toContain("1 item costs exactly its item number");
    expect(html).toContain("= item #");
  });

  it("without the vendors table, the description is plain text (no door onto a database error)", () => {
    const html = renderToStaticMarkup(createElement(PriceListManager, { items: [w830], defaultMarkupPct: 25, optionsByItem: null }));
    expect(html).not.toContain("Open this item");
  });
});
