import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * TOOK FROM STOCK ON SCREEN (Shop Stock, Phase 3). One hand at 60 mph: pick the item (names and how
 * much is on the shelf, never a price), a number pad with the unit already there, one tap Take It.
 * A take bigger than the shelf still saves and says so. Under the button, the job's takes, with Undo
 * until an invoice bills one, and then "Take It Off INV-078 First". Every target 44px or more, every
 * button in Title Case, and no price anywhere, for anyone.
 */

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {} }), usePathname: () => "/jobs/j", useSearchParams: () => new URLSearchParams() }));
vi.mock("./stock-actions", () => ({ loadShelf: vi.fn(), takeFromStockAction: vi.fn(), undoTakeAction: vi.fn() }));

import { TakeSheetView, TakesListView, padPress } from "./took-from-stock";
import type { JobTake, ShelfRow } from "@/lib/stock-take";

// A row as it might arrive if a cost ever leaked into the payload: the view must not draw it.
const LEAKY = { cost: 180.17, value: 136.93, unit_cost: 0.72 };
const SHELF = [
  { id: "i1", name: "12/2 NM-B", unit: "ft", onHand: 250, takeable: 250, ...LEAKY },
  { id: "i2", name: "Twister 341-Tan wire nut", unit: "ea", onHand: 440, takeable: 440, ...LEAKY },
] as unknown as ShelfRow[];

const noop = () => {};
const sheet = (over: Partial<Parameters<typeof TakeSheetView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TakeSheetView, {
      step: { kind: "pick" },
      rows: SHELF,
      loading: false,
      error: null,
      search: "",
      entry: "",
      busy: false,
      onSearch: noop,
      onPick: noop,
      onKey: noop,
      onBack: noop,
      onTake: noop,
      ...over,
    }),
  );
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: textOf(m[0]) }));
const TARGET = /min-h-\[(44|52|56)px\]|\bh-11\b/;
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));

describe("the pick step", () => {
  const html = sheet();
  it("lists names and how much is on the shelf, and not one price", () => {
    const t = textOf(html);
    expect(t).toContain("12/2 NM-B");
    expect(t).toContain("250 ft on the shelf");
    expect(t).toContain("440 ea on the shelf");
    expect(t).not.toMatch(/\$|180\.17|136\.93|0\.72|cost|price/i);
  });
  it("every row is a 44px target, and the search box is too", () => {
    for (const b of buttons(html)) expect(b.markup, b.text).toMatch(TARGET);
    expect(html).toMatch(/<input[^>]*class="[^"]*h-11/);
  });
  it("says an empty shelf in words", () => {
    expect(textOf(sheet({ rows: [] }))).toContain("Nothing is on the shelf yet");
  });
});

