import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PANEL TAB ON SCREEN (Panel plan, phase 2; the panel-first wave), rendered from J-011's night
 * as data.
 *
 * What it has to show, top to bottom: the office's suggestion bar ("E-017 Has 12 Circuits" + Bring
 * Them In, never for a tech); the panel BY ITS NAME with its circuit count ("Main Panel · 22
 * circuits", never a word about having no panel: a job with no panel shows Panel 1 waiting); the readers; the
 * suggestions the door can't draw, dimmed and named "From E-017", each with Keep / Change / Not This,
 * and one Keep All above the door; THE DOOR (panel-visual.test.tsx pins its drawing); the list under
 * it, By Area by default, with "20A · 1P · Kitchen Outlets Right" lines, a New/Existing word and a
 * progress chip; Add A Circuit; and Add New Panel LAST. No List / Positions switch any more.
 *
 * The 375px law, as far as markup can prove it: every button is a 44px target (a tandem's half line
 * on the door is half a 44px space by the door's own scale, and says so with data-half-line), nothing
 * carries a fixed width wider than the 343px a phone gives the content, and every label is Title Case.
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
  useSuggestedWords: vi.fn(),
}));

import { JobPanel, adoptRows, carryQuick, circuitCountWords, listGroups, NO_AMPS, NO_SPACE, type PanelData } from "./job-panel";
import { CircuitEditSheet } from "./circuit-edit-sheet";
import { freePanelName } from "./panel-setup-sheet";
import { quoteCircuitsToSuggestions } from "@/lib/panel/model";
import { E017, E017_ID, FINAL_MAP, J011, PANEL, circuit } from "@/lib/panel/__fixtures__/honeysuckle";
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
    { id: E017_ID, quote_number: "E-017", job_id: null, customer_id: "cust", address: "13897 Honeysuckle", count: 12, created_at: null, onJob: 0, fresh: 12, alsoFrom: null },
  ],
  photos: [],
  orgId: "org",
  photoReadsLeft: null,
  planReadsLeft: null,
  plans: [],
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

/** The 375px law in markup: every button a 44px target; no fixed pixel width over 343px. A tandem's
 *  half line on the door is the one exception, by the door's own scale (a whole space is 44px and a
 *  tandem's two handles share it): it says so with data-half-line, and panel-visual.test.tsx pins
 *  that it is exactly half a space. */
function phoneSafe(html: string) {
  for (const b of buttons(html)) {
    if (/data-half-line/.test(b.markup)) continue;
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

  it("names the panel with its count, then the door, the list and Add A Circuit, and Add New Panel last; no List / Positions switch", () => {
    // The heading: the panel's name and how many circuits are on it, in words.
    expect(t).toContain(`Main Panel ${FINAL_MAP.length} circuits`);
    expect(circuitCountWords(FINAL_MAP.length)).toBe("22 circuits");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Edit Panel");
    expect(labels).toContain("Add Circuit");
    expect(labels).not.toContain("Positions");
    expect(labels).not.toContain("List");
    expect(labels).not.toContain("Add Another Panel");
    expect(labels).not.toContain("Add The Panel");
    // The order down the tab: heading → the door (its main breaker on top) → the list → Add A Circuit → Add New Panel.
    const at = (s: string) => t.indexOf(s);
    expect(at("22 circuits")).toBeGreaterThan(-1);
    expect(at("22 circuits")).toBeLessThan(at("125A Main"));
    expect(at("125A Main")).toBeLessThan(at("By Area"));
    expect(at("By Area")).toBeLessThan(at("Add A Circuit"));
    expect(at("Add A Circuit")).toBeLessThan(at("Add New Panel"));
    expect(labels[labels.length - 1]).toBe("Add New Panel");
    // The list's sort: By Space · By Area · By Size, By Area first on.
    expect(html).toMatch(/aria-selected="true"[^>]*>By Area</);
    expect(labels).toEqual(expect.arrayContaining(["By Space", "By Area", "By Size"]));
  });

  it("is phone-safe and Title Case", () => {
    phoneSafe(html);
    for (const b of buttons(html)) if (b.text) expect(isTitleCase(b.text), b.text).toBe(true);
  });
});

