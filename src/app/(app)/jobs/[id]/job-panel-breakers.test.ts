import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE BREAKERS CARD ON SCREEN (Panel plan, phase 3; ONE LINE since the panel-first wave), drawn from
 * J-011's night: CED 8802-SO-257555's lines as the crew's function returns them, the job's materials
 * list as it sits, and the final map.
 *
 * Everyone reads ONE line with one door each: "Short one 2P 20A (Bath Floor Heat) — Add To
 * Materials", "9 bought breakers not placed yet — Place Them", or "All breakers accounted for.". An
 * unreadable breaker and a circuit with no amps are said beside it, never guessed. The office (only
 * the office) has one Details tap behind it: the count by size, the tickets as read, which ticket
 * and what it cost, the price book, the quad swap with "Not Q22020CT2, That Is Two 2-Pole 20s", the
 * list and the shelf. Every button a 44px target in Title Case; every door wired.
 */

// Every Button's door, by its words, so a test can press the one a person would.
const doors = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/components/ui/button", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/button")>();
  const { createElement: h } = await import("react");
  const words = (k: unknown): string => (Array.isArray(k) ? k.map(words).join("") : typeof k === "string" ? k : "");
  return {
    ...real,
    Button: (p: { children?: unknown; onClick?: () => void }) => {
      if (p.onClick) doors.set(words(p.children).trim(), p.onClick);
      return h(real.Button, p as never);
    },
  };
});
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
import { groupBreakers, groupLabel, lineKey } from "@/lib/panel/breakers";
import { FINAL_MAP, PANEL, PHOTO_EXISTING, circuit } from "@/lib/panel/__fixtures__/honeysuckle";

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

const details = (html: string) => {
  const i = html.indexOf("<details");
  return i < 0 ? "" : html.slice(i, html.indexOf("</details>") + "</details>".length);
};
const outside = (html: string) => html.replace(details(html), "");

describe("the crew's Breakers card on J-011: one line, one door each", () => {
  const html = render(crewData);
  const t = textOf(html);

  it("says what's short with its one door, and what came that isn't placed yet with its one door", () => {
    expect(t).toContain("Short one 2P 20A (Bath Floor Heat) — Add To Materials");
    // 8 x Q2020 + 1 x Q21530CT came, and none of the night's new circuits has a space yet.
    expect(t).toContain("9 bought breakers not placed yet — Place Them");
    expect(t).not.toContain("All breakers accounted for.");
    expect(buttons(html).map((b) => b.text)).toEqual(["Add To Materials", "Place Them"]);
  });

  it("draws no Details for a tech: no count by size, no tickets as read, no swap, no list or shelf", () => {
    expect(html).not.toContain("<details");
    expect(t).not.toContain("Details");
    for (const office of ["Need 2 x", "8 x Q2020", "Q21530CT", "Or Swap One", "Not Q22020CT2", "On The List", "Spare", "Q220"]) {
      expect(t, office).not.toContain(office);
    }
  });

  it("carries no ticket number, supplier, cost or price book for a tech", () => {
    for (const secret of ["8802-SO-257555", "CED", "$", "Price Book"]) expect(t).not.toContain(secret);
  });

  it("every door is 44px and Title Case", () => {
    for (const b of buttons(html)) {
      expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]|h-12/);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });
});