describe("the number pad", () => {
  const row = SHELF[0];
  it("opens with the item's unit already there", () => {
    const html = sheet({ step: { kind: "count", row }, entry: "" });
    expect(html).toMatch(/data-testid="take-unit"[^>]*>ft</);
    expect(html).toMatch(/data-testid="take-count"[^>]*>0</);
    const typed = sheet({ step: { kind: "count", row }, entry: "60" });
    expect(typed).toMatch(/data-testid="take-count"[^>]*>60</);
    expect(textOf(typed)).not.toMatch(/\$|180\.17|cost|price/i);
  });
  it("a take bigger than the shelf shows says so, and Take It stays open", () => {
    const html = sheet({ step: { kind: "count", row: { ...row, onHand: 0, takeable: 0 } }, entry: "20" });
    expect(textOf(html)).toContain("20 ft more than the shelf shows — the office will recount.");
    const take = buttons(html).find((b) => b.text === "Take It")!;
    expect(take.markup).not.toMatch(/\sdisabled=""/);
    expect(sheet({ step: { kind: "count", row }, entry: "60" })).not.toContain("take-short");
  });
  it("warns from what a take can reach, not the bare count: a counted 100 ft with no roll behind it", () => {
    const html = sheet({ step: { kind: "count", row: { ...row, onHand: 100, takeable: 0 } }, entry: "40" });
    const t = textOf(html);
    expect(t).toContain("100 ft on the shelf");
    expect(t).toContain("40 ft of that isn't on a filed roll yet — it still saves, and the office settles it.");
    expect(t).not.toContain("more than the shelf shows");
  });
  it("Take It is shut until there is a count", () => {
    const take = buttons(sheet({ step: { kind: "count", row }, entry: "" })).find((b) => b.text === "Take It")!;
    expect(take.markup).toMatch(/\sdisabled=""/);
  });
  it("every key and button is a big target in Title Case", () => {
    const html = sheet({ step: { kind: "count", row }, entry: "6" });
    const bs = buttons(html);
    expect(bs.map((b) => b.text)).toEqual(expect.arrayContaining(["Pick Another Item", "1", "0", ".", "Take It"]));
    for (const b of bs) {
      expect(b.markup, b.text).toMatch(TARGET);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });
  it("types like a pad: one dot, three decimals, backspace", () => {
    expect(padPress("", "6")).toBe("6");
    expect(padPress("6", "0")).toBe("60");
    expect(padPress("0", "5")).toBe("5");
    expect(padPress("", ".")).toBe("0.");
    expect(padPress("1.5", ".")).toBe("1.5");
    expect(padPress("1.125", "5")).toBe("1.125");
    expect(padPress("60", "back")).toBe("6");
  });
});

describe("the job's takes", () => {
  const base: JobTake = {
    drawGroup: "g1",
    takenAt: "2026-09-24T17:00:00Z",
    itemId: "i1",
    item: "12/2 NM-B",
    unit: "ft",
    qty: 60,
    short: 0,
    back: 0,
    who: "Brian",
    mine: true,
    billedOn: null,
    partBilled: false,
    billedInvoiceId: null,
    canUndo: true,
  };
  const list = (takes: JobTake[], staff: boolean) =>
    renderToStaticMarkup(createElement(TakesListView, { takes, viewerIsStaff: staff, pendingGroup: null, onUndo: noop }));

  it("says who took what, with Undo while nothing bills it", () => {
    const html = list([base], false);
    expect(textOf(html)).toContain("Brian took 60 ft of 12/2 NM-B");
    const undo = buttons(html).find((b) => b.text === "Undo")!;
    expect(undo.markup).toMatch(TARGET);
  });

  it("once billed, the office gets Take It Off INV-078 First as the invoice's door; the crew a plain status", () => {
    const billed = { ...base, canUndo: false, billedOn: "INV-078", billedInvoiceId: "inv-1" };
    const crew = list([{ ...billed, billedInvoiceId: null }], false);
    expect(textOf(crew)).toContain("Billed on INV-078");
    // An instruction a tech can't follow (he can't open invoices) is never shown to him.
    expect(textOf(crew)).not.toContain("Take It Off");
    expect(crew).not.toContain("/billing/");
    expect(buttons(crew).map((b) => b.text)).not.toContain("Undo");
    const office = list([billed], true);
    expect(office).toMatch(/href="\/billing\/inv-1"[^>]*>Take It Off INV-078 First</);
    expect(office).toMatch(/min-h-\[44px\]/);
  });

  it("billed in part (its settled pieces on no invoice yet) says so to both, so it never reads billed where the Costs tab reads open", () => {
    const part = { ...base, canUndo: false, billedOn: "INV-078", billedInvoiceId: "inv-1", partBilled: true };
    expect(textOf(list([{ ...part, billedInvoiceId: null }], false))).toContain("Part billed on INV-078, the rest not billed yet");
    const office = list([part], true);
    expect(textOf(office)).toContain("Part billed on INV-078, the rest not billed yet");
    expect(office).toMatch(/href="\/billing\/inv-1"[^>]*>Take It Off INV-078 First</);
    // Wholly billed: no "Part" anywhere.
    expect(textOf(list([{ ...part, partBilled: false }], true))).not.toContain("Part billed");
  });

  it("a take past the shelf says it is waiting on a recount, never a price", () => {
    const t = textOf(list([{ ...base, qty: 20, short: 15 }], false));
    expect(t).toContain("15 ft past the shelf, waiting on the office");
    expect(t).not.toMatch(/\$/);
  });

  it("draws nothing when the job has no takes", () => {
    expect(list([], false)).toBe("");
  });
});
