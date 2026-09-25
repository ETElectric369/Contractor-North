import { describe, expect, it } from "vitest";
import { FINAL_MAP, PANEL, PANEL_ID, circuit } from "./__fixtures__/herringbone";
import {
  NORT_SAYS,
  PANEL_SAYS,
  PLANS_SAY,
  headerSuggestions,
  matchRead,
  readerSuggestions,
  readerSummary,
  walkthroughSaid,
  type ReadRow,
} from "./readers";
import { sourceWords } from "./model";
import type { JobCircuit } from "@/lib/types";

/**
 * THE READERS' ONE ANSWER (Panel plan, phase 4): what the panel photo, the plans and Nort saw,
 * against J-011's list as it stood the night of 2026-09-24/25. The photo's existing circuits (the
 * ones the hand map never drew) come in as suggestions; a circuit already on the list is said, not
 * doubled; one that differs is a LABEL CHECK ("Panel Says Mini Fridge, Your List Says Fridge") that
 * names the kept circuit and never touches it; a reread adds nothing; a Not This stays set aside.
 */

const row = (over: Partial<ReadRow>): ReadRow => ({
  space: null,
  half: null,
  said: null,
  room: null,
  amps: null,
  poles: 1,
  kind: null,
  wire: null,
  work: "existing",
  check: null,
  ...over,
});

/** What the photo of J-011's panel shows that the hand map didn't draw (PHOTO_EXISTING, as read). */
const PHOTO_ROWS: ReadRow[] = [
  row({ space: 1, said: "Garage", amps: 20 }),
  row({ space: 3, said: "Garage", amps: 20 }),
  row({ space: 5, said: "Mud Rm", kind: "afci" }),
  row({ space: 7, said: "40A 2-Pole", amps: 40, poles: 2 }),
  row({ space: 11, half: "A", said: "GDO #1", kind: "spd" }),
  row({ space: 11, half: "B", said: "GDO #2", kind: "spd" }),
  row({ space: 13, said: "Garage 15", amps: 15, kind: "afci" }),
  row({ space: 15, said: "Smokes", kind: "afci" }),
];