describe("the office's Breakers card on J-011", () => {
  const html = render(officeData);
  const t = textOf(html);
  const d = textOf(details(html));

  it("says the same one line as the crew's, outside Details", () => {
    const line = textOf(outside(html));
    expect(line).toContain("Short one 2P 20A (Bath Floor Heat) — Add To Materials");
    expect(line).toContain("9 bought breakers not placed yet — Place Them");
    expect(line).not.toContain("$");
    expect(line).not.toContain("8802-SO-257555");
  });

  it("keeps everything else behind one Details tap: the count, the tickets, the cost, the book, the swap, the list", () => {
    expect(html).toMatch(/<summary[^>]*min-h-\[44px\][^>]*>[\s\S]*?Details<\/summary>/);
    expect(d).toContain("Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A.");
    expect(d).toContain("8 x Q2020 · Twin 1P 20A + 1P 20A");
    expect(d).toContain("1 x Q21530CT · Quad 1P 15A + 1P 15A + 2P 30A");
    expect(d).toContain("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
    expect(d).toContain("From 8802-SO-257555, CED · $23.11 Each");
    expect(d).toContain("Q220 Is $18.76 In Your Price Book.");
    expect(d).toContain("Q2020 Isn't In Your Price Book.");
    expect(d).toContain("Q22020CT Isn't In Your Price Book.");
    expect(d).toContain("Or Swap One Q2020 For A Q22020CT");
    expect(d).toContain("Not Q22020CT2, That Is Two 2-Pole 20s");
    expect(d).toContain("Only if a space takes a quad.");
    expect(d).toContain("On The List, Not Bought Yet");
    expect(d).toContain("8 came on a ticket already.");
    const labels = buttons(details(html)).map((b) => b.text);
    expect(labels).toContain("Add Q220 To Materials");
    expect(labels).toContain("Add Q22020CT To Materials");
    expect(labels.filter((l) => l === "Place")).toHaveLength(2);
    expect(labels.filter((l) => l === "Add To Price Book").length).toBeGreaterThanOrEqual(3);
  });

  it("is 44px and Title Case", () => {
    for (const b of buttons(html)) {
      expect(b.markup, b.text).toMatch(/h-11|min-h-\[44px\]|h-12/);
      expect(titleCase(b.text), b.text).toBe(true);
    }
    expect(t).toContain("Details");
  });
});

describe("the line's other sentences", () => {
  const PLACED = { panel_id: PANEL.id, work: "new" as const, state: "kept" as const, removed_at: null };
  const kitchen = (space: number | null, half: "A" | "B" | null, description: string) =>
    circuit({ room: "Kitchen", description, amps: 20, poles: 1, space, half, ...PLACED });
  const one = { ...crewData, bought: [{ description: "SIEM Q2020 SP 20/20A 120/240V CB", qty: 2 }], list: [] };

  it("All breakers accounted for. when nothing is short and every breaker that came is in a space, with no door", () => {
    const circuits = [kitchen(1, "A", "Outlets Right"), kitchen(1, "B", "Outlets Left"), kitchen(3, "A", "Disposal"), kitchen(3, "B", "Fridge")];
    const html = renderToStaticMarkup(createElement(BreakersCardView, { data: one, circuits, panel: PANEL, ...handlers }));
    expect(textOf(html)).toContain("All breakers accounted for.");
    expect(buttons(html)).toEqual([]);
  });

  it("2 bought breakers not placed yet — Place Them, when nothing is short", () => {
    const circuits = [kitchen(null, null, "Outlets Right"), kitchen(null, null, "Outlets Left"), kitchen(null, null, "Disposal"), kitchen(null, null, "Fridge")];
    const placed: string[] = [];
    const html = renderToStaticMarkup(
      createElement(BreakersCardView, { data: one, circuits, panel: PANEL, ...handlers, onPlace: (g: { codes: string[] }) => placed.push(g.codes[0]) }),
    );
    const t = textOf(html);
    expect(t).toContain("2 bought breakers not placed yet — Place Them");
    expect(t).not.toContain("Short");
    expect(t).not.toContain("All breakers accounted for.");
    expect(buttons(html).map((b) => b.text)).toEqual(["Place Them"]);
    // One of the two placed already: one left, and the door reads Place It.
    const half = [kitchen(1, "A", "Outlets Right"), kitchen(1, "B", "Outlets Left"), kitchen(null, null, "Disposal"), kitchen(null, null, "Fridge")];
    const t2 = textOf(renderToStaticMarkup(createElement(BreakersCardView, { data: one, circuits: half, panel: PANEL, ...handlers })));
    expect(t2).toContain("1 bought breaker not placed yet — Place It");
  });

  it("a shortfall already on the materials list says so and offers no second order", () => {
    const circuits = [circuit({ room: "Bath", description: "Floor Heat", amps: 20, poles: 2, ...PLACED })];
    const data = { ...crewData, bought: [], list: [{ description: "Q220 2P 20A breaker", part_number: "Q220", qty: 1, purchased: false }] };
    const html = renderToStaticMarkup(createElement(BreakersCardView, { data, circuits, panel: PANEL, ...handlers }));
    expect(textOf(html)).toContain("Short one 2P 20A (Bath Floor Heat) — it's on the materials list, not bought yet.");
    expect(buttons(html)).toEqual([]);
  });

  it("Add To Materials adds every order the shortfall needs, in one tap; Place Them opens the first breaker waiting", () => {
    const got: { part: string | null; qty: number }[][] = [];
    const circuits = [
      circuit({ room: "Bath", description: "Floor Heat", amps: 20, poles: 2, ...PLACED }),
      circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, ...PLACED }),
    ];
    doors.clear();
    const html = renderToStaticMarkup(
      createElement(BreakersCardView, { data: { ...crewData, bought: [], list: [] }, circuits, panel: PANEL, ...handlers, onAddAllToMaterials: (o) => got.push(o) }),
    );
    expect(textOf(html)).toContain("Short one 2P 20A (Bath Floor Heat) and one 2P 30A (Laundry Dryer) — Add To Materials");
    doors.get("Add To Materials")!();
    expect(got).toEqual([[expect.objectContaining({ part: "Q220", qty: 1 }), expect.objectContaining({ part: "Q230", qty: 1 })]]);

    const opened: string[] = [];
    doors.clear();
    renderToStaticMarkup(
      createElement(BreakersCardView, {
        data: one,
        circuits: [kitchen(null, null, "Outlets Right"), kitchen(null, null, "Outlets Left")],
        panel: PANEL,
        ...handlers,
        onPlace: (g) => opened.push(groupLabel(g)),
      }),
    );
    doors.get("Place It")!();
    expect(opened).toEqual(["Q2020 · Twin 1P 20A + 1P 20A"]);
  });
});

