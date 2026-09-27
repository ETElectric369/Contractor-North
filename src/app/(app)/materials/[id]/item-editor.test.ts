import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

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

import { ItemEditor, settleFlips } from "./item-editor";

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

  it("a tool's tick says Got, never Bought (a tool comes from the shop)", () => {
    for (const html of [office(), tech()]) {
      expect(html).toContain('aria-label="Got: Hole saw"');
      expect(html).toContain('aria-label="Bought: 12-2 Romex"');
      expect(html).not.toContain('aria-label="Bought: Hole saw"');
    }
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

describe("an optimistic tick never outlives the server's answer", () => {
  const F = (from: boolean, to: boolean) => ({ from, to });

  it("in flight (the server still says `from`): kept", () => {
    const m = new Map([["a", F(false, true)]]);
    expect(settleFlips(m, [{ id: "a", purchased: false }])).toBe(m);
  });

  it("settled (the server says `to`): dropped", () => {
    const m = new Map([["a", F(false, true)]]);
    expect(settleFlips(m, [{ id: "a", purchased: true }]).has("a")).toBe(false);
  });

  it("the traced bug: ticked, settled, then the office unticks it: the line is open again, not Bought", () => {
    let m: Map<string, { from: boolean; to: boolean }> = new Map([["a", F(false, true)]]);
    m = settleFlips(m, [{ id: "a", purchased: true }]); // Brian's tick lands
    m = settleFlips(m, [{ id: "a", purchased: false }]); // the office unticks it; a later refresh
    const f = m.get("a");
    const server = false;
    expect(f && f.from === server ? f.to : server).toBe(false);
  });

  it("a removed line, or a flip that changed nothing, leaves too; nothing settled keeps the same map", () => {
    const m = new Map([
      ["gone", F(false, true)],
      ["noop", F(true, true)],
      ["live", F(true, false)],
    ]);
    const out = settleFlips(m, [
      { id: "noop", purchased: true },
      { id: "live", purchased: true },
    ]);
    expect([...out.keys()]).toEqual(["live"]);
    const same = new Map([["live", F(true, false)]]);
    expect(settleFlips(same, [{ id: "live", purchased: true }])).toBe(same);
  });
});

describe("quick ticks at the counter", () => {
  it("a tick is not the card's shared transition: only the line still saving refuses a second tap", () => {
    const src = readFileSync(new URL("./item-editor.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/onChange=\{\(\) => toggleBought\(it\)\}\s*disabled=\{saving\.has\(it\.id\)\}/);
    const body = src.slice(src.indexOf("function toggleBought("), src.indexOf("function toggleTool("));
    expect(body).not.toContain("start(");
  });

  it("a tick that folds a line away says so with an Undo (it un-ticks that line); a refusal is a toast too", () => {
    const src = readFileSync(new URL("./item-editor.tsx", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function saveTick("), src.indexOf("function toggleTool("));
    expect(body).toMatch(/if \(next\) \{\s*toast\([^]*?"success",\s*\{\s*label: "Undo",\s*onClick: \(\) => saveTick\(lid, it, true, false\)/);
    expect(body).toMatch(/toast\(why, "error"\)/);
  });
});