describe("readerSuggestions: the photo's existing circuits against the final map", () => {
  const out = readerSuggestions({ source: "photo", rows: PHOTO_ROWS, circuits: FINAL_MAP, panelId: PANEL_ID, says: PANEL_SAYS, startSort: 0, stamp: { document_name: "panel.jpg" } });

  it("every circuit the hand map didn't draw comes in as a SUGGESTION, existing work, the door's words as the door label", () => {
    expect(out.drafts).toHaveLength(8);
    expect(out.flagged).toBe(0);
    expect(out.same).toBe(0);
    for (const d of out.drafts) {
      expect(d.state).toBe("suggested");
      expect(d.source).toBe("photo");
      expect(d.work).toBe("existing");
      expect(d.description).toBeNull();
      expect(d.source_row.document_name).toBe("panel.jpg");
      expect(d.source_row).not.toHaveProperty("quote_number"); // 0333 refuses it on a non-estimate row
    }
    expect(out.drafts.map((d) => d.panel_label)).toEqual(["Garage", "Garage", "Mud Rm", "40A 2-Pole", "GDO #1", "GDO #2", "Garage 15", "Smokes"]);
    expect(out.drafts[3]).toMatchObject({ space: 7, poles: 2, amps: 40 });
    expect(out.drafts[4]).toMatchObject({ space: 11, half: "A", kind: "spd" });
    expect(out.drafts[0].room).toBe("Garage");
  });

  it("two circuits with the same words on different spaces are two suggestions (two Garage 20s)", () => {
    const keys = out.drafts.map((d) => d.source_row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a reread adds nothing, and a suggestion set aside with Not This stays set aside", () => {
    const written: JobCircuit[] = out.drafts.map((d, i) =>
      circuit({ ...d, id: `p${i}`, panel_id: PANEL_ID, removed_at: i === 7 ? "2026-09-25T10:00:00Z" : null }),
    );
    const again = readerSuggestions({ source: "photo", rows: PHOTO_ROWS, circuits: [...FINAL_MAP, ...written], panelId: PANEL_ID, says: PANEL_SAYS, startSort: 0 });
    expect(again.drafts).toHaveLength(0);
    expect(again.already).toBe(7);
    expect(again.setAside).toBe(1);
    expect(readerSummary("the photo", PHOTO_ROWS.length, again)).toBe(
      "Read 8 circuits off the photo: 7 Already Suggested, 1 You Set Aside Before. Nothing new to add.",
    );
  });

  it("once kept, the same read is ALREADY ON YOUR LIST, not a second circuit", () => {
    const kept: JobCircuit[] = out.drafts.map((d, i) => circuit({ ...d, id: `k${i}`, panel_id: PANEL_ID, state: "kept", source: "hand", source_row: null }));
    const again = readerSuggestions({ source: "photo", rows: PHOTO_ROWS, circuits: [...FINAL_MAP, ...kept], panelId: PANEL_ID, says: PANEL_SAYS, startSort: 0 });
    expect(again.drafts).toHaveLength(0);
    expect(again.same).toBe(8);
  });
});

describe("matchRead: label checks never overwrite a kept circuit", () => {
  it("Panel Says Mini Fridge, Your List Says Fridge: a check naming the fridge circuit, with what Use would change", () => {
    const fridge = circuit({ id: "fridge", room: "Kitchen", description: "Fridge", amps: 20, space: 12, work: "reused" });
    const m = matchRead(row({ space: 12, said: "Mini Fridge", amps: 20 }), [fridge], PANEL_ID, PANEL_SAYS);
    expect(m.kind).toBe("differs");
    if (m.kind !== "differs") return;
    expect(m.circuit.id).toBe("fridge");
    expect(m.words).toEqual(["Panel Says Mini Fridge, Your List Says Fridge."]);
    expect(m.use).toEqual({ panel_label: "Mini Fridge" });
    expect(m.was).toEqual({ panel_label: null });
  });

  it("the same check found by words when the list has no space: the space is offered too", () => {
    const fridge = FINAL_MAP.find((c) => c.description === "Fridge")!;
    const noLabel = { ...fridge, panel_label: null };
    const m = matchRead(row({ space: 12, said: "Mini Fridge", amps: 20 }), [noLabel], PANEL_ID, PANEL_SAYS);
    expect(m.kind).toBe("differs");
    if (m.kind !== "differs") return;
    expect(m.words).toEqual(["Panel Says Mini Fridge, Your List Says Fridge.", "Panel Shows Mini Fridge On Space 12. Your List Has No Space For It."]);
    expect(m.use).toEqual({ panel_label: "Mini Fridge", space: 12, half: null });
  });

  it("the door's own words already on the list (Entry Lights) are the same circuit, not a new one", () => {
    const m = matchRead(row({ said: "Entry Lights", amps: 15 }), FINAL_MAP, PANEL_ID, PANEL_SAYS);
    expect(m.kind).toBe("same");
  });

  it("a different size on the same space is said, and Use would change only the amps", () => {
    const c = circuit({ id: "k7", room: "Kitchen", description: "Outlets Right", amps: 20, space: 7 });
    const m = matchRead(row({ space: 7, said: "Outlets Right", amps: 15 }), [c], PANEL_ID, PANEL_SAYS);
    expect(m.kind).toBe("differs");
    if (m.kind !== "differs") return;
    expect(m.words).toEqual(["Panel Shows 1P 15A On Space 7, Your List Says 1P 20A."]);
    expect(m.use).toEqual({ amps: 15 });
  });

  it("generic words and two candidates match nothing: a new suggestion, and a person decides", () => {
    expect(matchRead(row({ said: "Outlets" }), FINAL_MAP, PANEL_ID, PANEL_SAYS).kind).toBe("none");
    // "Outlets East" is on the list twice (Living and Bedroom).
    expect(matchRead(row({ said: "Outlets East", amps: 20 }), FINAL_MAP, PANEL_ID, PANEL_SAYS).kind).toBe("same");
    expect(matchRead(row({ said: "East" }), FINAL_MAP, PANEL_ID, PANEL_SAYS).kind).toBe("none");
  });

  it("a suggestion or a taken-off circuit is not the list: only kept, live circuits match", () => {
    const off = circuit({ id: "off", room: "Kitchen", description: "Fridge", amps: 20, space: 12, removed_at: "2026-09-25T09:00:00Z" });
    const sug = circuit({ id: "sug", room: "Kitchen", description: "Fridge", amps: 20, space: 12, state: "suggested" });
    expect(matchRead(row({ space: 12, said: "Mini Fridge", amps: 20 }), [off, sug], PANEL_ID, PANEL_SAYS).kind).toBe("none");
  });
});

describe("readerSuggestions: checks, the plans and Nort", () => {
  it("a label check is one suggestion row that names the circuit, occupies no space, and is keyed so a reread doesn't repeat it", () => {
    const fridge = circuit({ id: "11111111-1111-4111-8111-111111111111", room: "Kitchen", description: "Fridge", amps: 20, space: 12, work: "reused" });
    const rows = [row({ space: 12, said: "Mini Fridge", amps: 20 })];
    const out = readerSuggestions({ source: "photo", rows, circuits: [fridge], panelId: PANEL_ID, says: PANEL_SAYS, startSort: 0 });
    expect(out.flagged).toBe(1);
    expect(out.drafts).toHaveLength(1);
    const d = out.drafts[0];
    expect(d.space).toBeNull();
    expect(d.state).toBe("suggested");
    expect(d.source_row).toMatchObject({ flag_for: fridge.id, check: "Panel Says Mini Fridge, Your List Says Fridge.", use: { panel_label: "Mini Fridge" }, was: { panel_label: null } });
    expect(readerSummary("the photo", 1, out)).toBe("Read 1 circuit off the photo: 1 Label Check. Nothing counts until you keep it.");
    const again = readerSuggestions({
      source: "photo",
      rows,
      circuits: [fridge, circuit({ ...d, id: "chk", state: "suggested" })],
      panelId: PANEL_ID,
      says: PANEL_SAYS,
      startSort: 0,
    });
    expect(again.drafts).toHaveLength(0);
    expect(again.already).toBe(1);
  });

  it("the plans' words are what a circuit FEEDS (not the door), with the plan's sheet and circuit number kept, and no space", () => {
    const out = readerSuggestions({
      source: "plan",
      rows: [row({ said: "Bath Floor Heat", amps: 20, poles: 2, work: "new", extra: { sheet: "E-1", ckt: "14" } })],
      circuits: [],
      panelId: null,
      says: PLANS_SAY,
      startSort: 0,
    });
    expect(out.drafts[0]).toMatchObject({ description: "Bath Floor Heat", panel_label: null, space: null, room: "Bath", work: "new", source: "plan" });
    expect(out.drafts[0].source_row).toMatchObject({ sheet: "E-1", ckt: "14" });
    expect(sourceWords({ source: "plan", source_row: out.drafts[0].source_row })).toBe("From The Plans · E-1");
  });

  it("Nort's 'a 20 amp for the garage freezer' is a suggestion that feeds Freezer in the Garage", () => {
    const out = readerSuggestions({
      source: "nort",
      rows: [row({ said: "Freezer", feeds: "Freezer", door: null, room: "Garage", amps: 20, work: "new" })],
      circuits: FINAL_MAP,
      panelId: PANEL_ID,
      says: NORT_SAYS,
      startSort: 0,
    });
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ room: "Garage", description: "Freezer", panel_label: null, amps: 20, poles: 1, state: "suggested", source: "nort" });
    expect(sourceWords({ source: "nort", source_row: out.drafts[0].source_row })).toBe("From Nort");
  });
});

