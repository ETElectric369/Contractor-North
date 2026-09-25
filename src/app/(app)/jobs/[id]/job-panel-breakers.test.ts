import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE BREAKERS CARD ON SCREEN (Panel plan, phase 3), drawn from J-011's night: CED 8802-SO-257555's
 * lines as the crew's function returns them, the job's materials list as it sits, and the final map.
 *
 * It has to say "Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.", offer Add Q220 To
 * Materials and the quad swap with "Not Q22020CT2, That Is Two 2-Pole 20s", name an unreadable
 * breaker instead of guessing it, and show the office (only the office) the ticket, the cost and
 * the price book. Every button a 44px target in Title Case; every button wired to a door.
 */

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../panel-actions", () => ({
  addBreakerToMaterials: vi.fn(),
  addBreakerToPriceBook: vi.fn(),
  loadPanelBreakers: vi.fn(),
  placeBoughtBreaker: vi.fn(),
  removeBreakerFromMaterials: vi.fn(),
  saveCircuit: vi.fn(),
  takeBreakerOutOfPriceBook: vi.fn(),
  takeOffCircuit: vi.fn(),
}));

import { BreakersCardView, type BreakersData } from "./job-panel-breakers";
import { PlaceBreakerSheet } from "./place-breaker-sheet";
import { groupBreakers } from "@/lib/panel/breakers";
import { lineKey } from "@/lib/panel/breakers";
import { FINAL_MAP, PANEL, PHOTO_EXISTING } from "@/lib/panel/__fixtures__/herringbone";

const all = [...FINAL_MAP, ...PHOTO_EXISTING];
const BOUGHT = [
  { description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 8 },
  { description: "SIEM Q21530CT", qty: 1 },
];
const LIST = [
  { description: "20a twin breaker", part_number: null, qty: 8, purchased: false },
  { description: "Quad 2p - 30a - 1p-15s breaker", part_number: null, qty: 1, purchased: false },
];
const crewData: BreakersData = { ok: true, staff: false, ticketsReady: true, bought: BOUGHT, list: LIST, listId: "list-1", shelf: [], office: null };
const officeData: BreakersData = {
  ...crewData,
  staff: true,
  office: {
    tickets: [
      { key: lineKey(BOUGHT[0].description), description: BOUGHT[0].description, qty: 8, bill_number: "8802-SO-257555", supplier: "CED", bill_date: "2026-09-24", each: 23.11 },
      { key: lineKey(BOUGHT[1].description), description: BOUGHT[1].description, qty: 1, bill_number: "8802-SO-257555", supplier: "CED", bill_date: "2026-09-24", each: 58.79 },
    ],
    prices: [
      { id: "p1", code: "Q120", buy_price: 9.56 },
      { id: "p2", code: "Q220", buy_price: 18.76 },
      { id: "p3", code: "Q230", buy_price: 20.96 },
    ],
  },
};

const handlers = { onAddToMaterials: () => {}, onPlace: () => {}, onAddPanel: () => {}, onPriceForm: () => {}, onAddToBook: () => {} };
const render = (data: BreakersData, panel = PANEL) => renderToStaticMarkup(createElement(BreakersCardView, { data, circuits: all, panel, ...handlers }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: m[0].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim() }));
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));

describe("the crew's Breakers card on J-011", () => {
  const html = render(crewData);
  const t = textOf(html);

  it("says the count and the verdict in the night's words", () => {
    expect(t).toContain("Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A.");
    expect(t).toContain("8 x Q2020 · Twin 1P 20A + 1P 20A");
    expect(t).toContain("1 x Q21530CT · Quad 1P 15A + 1P 15A + 2P 30A");
    expect(t).toContain("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
  });

  it("offers Add Q220 To Materials and the quad swap with the CT2 warning", () => {
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Add Q220 To Materials");
    expect(labels).toContain("Add Q22020CT To Materials");
    expect(t).toContain("Or Swap One Q2020 For A Q22020CT");
    expect(t).toContain("Not Q22020CT2, That Is Two 2-Pole 20s");
    expect(t).toContain("Only if a space takes a quad.");
  });

  it("shows the list's unticked twins and quad without counting them twice", () => {
    expect(t).toContain("On The List, Not Bought Yet");
    expect(t).toContain("8 came on a ticket already.");
  });

  it("carries no ticket number, supplier, cost or price book for a tech", () => {
    for (const secret of ["8802-SO-257555", "CED", "$", "Price Book"]) expect(t).not.toContain(secret);
  });

  it("has a Place door on each breaker that came, 44px and Title Case", () => {
    const labels = buttons(html).map((b) => b.text);
    expect(labels.filter((l) => l === "Place")).toHaveLength(2);
    for (const b of buttons(html)) {
      expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]|h-12/);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });
});

describe("the office's Breakers card on J-011", () => {
  const html = render(officeData);
  const t = textOf(html);
  it("adds the ticket, the cost and the book", () => {
    expect(t).toContain("From 8802-SO-257555, CED · $23.11 Each");
    expect(t).toContain("Q220 Is $18.76 In Your Price Book.");
    expect(t).toContain("Q2020 Isn't In Your Price Book.");
    expect(t).toContain("Q22020CT Isn't In Your Price Book.");
    expect(buttons(html).filter((b) => b.text === "Add To Price Book").length).toBeGreaterThanOrEqual(3);
    expect(t).toContain("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
  });
  it("is 44px and Title Case", () => {
    for (const b of buttons(html)) {
      expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]|h-12/);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });
});

describe("the card's other states", () => {
  it("an unknown part is named and counted as zero, never guessed", () => {
    const t = textOf(render({ ...crewData, bought: [...BOUGHT, { description: "SIEM Q22030CT", qty: 1 }] }));
    expect(t).toContain("Can't Read This Breaker: SIEM Q22030CT (1). Can't Read Q22030CT. Confirm What Is Inside It. It isn't counted.");
    expect(t).toContain("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
  });
  it("with no panel yet there is no Place, and the way to add one is said", () => {
    const html = renderToStaticMarkup(createElement(BreakersCardView, { data: crewData, circuits: all, panel: null, ...handlers }));
    const labels = buttons(html).map((b) => b.text);
    expect(labels).not.toContain("Place");
    expect(labels).toContain("Add The Panel");
  });
  it("before 0334 is on the database the card says so and gives no verdict", () => {
    const t = textOf(render({ ...crewData, ticketsReady: false, bought: [] }));
    expect(t).toContain("can't be read here yet");
    expect(t).not.toContain("Short");
  });
});

describe("Place From What Was Bought", () => {
  it("pre-fills a Q2020's two halves with the first unplaced 1P 20A circuits, for a person to confirm", () => {
    const q2020 = groupBreakers(BOUGHT).groups.find((g) => g.codes.includes("Q2020"))!;
    const html = renderToStaticMarkup(
      createElement(PlaceBreakerSheet, { jobId: "j", panel: PANEL, group: q2020, circuits: all, onPlaced: () => {}, onClose: () => {} }),
    );
    const t = textOf(html);
    expect(t).toContain("Place Q2020");
    expect(t).toContain("Top Half · 1P 20A");
    expect(t).toContain("Bottom Half · 1P 20A");
    // The first two 1P 20A circuits on the list, new work first: Kitchen Outlets Right and Left.
    expect(html).toMatch(/<option value="c4" selected="">Kitchen Outlets Right · New<\/option>/);
    expect(html).toMatch(/<option value="c5" selected="">Kitchen Outlets Left · New<\/option>/);
    expect(t).toContain("A New Circuit");
    expect(t).toContain("Place These Two");
  });
});
