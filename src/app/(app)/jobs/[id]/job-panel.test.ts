import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PANEL TAB ON SCREEN (Panel plan, phase 2), rendered from J-011's night as data.
 *
 * What it has to show: the office's suggestion bar ("E-017 Has 12 Circuits" + Bring Them In, never
 * for a tech); suggestions dimmed and named "From E-017", each with Keep / Change / Not This and a
 * Keep All; the list grouped by room with "20A · 1P · Kitchen Outlets Right" lines, a New/Existing
 * word and a progress chip; Add A Circuit; the Positions door with odd spaces left, even right, a
 * twin split A/B, a 2P on both its spaces and a grey No Stab.
 *
 * The 375px law, as far as markup can prove it: every button is a 44px target, nothing carries a
 * fixed width wider than the 343px a phone gives the content, and every button label is Title Case.
 */

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../panel-actions", () => ({
  addCircuit: vi.fn(),
  advanceProgress: vi.fn(),
  bringInEstimateCircuits: vi.fn(),
  dismissSuggestion: vi.fn(),
  keepSuggestions: vi.fn(),
  loadJobPanel: vi.fn(),
  markVerified: vi.fn(),
  saveCircuit: vi.fn(),
  savePanel: vi.fn(),
  takeOffCircuit: vi.fn(),
  undoTakeOff: vi.fn(),
  applyLabelCheck: vi.fn(),
  undoLabelCheck: vi.fn(),
  readPanelPhoto: vi.fn(),
  readPlanCircuits: vi.fn(),
}));

import { JobPanel, PanelDoor, type PanelData } from "./job-panel";
import { CircuitEditSheet } from "./circuit-edit-sheet";
import { freePanelName } from "./panel-setup-sheet";
import { quoteCircuitsToSuggestions } from "@/lib/panel/model";
import { E017, E017_ID, FINAL_MAP, J011, PANEL, circuit } from "@/lib/panel/__fixtures__/herringbone";
import type { JobCircuit } from "@/lib/types";

const suggestions: JobCircuit[] = quoteCircuitsToSuggestions({ id: E017_ID, quote_number: "E-017", circuits: E017 }).map((d, i) =>
  circuit({ ...d, id: `s${i}`, panel_id: null, state: "suggested", source: "estimate" }),
);

const data = (over: Partial<PanelData> = {}): PanelData => ({
  ok: true,
  staff: true,
  panels: [PANEL],
  circuits: FINAL_MAP,
  estimates: [
    { id: E017_ID, quote_number: "E-017", job_id: null, customer_id: "cust", address: "13897 Herringbone", count: 12, created_at: null, onJob: 0, fresh: 12, alsoFrom: null },
  ],
  photos: [],
  plans: [],
  walkthrough: null,
  people: {},
  ...over,
});

const render = (d: PanelData) => renderToStaticMarkup(createElement(JobPanel, { jobId: J011, initial: d }));