describe("after Bring In E-017: twelve dimmed suggestions", () => {
  const html = render(data({ circuits: [...FINAL_MAP, ...suggestions], estimates: [{ ...data().estimates[0], onJob: 12, fresh: 0 }] }));
  const t = textOf(html);

  it("names each one From E-017 in the list under the door (they have no space yet), with Keep / Change / Not This and a Keep All", () => {
    expect(t).toContain("12 suggested, dimmed below. Nothing counts until you keep it.");
    // In the list, among their area's circuits: after the door, never above it.
    expect(t.indexOf("From E-017")).toBeGreaterThan(t.indexOf("By Area"));
    expect(html.match(/data-suggested=""/g)).toHaveLength(12);
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
    expect(t).toContain(`Main Panel ${FINAL_MAP.length} circuits`);
  });

  it("Keep All sits above the door", () => {
    expect(t.indexOf("Keep All (12)")).toBeLessThan(t.indexOf("125A Main"));
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
  it("never says it has no panel: Panel 1 waits on the door, 24 open spaces to tap, and Add New Panel is the last door", () => {
    const html = render(data({ panels: [], circuits: [], estimates: [] }));
    const t = textOf(html);
    expect(t).not.toContain(["No", "Panel", "Yet"].join(" "));
    expect(t).toContain("Panel 1 No circuits yet");
    expect(t).toContain("Tap an open space on the door to add the first circuit there.");
    expect(t).toContain("24 Spaces");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).not.toContain("Add The Panel");
    // Edit Panel belongs to a panel that exists: the first circuit makes Panel 1.
    expect(labels).not.toContain("Edit Panel");
    expect(html.match(/is open\. Tap to fill it\./g)).toHaveLength(24);
    expect(labels[labels.length - 1]).toBe("Add New Panel");
    phoneSafe(html);
  });
});

describe("the door on the tab (panel-visual.test.tsx pins the drawing)", () => {
  const panel = { ...PANEL, spaces: 8, dead_spaces: [8], twin_spaces: [5, 7] };
  const placed = [
    circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, space: 1 }),
    circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, space: 2 }),
    circuit({ room: "Bath", description: "Lights", amps: 15, space: 5, half: "A" }),
    circuit({ room: "Bedroom", description: "Lights", amps: 15, space: 5, half: "B" }),
  ];
  const html = render(data({ panels: [panel], circuits: placed, estimates: [] }));
  const t = textOf(html);

  it("draws each kept circuit at its space, a 2-pole's words on both its lines, No Stab hatched, and the collision said under it", () => {
    expect(t).toContain("Outlets Right · 20");
    expect(t.match(/Dryer · 30/g)).toHaveLength(2);
    expect(html).toContain('data-line="dead"');
    const clash = textOf(render(data({ panels: [panel], circuits: [...placed, circuit({ room: "Bar", description: "Bar", amps: 20, space: 1 })], estimates: [] })));
    expect(clash).toContain("Space 1 has Kitchen Outlets Right and Bar on it.");
    phoneSafe(html);
    for (const b of buttons(html)) if (b.text) expect(isTitleCase(b.text), b.text).toBe(true);
  });
});

