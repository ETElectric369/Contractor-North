import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  /**
   * THE VENDOR IS A VISIBLE PICKER (b0a8f25e): a select that lists every vendor the org has,
   * subcontractors included (Erik 2026-09-30), not a text box over a datalist that pops only after
   * matching letters.
   */
  it("Add Vendor's Vendor box is a select that lists the vendors, with Someone New (Type It) at the end", () => {
    expect(html).toContain("Pick One Of Your Vendors");
    expect(html).toContain('<option value="Andersen">Andersen</option>');
    expect(html).toContain('<option value="Pella">Pella</option>');
    // Milgard is already on the item (no label), so it is not offered twice.
    expect(html).not.toContain('<option value="Milgard">Milgard</option>');
    expect(html).toContain("Someone New (Type It)");
    // The text box waits behind Someone New; nothing is typed until it is picked.
    expect(html).not.toContain('placeholder="the brand, e.g. Andersen"');
    // Nothing is left out for its Kind any more, so nothing says so.
    expect(html).not.toContain("are subcontractors");
    expect(html).not.toContain("No vendors yet");
  });

  it("a subcontractor is offered in the picker like any other vendor, with nothing said about being left out", () => {
    const withSub = renderToStaticMarkup(
      createElement(ItemSheet, {
        item: w830,
        options,
        defaultMarkupPct: 25,
        knownVendors: ["Andersen", "Coldwater Drywall", "Pella"],
        onClose: () => {},
      }),
    );
    expect(withSub).toContain('<option value="Coldwater Drywall">Coldwater Drywall</option>');
    expect(withSub).not.toContain("are subcontractors");
    expect(withSub).not.toContain("isn&#x27;t offered here");
    expect(withSub).not.toContain("Change a vendor&#x27;s Kind");
  });

  it("when every vendor he has is already on this item, it says so (never 'No vendors yet') and the box is open", () => {
    // A one-supplier org (CED on every item) opening an item CED already prices: the filtered list
    // is empty because the vendor is on the item, not because the Vendors tab is.
    const milgardOnly = options.filter((o) => o.vendor === "Milgard");
    const one = renderToStaticMarkup(
      createElement(ItemSheet, { item: w830, options: milgardOnly, defaultMarkupPct: 25, knownVendors: ["Milgard"], onClose: () => {} }),
    );
    expect(one).toContain("Your one vendor is already on this item. Type a new one here.");
    expect(one).not.toContain("No vendors yet");
    expect(one).not.toContain('<option value="Milgard">Milgard</option>');
    expect(one).toContain('placeholder="the brand, e.g. Andersen"');
    // Two vendors, both priced on the item with no product line.
    const both: ItemOption[] = [
      { ...milgardOnly[0], id: "m2", vendor: "Andersen" },
      { ...milgardOnly[0], id: "p2", vendor: "Pella" },
    ];
    const two = renderToStaticMarkup(
      createElement(ItemSheet, { item: w830, options: both, defaultMarkupPct: 25, knownVendors: ["Andersen", "Pella"], onClose: () => {} }),
    );
    expect(two).toContain("Every vendor you have (2) is already on this item. Type a new one here.");
    expect(two).not.toContain("No vendors yet");
    expect(two).toContain('placeholder="the brand, e.g. Andersen"');
  });

  it("after the last pickable vendor is added, the box is open even though the sheet remembers a pick", () => {
    // The add() reset is computed from what the list will be next: a picked vendor leaves it.
    const SRC = readFileSync(join(process.cwd(), "src/app/(app)/price-list/add-vendor-price.tsx"), "utf8");
    expect(SRC).toContain("const left = knownVendors.length - (typing ? 0 : 1);");
    expect(SRC).toContain('setPick(left > 0 ? "" : SOMEONE_NEW);');
    // And the box is derived from the list, not from the remembered pick, so a list that shrinks to
    // nothing under a mounted sheet opens it.
    expect(SRC).toContain("const pickShown = nonePickable ? SOMEONE_NEW : pick;");
    expect(SRC).toContain("const typing = !vendor && pickShown === SOMEONE_NEW;");
    const SHEET = readFileSync(join(process.cwd(), "src/app/(app)/price-list/item-sheet.tsx"), "utf8");
    expect(SHEET).toContain("alreadyOnItem={knownVendors.length - pickable.length}");
  });

  it("with no vendors at all, the text box is open from the start and the sheet says where vendors come from", () => {
    const none = renderToStaticMarkup(createElement(ItemSheet, { item: w830, options: [], defaultMarkupPct: 25, knownVendors: [], onClose: () => {} }));
    expect(none).toContain("No vendors yet. Add them on the Vendors tab or type one here.");
    expect(none).toContain('placeholder="the brand, e.g. Andersen"');
    expect(none).toContain("Someone New (Type It)");
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

  // Kits & Sizing off (0352): the row checkboxes exist only to build a kit, so they go with Add to
  // Kit; the item itself, its price and its Kits column stay. On (or no prop): exactly as before.
  it("Kits off: no row checkboxes to build a kit with; the item and its price stay", () => {
    const on = renderToStaticMarkup(createElement(PriceListManager, { items: [w830], defaultMarkupPct: 25, optionsByItem: null }));
    expect(on).toContain('aria-label="Select all shown"');
    expect(on).toContain('aria-label="Select Windows (Materials) (Allowance)"');
    const off = renderToStaticMarkup(createElement(PriceListManager, { items: [w830], defaultMarkupPct: 25, optionsByItem: null, kitDoors: false }));
    expect(off).not.toContain('type="checkbox"');
    expect(off).toContain("Windows (Materials) (Allowance)");
    expect(off).toContain(">Kits<");
  });
});