function buttons(html: string) {
  return [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({
    markup: m[0],
    text: m[0].replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").trim(),
  }));
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** Title Case: every word that starts with a letter starts with a capital, except the small words
 *  a title keeps lower-case only in the middle — and this app capitalises those too. */
function isTitleCase(label: string): boolean {
  return label
    .replace(/\(\d+\)/g, "")
    .split(/\s+/)
    .filter((w) => /^[a-z]/i.test(w))
    .every((w) => /^[A-Z]/.test(w));
}

/** The 375px law in markup: every button a 44px target; no fixed pixel width over 343px. */
function phoneSafe(html: string) {
  for (const b of buttons(html)) {
    expect(b.markup, `button "${b.text}" is not a 44px target`).toMatch(/h-11|min-h-\[44px\]|h-12/);
  }
  const widths = [...html.matchAll(/(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
  expect(widths.filter((w) => w > 343)).toEqual([]);
  expect(html).not.toMatch(/min-w-\[(?:[4-9]\d{2}|\d{4,})px\]/);
}

describe("the Panel tab for the office, with E-017 not yet brought in", () => {
  const html = render(data());
  const t = textOf(html);

  it("offers E-017 in one bar: E-017 Has 12 Circuits, Bring Them In", () => {
    expect(t).toContain("E-017 Has 12 Circuits");
    expect(buttons(html).map((b) => b.text)).toContain("Bring Them In");
  });

  it("lists the kept circuits by room, the plan's way", () => {
    expect(t).toContain("20A · 1P · Kitchen Outlets Right");
    expect(t).toContain("20A · 2P · Bath Floor Heat");
    expect(t).toContain("Door Says Entry Lights");
    for (const room of ["Bath", "Bedroom", "Kitchen", "Bar", "Living", "Office", "Laundry", "Stairs"]) expect(html).toContain(`${room} · `);
    // The chip on every kept circuit, and the words on it.
    expect(buttons(html).filter((b) => b.text === "Planned")).toHaveLength(FINAL_MAP.length);
    expect(t).toContain("Existing");
    expect(t).toContain("Reused");
  });

  it("has Add A Circuit, Edit Panel and Add Another Panel, and no Positions switch until a space is set", () => {
    expect(t).toContain("Add A Circuit");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Add Circuit");
    expect(labels).toContain("Edit Panel");
    expect(labels).not.toContain("Positions");
  });

  it("is phone-safe and Title Case", () => {
    phoneSafe(html);
    for (const b of buttons(html)) if (b.text) expect(isTitleCase(b.text), b.text).toBe(true);
  });
});

describe("after Bring In E-017: twelve dimmed suggestions", () => {
  const html = render(data({ circuits: [...FINAL_MAP, ...suggestions], estimates: [{ ...data().estimates[0], onJob: 12, fresh: 0 }] }));
  const t = textOf(html);

  it("names each one From E-017, with Keep / Change / Not This and a Keep All", () => {
    expect(t).toContain("Suggestions");
    expect(t).toContain("Nothing counts until you keep it.");
    expect(html.match(/From E-017/g)).toHaveLength(12);
    const labels = buttons(html).map((b) => b.text);
    expect(labels.filter((l) => l === "Keep")).toHaveLength(12);
    expect(labels.filter((l) => l === "Change")).toHaveLength(12);
    expect(labels.filter((l) => l === "Not This")).toHaveLength(12);
    expect(labels).toContain("Keep All (12)");
    // All twelve are on the job now, so the bar doesn't offer them again.
    expect(labels).not.toContain("Bring Them In");
    phoneSafe(html);
  });

  it("the suggestions don't count: the circuit count is still the kept ones", () => {
    expect(t).toContain(`Circuits · ${FINAL_MAP.length}`);
  });
});

describe("the same tab for a tech", () => {
  it("never carries the estimate bar (the estimates are never even loaded for him)", () => {
    const html = render(data({ staff: false, estimates: [] }));
    expect(textOf(html)).not.toContain("Bring Them In");
    expect(textOf(html)).toContain("Add A Circuit");
    phoneSafe(html);
  });
});

describe("a job with no panel yet", () => {
  it("says so, offers Add The Panel, and still takes circuits", () => {
    const html = render(data({ panels: [], circuits: [], estimates: [] }));
    const t = textOf(html);
    expect(t).toContain("No Panel Yet");
    expect(buttons(html).map((b) => b.text)).toContain("Add The Panel");
    expect(t).toContain("No circuits yet.");
    phoneSafe(html);
  });
});

describe("Positions: the door as it hangs", () => {
  const panel = { ...PANEL, spaces: 8, dead_spaces: [8], twin_spaces: [5, 7] };
  const placed = [
    circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, space: 1 }),
    circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, space: 2 }),
    circuit({ room: "Bath", description: "Lights", amps: 15, space: 5, half: "A" }),
    circuit({ room: "Bedroom", description: "Lights", amps: 15, space: 5, half: "B" }),
  ];
  const html = renderToStaticMarkup(createElement(PanelDoor, { panel, circuits: placed, onOpen: () => {} }));
  const t = textOf(html);

  it("odd down the left, even down the right; a twin split A/B; a 2P on both its spaces; No Stab grey", () => {
    const order = [...html.matchAll(/font-mono[^>]*>(\d+)</g)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(t).toContain("A · Bath Lights");
    expect(t).toContain("B · Bedroom Lights");
    expect(t).toContain("30A · 2P · With 4");
    expect(t).toContain("30A · 2P · With 2");
    expect(t).toContain("No Stab");
    expect(html).toMatch(/bg-slate-200[^"]*"[^>]*>\s*<span[^>]*>8</);
    phoneSafe(html);
  });

  it("flips when the numbers run bottom up", () => {
    const up = renderToStaticMarkup(createElement(PanelDoor, { panel: { ...panel, numbering: "bottom_up" }, circuits: placed, onOpen: () => {} }));
    expect([...up.matchAll(/font-mono[^>]*>(\d+)</g)].map((m) => Number(m[1]))).toEqual([7, 8, 5, 6, 3, 4, 1, 2]);
  });

  it("says a collision in plain words and never hides either circuit", () => {
    const clash = [...placed, circuit({ room: "Bar", description: "Bar", amps: 20, space: 1 })];
    const h = textOf(renderToStaticMarkup(createElement(PanelDoor, { panel, circuits: clash, onOpen: () => {} })));
    expect(h).toContain("Space 1 has Kitchen Outlets Right and Bar on it.");
  });
});

describe("the circuit sheet", () => {
  const noop = () => {};
  it("a kept circuit: every field, Take Off and Done, the label flag in plain words", () => {
    const html = renderToStaticMarkup(
      createElement(CircuitEditSheet, { circuit: FINAL_MAP[2], panels: [PANEL], people: {}, onSaved: noop, onClose: noop, onKeep: noop, onNotThis: noop, onTakeOff: noop }),
    );
    const t = textOf(html);
    for (const f of ["What It Feeds", "Door Label", "Room", "Amps", "Poles", "Type", "Wire", "Wire Tag", "Space", "Half", "Work", "Progress"]) expect(t).toContain(f);
    expect(t).toContain("The door says Entry Lights, but it feeds Kitchen And Living Lights.");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Take Off");
    expect(labels).toContain("Done");
    expect(labels).toContain("Verified On Site");
    for (const b of buttons(html).filter((x) => x.text && x.text !== "A" && x.text !== "B")) expect(isTitleCase(b.text), b.text).toBe(true);
  });

  it("a suggestion: Keep and Not This, what the estimate said, and its check", () => {
    const s = circuit({ ...suggestions[6], source_row: { ...suggestions[6].source_row!, check: "The estimate says 1P 15A, but Q120 is a 1P 20A." } });
    const html = renderToStaticMarkup(
      createElement(CircuitEditSheet, { circuit: s, panels: [PANEL], people: {}, onSaved: noop, onClose: noop, onKeep: noop, onNotThis: noop, onTakeOff: noop }),
    );
    const t = textOf(html);
    expect(t).toContain("A suggestion from E-017.");
    expect(t).toContain("The estimate said: Recessed cans + inserts");
    expect(t).toContain("The estimate says 1P 15A, but Q120 is a 1P 20A.");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Keep");
    expect(labels).toContain("Not This");
    expect(labels).not.toContain("Take Off");
  });
});

describe("a circuit listed before the panel was added", () => {
  const noop = () => {};
  it("can always be put on a panel: the sheet shows the Panel picker when it is on none, even with one panel", () => {
    const loose = circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, panel_id: null });
    const t = textOf(
      renderToStaticMarkup(
        createElement(CircuitEditSheet, { circuit: loose, panels: [PANEL], people: {}, onSaved: noop, onClose: noop, onKeep: noop, onNotThis: noop, onTakeOff: noop }),
      ),
    );
    expect(t).toContain("No Panel Yet");
    expect(t).toContain("Main Panel");
    // On the only panel, there is nothing to pick.
    const placed = textOf(
      renderToStaticMarkup(
        createElement(CircuitEditSheet, { circuit: FINAL_MAP[0], panels: [PANEL], people: {}, onSaved: noop, onClose: noop, onKeep: noop, onNotThis: noop, onTakeOff: noop }),
      ),
    );
    expect(placed).not.toContain("No Panel Yet");
  });

  it("once on the panel with a space, the Positions switch appears", () => {
    const placed = circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, space: 7 });
    const labels = buttons(render(data({ circuits: [placed], estimates: [] }))).map((b) => b.text);
    expect(labels).toContain("Positions");
  });
});