describe("the card's other states", () => {
  it("an unknown part is named on the line for everyone and counted as zero, never guessed; the office reads why", () => {
    const data = { ...crewData, bought: [...BOUGHT, { description: "SIEM Q22030CT", qty: 1 }] };
    const t = textOf(render(data));
    expect(t).toContain("Can't read SIEM Q22030CT (1) on a ticket, so it isn't counted.");
    expect(t).toContain("Short one 2P 20A (Bath Floor Heat) — Add To Materials");
    const d = textOf(details(render({ ...officeData, bought: data.bought })));
    expect(d).toContain("Can't Read This Breaker: SIEM Q22030CT (1). Can't Read Q22030CT. Confirm What Is Inside It.");
  });
  it("with no panel yet there is no Place, and the way to add one is said", () => {
    const html = renderToStaticMarkup(createElement(BreakersCardView, { data: crewData, circuits: all, panel: null, ...handlers }));
    expect(textOf(html)).toContain("9 bought breakers not placed yet — add a panel to place them.");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).not.toContain("Place Them");
    expect(labels).not.toContain("Place");
    // ONE name for the one door that makes a panel, the same as the tab's last door.
    expect(labels).toContain("Add New Panel");
    expect(labels).not.toContain("Add The Panel");
  });
  it("an unreadable ticket line keeps the card from saying all: it says what it counted", () => {
    const placed = [circuit({ room: "Kitchen", description: "A1", amps: 20, poles: 1, space: 1, half: "A" }), circuit({ room: "Kitchen", description: "B1", amps: 20, poles: 1, space: 1, half: "B" })];
    const html = renderToStaticMarkup(
      createElement(BreakersCardView, {
        data: { ...crewData, bought: [{ description: "SIEM Q2020", qty: 1 }, { description: "SIEM Q22030CT", qty: 1 }] },
        circuits: placed,
        panel: PANEL,
        ...handlers,
      }),
    );
    const t = textOf(html);
    expect(t).toContain("Counted what I could read — one ticket line is unreadable.");
    expect(t).not.toContain("All breakers accounted for.");
    expect(html).not.toContain('data-breaker-line="ok"');
  });
  it("with no kept new circuit (J-011 before Keep) there is no verdict and nothing is a spare", () => {
    const suggested = all.map((c) => ({ ...c, state: "suggested" as const }));
    const html = renderToStaticMarkup(createElement(BreakersCardView, { data: crewData, circuits: suggested, panel: null, ...handlers }));
    const t = textOf(html);
    expect(t).toMatch(/Nothing counted yet\. Keep the new circuits to count what they need: \d+ suggestions are waiting above\./);
    expect(t).not.toContain("No new breakers needed");
    expect(t).not.toContain("Spare");
    expect(t).not.toContain("not placed yet");
    expect(t).not.toContain("All breakers accounted for.");
    expect(html).not.toContain("bg-emerald-50");
    // What came is still listed, for the office, under Details.
    const office = renderToStaticMarkup(createElement(BreakersCardView, { data: officeData, circuits: suggested, panel: null, ...handlers }));
    expect(textOf(details(office))).toContain("8 x Q2020");
    expect(textOf(details(office))).not.toContain("Spare");
    const none = textOf(renderToStaticMarkup(createElement(BreakersCardView, { data: crewData, circuits: [], panel: null, ...handlers })));
    expect(none).toContain("Nothing counted yet. Add the new circuits to count what they need.");
  });
  it("a ticket credit nobody can read is named as a credit and not counted either way", () => {
    const t = textOf(render({ ...crewData, bought: [...BOUGHT, { description: "SP 20A 120/240V CB (Q120)", qty: 2, credit: true }] }));
    expect(t).toContain("A credit on a ticket for SP 20A 120/240V CB (Q120) (2) isn't counted either way.");
    expect(t).toContain("Short one 2P 20A (Bath Floor Heat) — Add To Materials");
  });
  it("a new circuit with no amps is said beside the line, never silently left out", () => {
    const t = textOf(render(crewData, PANEL));
    expect(t).not.toContain("no amps yet");
    const withHole = [...all, circuit({ room: "Bath", description: "Fan", amps: null, poles: 1 })];
    const t2 = textOf(renderToStaticMarkup(createElement(BreakersCardView, { data: crewData, circuits: withHole, panel: PANEL, ...handlers })));
    expect(t2).toContain("1 new circuit has no amps yet (Bath Fan), so it isn't counted.");
  });
  it("with no panel, the office's quad swap sends them to Add New Panel, not an Edit Panel that isn't there", () => {
    const d = textOf(details(renderToStaticMarkup(createElement(BreakersCardView, { data: officeData, circuits: all, panel: null, ...handlers }))));
    expect(d).toContain("add a panel and set its tandem spaces");
    expect(d).toContain("Add New Panel");
    expect(d).not.toContain("set them on Edit Panel");
  });
  it("before 0334 is on the database the card says so and gives no verdict", () => {
    const t = textOf(render({ ...crewData, ticketsReady: false, bought: [] }));
    expect(t).toContain("can't be read here yet");
    expect(t).not.toContain("Short");
    expect(t).not.toContain("All breakers accounted for.");
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