describe("the list under the door: By Space, By Area, By Size", () => {
  const a = circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, space: 9 });
  const b = circuit({ room: "Kitchen", description: "Fridge", amps: 20, space: 3, half: "B" });
  const c = circuit({ room: "Kitchen", description: "Disposal", amps: 20, space: 3, half: "A" });
  const d = circuit({ room: null, description: "Mystery", amps: null });
  const kept = [a, b, c, d];

  it("By Area: the rooms as they first appear, the unroomed last", () => {
    expect(listGroups(kept, "area").map((g) => [g.title, g.circuits.map((x) => x.description)])).toEqual([
      ["Laundry", ["Dryer"]],
      ["Kitchen", ["Fridge", "Disposal"]],
      ["No Room Yet", ["Mystery"]],
    ]);
  });

  it("By Space: in space order, A before B, the unplaced last", () => {
    expect(listGroups(kept, "space", [PANEL]).map((g) => [g.title, g.circuits.map((x) => x.description)])).toEqual([
      ["Main Panel", ["Disposal", "Fridge", "Dryer"]],
      [NO_SPACE, ["Mystery"]],
    ]);
  });

  it("By Size: 1-poles before 2-poles, small amps first, the unsized last; every circuit once", () => {
    const g = listGroups(kept, "size");
    expect(g.map((x) => x.title)).toEqual(["1P 20A", "2P 30A", NO_AMPS]);
    expect(g.flatMap((x) => x.circuits)).toHaveLength(kept.length);
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
  const sheet = (c: JobCircuit, panels: (typeof PANEL)[]) =>
    renderToStaticMarkup(createElement(CircuitEditSheet, { circuit: c, panels, people: {}, onSaved: noop, onClose: noop, onKeep: noop, onNotThis: noop, onTakeOff: noop }));
  const loose = circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, panel_id: null });

  it("with ONE live panel the circuit is on it — loose or not — said in one line, never a picker that could take it off the door", () => {
    for (const c of [loose, FINAL_MAP[0]]) {
      const html = sheet(c, [PANEL]);
      expect(textOf(html)).toContain("On Main Panel.");
      expect(html).not.toMatch(/<option[^>]*>Main Panel<\/option>/);
    }
  });

  it("with SEVERAL the picker lists the panels only: nothing in it detaches a circuit the door draws", () => {
    const sub = { ...PANEL, id: "sub-panel", name: "Sub Panel" };
    const html = sheet(FINAL_MAP[0], [PANEL, sub]);
    const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
    expect(options).toEqual(expect.arrayContaining(["Main Panel", "Sub Panel"]));
    expect(options).not.toContain("Pick The Panel");
    // A loose one with several panels: a disabled prompt to pick, never a choice to leave it off.
    const pick = sheet(loose, [PANEL, sub]);
    const panelSelect = pick.split("<select").find((s) => s.includes("Sub Panel"))!.split("</select>")[0];
    expect(panelSelect).toMatch(/<option value="" disabled=""[^>]*>Pick The Panel<\/option>/);
    expect([...panelSelect.matchAll(/<option value=""(?![^>]*disabled)/g)]).toHaveLength(0);
  });

  it("the old 'no panel' words are gone from the app: the phrase exists nowhere in src/", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const phrase = ["No", "Panel", "Yet"].join(" ");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(name) && readFileSync(p, "utf8").includes(phrase)) hits.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });

  it("after a write that adopted loose circuits, the tab's rows carry the panel id the server gave them", () => {
    const loose = circuit({ id: "loose-1", room: "Kitchen", description: "Outlets Right", amps: 20, panel_id: null, space: 7 });
    const other = circuit({ id: "other", room: "Bath", description: "Fan", amps: 15, panel_id: null });
    const rows = adoptRows([loose, other, FINAL_MAP[0]], ["loose-1"], PANEL.id);
    expect(rows.find((c) => c.id === "loose-1")!.panel_id).toBe(PANEL.id);
    // Only the ones the server moved; nothing else changes (and a row already on a panel stays put).
    expect(rows.find((c) => c.id === "other")!.panel_id).toBeNull();
    expect(adoptRows([FINAL_MAP[0]], [FINAL_MAP[0].id], "another-panel")[0].panel_id).toBe(FINAL_MAP[0].panel_id);
    expect(adoptRows([loose], undefined, PANEL.id)).toEqual([loose]);
  });

  it("the heading counts what THIS panel's door draws: never a circuit left on a panel that was taken off", () => {
    const left = circuit({ room: "Kitchen", description: "Left Behind", amps: 20, panel_id: "removed-panel", space: 9 });
    const t = textOf(render(data({ circuits: [...FINAL_MAP, left], estimates: [] })));
    expect(t).toContain(`Main Panel ${FINAL_MAP.length} circuits`);
    expect(t).not.toContain("Left Behind · 20");
  });

  it("once on the panel with a space, it is on the door at that space (there is no switch to find it)", () => {
    const placed = circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, space: 7 });
    const html = render(data({ circuits: [placed], estimates: [] }));
    expect(html).toContain('aria-label="Space 7: Outlets Right · 20"');
    expect(buttons(html).map((b) => b.text)).not.toContain("Positions");
  });
});

describe("Add New Panel", () => {
  it("numbers a new panel the way Panel 1 is numbered, never a name the job already has", () => {
    expect(freePanelName([])).toBe("Panel 1");
    expect(freePanelName(["Panel 1"])).toBe("Panel 2");
    expect(freePanelName(["Main Panel"])).toBe("Panel 2");
    expect(freePanelName(["panel 1", "Panel 2"])).toBe("Panel 3");
    expect(freePanelName(["Main Panel", "Panel 2"])).toBe("Panel 3");
  });
});

describe("the office bar's words", () => {
  it("one circuit here is singular, and says where it came from", () => {
    const html = render(data({ estimates: [{ ...data().estimates[0], onJob: 1, fresh: 11, alsoFrom: null }] }));
    expect(textOf(html)).toContain("E-017 Has 12 Circuits. 1 Is Here");
  });
});