describe("Add Another Panel", () => {
  it("starts with a free name, never a second Main Panel", () => {
    expect(freePanelName([])).toBe("Main Panel");
    expect(freePanelName(["Main Panel"])).toBe("Sub Panel");
    expect(freePanelName(["main panel", "Sub Panel"])).toBe("Panel 2");
  });
});

describe("the office bar's words", () => {
  it("one circuit here is singular, and says where it came from", () => {
    const html = render(data({ estimates: [{ ...data().estimates[0], onJob: 1, fresh: 11, alsoFrom: null }] }));
    expect(textOf(html)).toContain("E-017 Has 12 Circuits. 1 Is Here");
  });
});

describe("phase 4: the readers and the label checks on the tab", () => {
  const PHOTO = { id: "ph1", name: "panel.jpg", created_at: "2026-09-25T08:00:00Z" };
  const PLAN = { id: "pl1", name: "Herringbone E-sheets.pdf", created_at: "2026-09-20T08:00:00Z", onCustomer: true };
  const fridge = FINAL_MAP.find((c) => c.description === "Fridge")!;
  const check = circuit({
    room: fridge.room,
    description: fridge.description,
    id: "chk",
    state: "suggested",
    source: "photo",
    amps: 20,
    source_row: { key: "photo-flag:x", flag_for: fridge.id, check: "Panel Says Mini Fridge, Your List Says Fridge.", use: { panel_label: "Mini Fridge" }, was: { panel_label: null } },
  });
  const garage = circuit({ room: "Garage", description: null, panel_label: "Garage", amps: 20, id: "g1", state: "suggested", source: "photo", space: 1, work: "existing", source_row: { key: "photo:g" } });

  it("the crew reads the panel photo (the cap and the cost said before the tap), and never sees the plans door", () => {
    const html = render(data({ staff: false, estimates: [], photos: [PHOTO], plans: [PLAN] }));
    const t = textOf(html);
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Read The Panel Photo");
    expect(t).toContain("Up to 3 reads a day on this job, a few cents each.");
    expect(labels).not.toContain("Read Circuits From The Plans");
    expect(t).not.toContain("Herringbone E-sheets.pdf");
    phoneSafe(html);
  });

  it("the office reads circuits from the plans, the customer's kept plans among them", () => {
    const html = render(data({ photos: [PHOTO], plans: [PLAN] }));
    expect(buttons(html).map((b) => b.text)).toContain("Read Circuits From The Plans");
    expect(textOf(html)).toContain("Herringbone E-sheets.pdf");
    expect(textOf(html)).toContain("On The Customer");
  });

  it("with no photo yet, it says where to take one instead of a dead button", () => {
    const html = render(data({ staff: false, estimates: [], photos: [] }));
    expect(buttons(html).map((b) => b.text)).not.toContain("Read The Panel Photo");
    expect(textOf(html)).toContain("Take a photo of the panel door on the Photos tab first");
  });

  it("a label check names the kept circuit, says what differs, and offers Use It / Open It / Not This, never Keep; Keep All leaves it out", () => {
    const html = render(data({ circuits: [...FINAL_MAP, check, garage], estimates: [] }));
    const t = textOf(html);
    expect(t).toContain("Label Check: Kitchen Fridge");
    expect(t).toContain("Panel Says Mini Fridge, Your List Says Fridge.");
    expect(html.match(/From The Panel Photo/g)).toHaveLength(2);
    const labels = buttons(html).map((b) => b.text);
    expect(labels.filter((l) => l === "Use It")).toHaveLength(1);
    expect(labels.filter((l) => l === "Open It")).toHaveLength(1);
    expect(labels.filter((l) => l === "Keep")).toHaveLength(1); // the garage circuit only
    expect(labels.filter((l) => l === "Not This")).toHaveLength(2);
    expect(labels).not.toContain("Keep All (2)");
    expect(t).toContain("Space 1");
    phoneSafe(html);
    for (const b of buttons(html)) if (b.text) expect(isTitleCase(b.text), b.text).toBe(true);
  });

  it("the walk-through's panel answer is a suggestion with its own Use, and goes away once the panel says the same", () => {
    const walk = { said: { brand: "Siemens", main_amps: 200 }, words: "Siemens, 200A, two slots open" };
    const html = render(data({ walkthrough: walk, estimates: [] }));
    const t = textOf(html);
    expect(t).toContain("About The Panel");
    expect(t).toContain("The walk-through said: “Siemens, 200A, two slots open”");
    expect(t).toContain("Main: 200A (Yours Says 125A)");
    expect(t).not.toContain("Brand: Siemens"); // the panel already says Siemens
    expect(buttons(html).map((b) => b.text)).toContain("Use");
    const same = render(data({ walkthrough: walk, estimates: [], panels: [{ ...PANEL, main_amps: 200 }] }));
    expect(textOf(same)).not.toContain("About The Panel");
  });
});
