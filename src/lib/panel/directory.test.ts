import { describe, it, expect } from "vitest";
import {
  asPortalDirectory,
  directoryFromRows,
  directoryLine,
  doorCard,
  existingNote,
  normalizePortalPanels,
  scheduleChips,
  scheduleGroups,
  sizeLine,
  spaceWords,
  unpanelledFromRows,
} from "./directory";
import { FINAL_MAP, PANEL, PANEL_ID, circuit } from "./__fixtures__/herringbone";

/**
 * THE DIRECTORY AS DATA (Panel plan, phase 5), on J-011's night: the printed map must carry what the
 * hand-built "Final Circuit Map" carried, and the customer's shape must carry nothing else.
 */

const FORBIDDEN = ["wire_tag", "wireTag", "notes", "progress", "source", "verified", "updated_by", "created_by", "part", "price", "supplier", "DWDS", "12/2", "14/2"];

describe("directoryFromRows: what is on the directory", () => {
  it("J-011's final map, in the directory: 22 circuits, the door's words first, what it feeds when that differs", () => {
    const d = directoryFromRows(PANEL, FINAL_MAP);
    expect(d.circuits).toHaveLength(22);
    expect(d.name).toBe("Main Panel");
    const entry = d.circuits.find((c) => c.label === "Entry Lights")!;
    expect(entry).toMatchObject({ feeds: "Kitchen And Living Lights", amps: 15, poles: 1, room: "Kitchen", isNew: false });
    const fridge = d.circuits.find((c) => c.label === "Mini Fridge")!;
    expect(fridge.feeds).toBe("Fridge");
    // A circuit whose door says what it feeds reads once: no "feeds" line.
    expect(d.circuits.find((c) => c.label === "Bath Lights")!.feeds).toBeNull();
    // Nothing the crew keeps for themselves rides along: no wire, no tag, no source, no who.
    const text = JSON.stringify(d);
    for (const f of FORBIDDEN) expect(text).not.toContain(f);
  });

  it("a suggestion, a circuit taken off, one coming out and another panel's are not on it", () => {
    const rows = [
      circuit({ room: "Garage", description: "Freezer", amps: 20, state: "suggested", source: "nort" }),
      circuit({ room: "Garage", description: "Old Heater", amps: 30, poles: 2, removed_at: "2026-09-25T09:00:00Z" }),
      circuit({ room: "Hall", description: "Old Fan", amps: 15, work: "removed" }),
      circuit({ room: "Shop", description: "Welder", amps: 50, poles: 2, panel_id: "another-panel" }),
      circuit({ room: "Bath", description: "Fan", amps: 15 }),
    ];
    const d = directoryFromRows(PANEL, rows);
    expect(d.circuits.map((c) => c.label)).toEqual(["Fan"]);
    // The printed map still lists a kept circuit that has no panel yet, on its own.
    expect(unpanelledFromRows([...rows, circuit({ room: "Porch", description: "Lights", amps: 15, panel_id: null })], [PANEL_ID]).map((c) => c.label)).toEqual([
      "Welder",
      "Lights",
    ]);
  });

  it("space order: placed first by space and half, the unplaced last with a dash; a 2P names both its spaces", () => {
    const rows = [
      circuit({ room: "Kitchen", description: "Range", amps: 50, poles: 2, space: 25 }),
      circuit({ room: "Kitchen", description: "Kitchen And Living", panel_label: "Entry Lights", amps: 15, space: 7 }),
      circuit({ room: "Bath", description: "Floor Heat", amps: 20, poles: 2 }),
      circuit({ room: "Bar", description: "Wine Cooler", amps: 20, space: 3, half: "B" }),
      circuit({ room: "Bar", description: "Bar", amps: 20, space: 3, half: "A" }),
    ];
    const d = directoryFromRows(PANEL, rows);
    expect(d.circuits.map(directoryLine)).toEqual([
      "3A · Bar · 20A",
      "3B · Wine Cooler · 20A",
      "7 · Entry Lights · feeds Kitchen And Living · 15A",
      "25/27 · Range · 2P 50A",
      "— · Floor Heat · 2P 20A",
    ]);
    expect(spaceWords({ space: 25, half: "B", poles: 2 })).toBe("25B/27B");
  });
});

