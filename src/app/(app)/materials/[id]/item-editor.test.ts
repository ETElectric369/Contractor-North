import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB'S MATERIALS LIST, AS IT RENDERS: A CHECKLIST (Erik, 2026-09-27). What's left to buy on
 * top, every checked line in one "Bought (N)" fold that starts closed, the same list for the office
 * and the crew, and never a price on the crew's screen.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../actions", () => ({
  addMaterialItem: vi.fn(),
  deleteMaterialItem: vi.fn(),
  updateMaterialItem: vi.fn(),
  setMaterialItemPurchased: vi.fn(),
  setMaterialItemTool: vi.fn(),
  ensureJobMaterialList: vi.fn(),
}));

import { ItemEditor } from "./item-editor";

const item = (id: string, description: string, over: Record<string, unknown> = {}) => ({
  id,
  description,
  part_number: null,
  quantity: 2,
  unit: "ea",
  vendor: "CED",
  est_cost: 12.5,
  purchased: false,
  is_tool: false,
  ...over,
});

const ITEMS = [
  item("1", "12-2 Romex"),
  item("2", "Hole saw", { is_tool: true }),
  item("3", "Old work boxes", { purchased: true }),
  item("4", "3 gang faceplate"),
  item("5", "Wire nuts", { purchased: true }),
];
// A tech's projection never selects vendor / est_cost (TECH_ITEM_COLUMNS).
const TECH_ITEMS = ITEMS.map(({ vendor: _v, est_cost: _c, ...rest }) => rest);

const office = (items: unknown[] = ITEMS) =>
  renderToStaticMarkup(createElement(ItemEditor, { listId: "l1", items, viewerIsStaff: true } as any));
const tech = (items: unknown[] = TECH_ITEMS) =>
  renderToStaticMarkup(createElement(ItemEditor, { listId: "l1", items, viewerIsStaff: false } as any));

describe("the checklist", () => {
  it("open lines on top (tools, then to buy), the checked ones folded under Bought (N), closed", () => {
    for (const html of [office(), tech()]) {
      const at = (s: string) => html.indexOf(s);
      expect(at("Hole saw")).toBeGreaterThan(-1);
      expect(at("Hole saw")).toBeLessThan(at("12-2 Romex"));
      expect(at("12-2 Romex")).toBeLessThan(at("3 gang faceplate"));
      expect(html).toMatch(/Bought \(<!-- -->2<!-- -->\)|Bought \(2\)/);
      // Closed by default: the count, not the rows.
      expect(html).not.toContain("Old work boxes");
      expect(html).not.toContain("Wire nuts");
      expect(html).toMatch(/aria-expanded="false"/);
    }
  });

  it("the footer says what's left to buy (tools are never 'to buy')", () => {
    expect(office()).toMatch(/2<!-- --> to buy|2 to buy/);
    expect(tech()).toMatch(/2<!-- --> to buy|2 to buy/);
  });

  it("everything bought: says so, and every line waits in the fold", () => {
    const all = ITEMS.map((i) => ({ ...i, purchased: true }));
    const html = office(all);
    expect(html).toContain("Everything on this list is bought.");
    expect(html).toMatch(/Bought \(<!-- -->5<!-- -->\)|Bought \(5\)/);
    expect(html).toContain("Nothing left to buy");
    expect(html).not.toContain("12-2 Romex");
  });

  it("nothing checked: no fold at all", () => {
    const html = office(ITEMS.map((i) => ({ ...i, purchased: false })));
    expect(html).not.toContain("Bought (");
  });

  it("an empty list says to add one", () => {
    expect(office([])).toContain("No items yet — add one above.");
  });
});

describe("the office and the crew see the same list; the crew never sees a price", () => {
  it("the office sees the money", () => {
    expect(office()).toMatch(/\$\s?25\.00/);
  });

  it("the crew's list has no dollar sign, no vendor, no tool toggle", () => {
    const html = tech();
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toContain('placeholder="Vendor"');
    expect(html).not.toContain("Mark As A Tool");
    for (const s of ["12-2 Romex", "3 gang faceplate", "Hole saw"]) expect(html).toContain(s);
  });
});

describe("44px targets", () => {
  it("every checkbox sits in an h-11 w-11 label; every button is 44px", () => {
    for (const html of [office(), tech()]) {
      const boxes = html.match(/<input[^>]*type="checkbox"/g) ?? [];
      const labels = html.match(/<label class="flex h-11 w-11/g) ?? [];
      expect(boxes.length).toBe(3); // the three open lines; the fold is closed
      expect(labels.length).toBe(boxes.length);
      for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b, b).toMatch(/h-11|min-h-\[44px\]/);
    }
  });
});