describe("the reads on the tab: a photo's line on the door, a plans label check in the list", () => {
  // (The reader card itself is pinned in panel-readers.test.ts.)
  const fridge = FINAL_MAP.find((c) => c.description === "Fridge")!;
  const check = circuit({
    room: fridge.room,
    description: fridge.description,
    id: "chk",
    state: "suggested",
    source: "plan",
    amps: 20,
    source_row: { key: "plan-flag:x", flag_for: fridge.id, sheet: "E-1", check: "Plans Say Mini Fridge, Your List Says Fridge.", use: { description: "Mini Fridge" }, was: { description: "Fridge" } },
  });
  const garage = circuit({ room: "Garage", description: null, panel_label: "Garage", amps: 20, id: "g1", state: "suggested", source: "photo", space: 1, work: "existing", source_row: { key: "photo:g" } });

  it("a label check names the kept circuit, says what differs, offers Use It / Open It / Not This (never Keep) in the list; Keep All leaves it out", () => {
    const html = render(data({ circuits: [...FINAL_MAP, check, garage], estimates: [] }));
    const t = textOf(html);
    expect(t).toContain("Label Check: Kitchen Fridge");
    expect(t).toContain("Plans Say Mini Fridge, Your List Says Fridge.");
    expect(t).toContain("From The Plans · E-1");
    // In the list under the door, among the Kitchen circuits: never above the door.
    expect(t.indexOf("Label Check: Kitchen Fridge")).toBeGreaterThan(t.indexOf("By Area"));
    const labels = buttons(html).map((b) => b.text);
    expect(labels.filter((l) => l === "Use It")).toHaveLength(1);
    expect(labels.filter((l) => l === "Open It")).toHaveLength(1);
    expect(labels.filter((l) => l === "Keep")).toHaveLength(1); // the garage circuit only
    // The garage read has a space (1, open): it is drawn dimmed on the door with its own Keep (its
    // Not This is in its sheet); the label check is about a circuit with no space, so it is listed.
    expect(labels.filter((l) => l === "Not This")).toHaveLength(1);
    expect(html).toMatch(/data-line="suggested"[\s\S]*?Space 1, Suggested From The Panel Photo/);
    expect(labels).not.toContain("Keep All (2)");
    phoneSafe(html);
    for (const b of buttons(html)) if (b.text) expect(isTitleCase(b.text), b.text).toBe(true);
  });

  it("a photo line on a space a kept circuit holds is 'Photo says' under that line, with Use It and Skip, and Keep All leaves it out", () => {
    const bar = { ...FINAL_MAP.find((c) => c.description === "Bar")!, space: 3 };
    const read = circuit({ room: null, description: null, panel_label: "Wine Cooler", amps: 20, id: "w1", state: "suggested", source: "photo", space: 3, work: "existing", source_row: { key: "photo:w" } });
    const other = circuit({ room: null, description: null, panel_label: "Porch", amps: 15, id: "p1", state: "suggested", source: "photo", space: 5, work: "existing", source_row: { key: "photo:p" } });
    const html = render(data({ circuits: [...FINAL_MAP.map((c) => (c.id === bar.id ? bar : c)), read, other], estimates: [] }));
    expect(textOf(html)).toContain("Bar · 20 Photo says: Wine Cooler Use It Skip");
    const labels = buttons(html).map((b) => b.text);
    // Only the read on the open space is keepable: one, so there is no Keep All.
    expect(labels).not.toContain("Keep All (2)");
    expect(labels.filter((l) => l === "Keep")).toHaveLength(1);
  });
});

describe("Add A Circuit carries only the room and the amps (J-011, 2026-09-25)", () => {
  it("a 2-pole never carries into the next add: the floor heat made three outlets 2-poles", () => {
    expect(carryQuick({ room: "Living", amps: "20", poles: "2", work: "new" })).toEqual({ room: "Living", amps: "20", poles: "1", work: "new" });
  });
  it("Existing or Reused is a one-off too", () => {
    expect(carryQuick({ room: "Kitchen", amps: "50", poles: "2", work: "existing" })).toEqual({ room: "Kitchen", amps: "50", poles: "1", work: "new" });
  });
  it("nothing stored starts on the defaults", () => {
    expect(carryQuick(null)).toEqual({ room: "", amps: "20", poles: "1", work: "new" });
  });
});