describe("the panel itself", () => {
  it("offers only what the panel doesn't already say, each on its own line", () => {
    const h = headerSuggestions(PANEL, { brand: "siemens", main_amps: 125, spaces: 40, dead_spaces: [13, 99] }, "The Panel Photo");
    expect(h.map((x) => x.field)).toEqual(["spaces", "dead_spaces"]);
    expect(h[0]).toMatchObject({ value: 40, words: "Spaces: 40 (Yours Says 32)" });
    expect(h[1]).toMatchObject({ value: [13], words: "No Stab: Space 13" });
  });

  it("with no panel yet, everything said is offered", () => {
    const h = headerSuggestions(null, { brand: "Siemens", main_amps: 125, spaces: 32 }, "The Panel Photo");
    expect(h.map((x) => x.words)).toEqual(["Brand: Siemens", "Main: 125A", "Spaces: 32"]);
  });

  it("the walk-through's one box is read for a brand and an amps figure, and shown whole", () => {
    const w = walkthroughSaid([{ panel_condition: "Siemens, 200A, two slots open" }]);
    expect(w).toEqual({ said: { brand: "Siemens", main_amps: 200 }, words: "Siemens, 200A, two slots open" });
    expect(walkthroughSaid([{ panel_brand: null, panel_amps: null, panel_condition: null }])).toEqual({ said: {}, words: null });
    expect(walkthroughSaid([{ panel_brand: "Square D", panel_amps: 100 }]).said).toEqual({ brand: "Square D", main_amps: 100 });
  });
});