describe("the door card", () => {
  it("odd left, even right, top first; a 2P on both spaces naming its pair; a twin split A/B; No Stab grey", () => {
    const d = directoryFromRows({ ...PANEL, spaces: 8, dead_spaces: [6] }, [
      circuit({ room: "Kitchen", description: "Range", amps: 50, poles: 2, space: 1 }),
      circuit({ room: "Bar", description: "Bar", amps: 20, space: 2, half: "A" }),
      circuit({ room: "Bar", description: "Wine Cooler", amps: 20, space: 2, half: "B" }),
    ]);
    const rows = doorCard(d);
    expect(rows.map((r) => [r.left.space, r.right.space])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
    expect(rows[0].left.occupants[0]).toMatchObject({ first: true, partner: 3 });
    expect(rows[1].left.occupants[0]).toMatchObject({ first: false, partner: 1 });
    expect(rows[0].right.occupants.map((o) => `${o.half} ${o.circuit.label}`)).toEqual(["A Bar", "B Wine Cooler"]);
    expect(rows[2].right).toMatchObject({ space: 6, noStab: true, occupants: [] });
    expect(rows[3].left.occupants).toEqual([]);
  });

  it("bottom-up numbering hangs space 1 at the bottom", () => {
    const d = directoryFromRows({ ...PANEL, spaces: 4, numbering: "bottom_up" }, []);
    expect(doorCard(d).map((r) => r.left.space)).toEqual([3, 1]);
  });
});

describe("the circuit map page: the hand-built map's content", () => {
  it("J-011: 22 circuits, 3 at 15 A, 16 at 20 A, 3 at 240 V, by size and room, with the note about what was already in", () => {
    const d = directoryFromRows(PANEL, FINAL_MAP);
    const groups = scheduleGroups(d.circuits);
    expect(groups.map((g) => [g.title, g.sub])).toEqual([
      ["15 A Circuits", "Single-Pole · 3 Circuits"],
      ["20 A Circuits", "Single-Pole · 16 Circuits"],
      ["240-Volt Circuits", "Two-Pole · 3 Circuits"],
    ]);
    expect(scheduleChips(groups)).toEqual([
      { n: 22, words: "Circuits" },
      { n: 3, words: "15 A" },
      { n: 16, words: "20 A" },
      { n: 3, words: "240-Volt" },
    ]);
    // Rooms together, in the order each first appears (Kitchen's four 20s, then Bar's two, ...).
    expect(groups[1].circuits.slice(0, 6).map((c) => c.room)).toEqual(["Kitchen", "Kitchen", "Kitchen", "Kitchen", "Bar", "Bar"]);
    expect(groups[2].circuits.map((c) => c.label)).toEqual(["Floor Heat", "Dryer", "Range"]);
    expect(existingNote(d.circuits)).toBe("Three circuits were already in the panel and stay in service (one 15 A, one 20 A and one 50 A 2-pole).");
    expect(existingNote(d.circuits.filter((c) => c.isNew))).toBeNull();
  });
});

describe("normalizePortalPanels: the customer's road in", () => {
  it("builds each line field by field and drops everything else the block could ever carry", () => {
    const panels = normalizePortalPanels([
      {
        name: "main panel",
        main_amps: 125,
        spaces: 32,
        notes: "crimped bus at 14",
        brand: "Siemens",
        circuits: [
          { space: 7, half: null, poles: 1, amps: 15, kind: "afci", room: "kitchen", label: "Entry Lights", feeds: "Kitchen And Living", is_new: true, wire_tag: "DWDS", source: "photo", progress: "done", verified_by: "x" },
          { space: 99, half: "C", poles: 7, amps: 17, kind: "weird", room: "", label: "Mystery", feeds: "mystery", is_new: "yes" },
        ],
      },
      "junk",
      null,
    ]);
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ name: "Main Panel", mainAmps: 125, spaces: 32, brand: null, numbering: "top_down", deadSpaces: [] });
    expect(panels[0].circuits[0]).toEqual({ space: 7, half: null, poles: 1, amps: 15, kind: "afci", room: "Kitchen", label: "Entry Lights", feeds: "Kitchen And Living", isNew: true });
    // A space the panel can't have, a size that isn't a breaker, an unknown type: dropped, never guessed.
    // And "feeds" that says the same as the label is not said twice.
    expect(panels[0].circuits[1]).toEqual({ space: null, half: null, poles: 1, amps: null, kind: null, room: null, label: "Mystery", feeds: null, isNew: false });
    expect(directoryLine(panels[0].circuits[0])).toBe("7 · Entry Lights · feeds Kitchen And Living · 15A AFCI");
    const text = JSON.stringify(panels);
    for (const f of ["DWDS", "photo", "done", "crimped", "Siemens", "verified"]) expect(text).not.toContain(f);
  });

  it("before 0335 (no block) or with nothing shown: no panel", () => {
    expect(normalizePortalPanels(undefined)).toEqual([]);
    expect(normalizePortalPanels(null)).toEqual([]);
    expect(normalizePortalPanels([])).toEqual([]);
  });
});

describe("review fixes: the preview is the portal, and no size reads as words", () => {
  it("the office's preview is exactly the portal's shape: no brand, top-down, no No Stab spaces", () => {
    const rows = directoryFromRows({ ...PANEL, brand: "Siemens", numbering: "bottom_up", dead_spaces: [31] }, FINAL_MAP);
    const preview = asPortalDirectory(rows);
    expect(preview).toMatchObject({ brand: null, numbering: "top_down", deadSpaces: [] });
    expect(preview.circuits).toEqual(rows.circuits);
    // The same circuits as the portal's own road makes of 0335's block.
    const block = [
      {
        name: rows.name,
        main_amps: rows.mainAmps,
        spaces: rows.spaces,
        circuits: rows.circuits.map((c) => ({ space: c.space, half: c.half, poles: c.poles, amps: c.amps, kind: c.kind, room: c.room, label: c.label, feeds: c.feeds, is_new: c.isNew })),
      },
    ];
    expect(normalizePortalPanels(block)).toEqual([preview]);
  });

  it("a circuit with no amps says Size Not Set, never ?A", () => {
    expect(sizeLine({ poles: 1, amps: null, kind: null })).toBe("Size Not Set");
    expect(sizeLine({ poles: 2, amps: null, kind: null })).toBe("2P, Size Not Set");
    expect(sizeLine({ poles: 2, amps: 30, kind: null })).toBe("2P 30A");
  });
});
