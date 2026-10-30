import { describe, expect, it } from "vitest";
import { FINAL_MAP, PANEL, PANEL_ID, circuit } from "./__fixtures__/honeysuckle";
import {
  NORT_SAYS,
  PHOTO_CAP_WORDS,
  PLANS_SAY,
  labelCheckApplied,
  landRead,
  landedWords,
  matchRead,
  panelFacts,
  readerSuggestions,
  readerSummary,
  type ReadRow,
} from "./readers";
import { sourceWords } from "./model";
import type { JobCircuit } from "@/lib/types";

/**
 * THE READERS' ONE ANSWER (Panel plan, phase 4; the photo honed in the panel-first wave).
 *
 * THE PHOTO LANDS IN ITS SPACES (landRead): a line the panel already says is nothing to do, one
 * whose words differ waits in the same space beside the kept one, a re-read writes nothing new, and
 * a quad's centre lands at half B. The panel's own facts are one line, only what differs.
 *
 * THE PLANS AND NORT keep the three-way match: a circuit already on the list is said, not doubled;
 * one that differs is a LABEL CHECK that names the kept circuit and never touches it.
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

const P = "panel-larkspur";
const kept = (over: Partial<JobCircuit>) => circuit({ room: null, description: null, panel_id: P, state: "kept", ...over });

describe("landRead: where a photo's read lands", () => {
  it("a kept circuit with the same words on that space is nothing to do (case and spacing never differ)", () => {
    const bar = kept({ space: 17, half: "A", panel_label: "Bar", amps: 20 });
    const fridge = kept({ space: 17, half: "B", panel_label: null, description: "Mini Fridge", amps: 20 });
    const l = landRead([row({ space: 17, half: "A", said: "BAR" }), row({ space: 17, half: "B", said: "mini  fridge" })], [bar, fridge], { panelId: P });
    expect(l.toWrite).toEqual([]);
    expect(l.skipped.map((s) => s.why)).toEqual(["same", "same"]);
    expect(landedWords(2, l)).toBe("Read 2 lines — nothing new: 2 already match the panel.");
  });

  it("different words on a held space are WRITTEN there, a suggestion beside the kept line — never a label check", () => {
    const bar = kept({ id: "bar", space: 14, half: "B", panel_label: "Bar", amps: 20 });
    const l = landRead([row({ space: 14, half: "B", said: "Wine Cooler", amps: 20 })], [bar], { panelId: P, stamp: { document_name: "snowbell-door.jpg" } });
    expect(l.skipped).toEqual([]);
    expect(l.toWrite).toHaveLength(1);
    const d = l.toWrite[0];
    expect(d).toMatchObject({
      space: 14,
      half: "B",
      panel_label: "Wine Cooler",
      description: null,
      amps: 20,
      poles: 1,
      state: "suggested",
      source: "photo",
      work: "existing",
    });
    expect(d.source_row).toMatchObject({ said: "Wine Cooler", document_name: "snowbell-door.jpg" });
    expect(d.source_row).not.toHaveProperty("flag_for");
    expect(d.source_row).not.toHaveProperty("quote_number"); // 0333 refuses it on a non-estimate row
    expect(landedWords(1, l)).toBe("Read 1 line — Keep All or tap each one.");
  });

  it("an empty space gets the line, dimmed, to keep; a 2-pole's second space is held by it", () => {
    const split = kept({ space: 9, poles: 2, panel_label: "Mini Split", amps: 20 });
    const l = landRead(
      [row({ space: 9, said: "Mini Split", poles: 2, amps: 20 }), row({ space: 11, said: "Mini Split", poles: 1 }), row({ space: 5, half: "A", said: "Holiday" })],
      [split],
      { panelId: P },
    );
    // 11 is the Mini Split's own second space: the same words there are the same breaker.
    expect(l.skipped.map((s) => [s.row.space, s.why])).toEqual([
      [9, "same"],
      [11, "same"],
    ]);
    expect(l.toWrite.map((d) => [d.space, d.half, d.panel_label])).toEqual([[5, "A", "Holiday"]]);
    expect(landedWords(3, l)).toBe("Read 3 lines, 1 new — Keep All or tap each one. 2 already match the panel.");
  });

  it("re-reading the same photo writes nothing twice; a line someone skipped stays skipped", () => {
    const read = [row({ space: 1, half: "A", said: "Garage", amps: 20 }), row({ space: 21, half: "B", said: "Bed West Wall" })];
    const first = landRead(read, [], { panelId: P });
    expect(first.toWrite).toHaveLength(2);
    const waiting = first.toWrite.map((d, i) => circuit({ ...d, id: `w${i}`, panel_id: P, removed_at: i === 1 ? "2026-10-30T10:00:00Z" : null }));
    const again = landRead(read, waiting, { panelId: P });
    expect(again.toWrite).toEqual([]);
    expect(again.skipped.map((s) => s.why)).toEqual(["waiting", "skipped-before"]);
    expect(landedWords(2, again)).toBe("Read 2 lines — nothing new: 1 already waiting, 1 you skipped before.");
    // A suggestion waiting with OTHER words is not this line: the new words are written beside it.
    const other = circuit({ ...first.toWrite[0], id: "w9", panel_id: P, panel_label: "Garage Door" });
    expect(landRead([read[0]], [other], { panelId: P }).toWrite).toHaveLength(1);
  });

  it("a quad's centre lands at the first space's half B as ONE 2-pole, between its two outer singles", () => {
    const l = landRead(
      [
        row({ space: 13, half: "A", said: "Entry Kitchen Living" }),
        row({ space: 13, half: "B", said: "Dryer", poles: 2, amps: 30 }),
        row({ space: 15, half: "B", said: "Bath Lights" }),
      ],
      [],
      { panelId: P },
    );
    expect(l.toWrite.map((d) => [d.space, d.half, d.poles, d.panel_label])).toEqual([
      [13, "A", 1, "Entry Kitchen Living"],
      [13, "B", 2, "Dryer"],
      [15, "B", 1, "Bath Lights"],
    ]);
    // Kept as a quad centre with the same words, the dryer is nothing to do on a second read.
    const dryer = kept({ space: 13, half: "B", poles: 2, panel_label: "Dryer", amps: 30 });
    const again = landRead([row({ space: 13, half: "B", said: "Dryer", poles: 2, amps: 30 })], [dryer], { panelId: P });
    expect(again.skipped.map((s) => s.why)).toEqual(["same"]);
  });

  it("only the panel read counts: a kept circuit on another panel, a taken-off one, or a suggestion is not the panel", () => {
    const elsewhere = kept({ space: 3, panel_label: "Catbird", panel_id: "panel-2" });
    const off = kept({ space: 3, panel_label: "Catbird", removed_at: "2026-10-29T09:00:00Z" });
    const l = landRead([row({ space: 3, said: "Catbird" })], [elsewhere, off], { panelId: P });
    expect(l.toWrite).toHaveLength(1);
  });

  it("a loose kept circuit (on no panel yet) is the panel's when the job has one live panel — the tab's rule — and nobody's with several", () => {
    const loose = kept({ space: 3, panel_label: "Catbird", panel_id: null });
    const read = [row({ space: 3, said: "Catbird" })];
    // One live panel: the door draws it there, so the read says the panel already has it.
    expect(landRead(read, [loose], { panelId: P, livePanels: 1 }).skipped.map((s) => s.why)).toEqual(["same"]);
    // Several: it isn't this panel's until a person picks, so the read is new here.
    expect(landRead(read, [loose], { panelId: P, livePanels: 2 }).toWrite).toHaveLength(1);
    // A count nobody gave never adopts one.
    expect(landRead(read, [loose], { panelId: P }).toWrite).toHaveLength(1);
  });

  it("a blank line is a breaker with no words: written on an empty space, nothing to do where something sits", () => {
    const mud = kept({ space: 7, half: "A", panel_label: "Mudroom" });
    const l = landRead([row({ space: 7, half: "A", said: null, amps: 15 }), row({ space: 7, half: "B", said: null, amps: 15 })], [mud], { panelId: P });
    expect(l.skipped.map((s) => [s.row.half, s.why])).toEqual([["A", "same"]]);
    expect(l.toWrite.map((d) => [d.space, d.half, d.panel_label, d.amps])).toEqual([[7, "B", null, 15]]);
  });

  it("a line with no space can't land, and the same line twice in one read lands once", () => {
    const l = landRead([row({ said: "Bayberry Fan" }), row({ space: 4, half: "B", said: "GDO 2" }), row({ space: 4, half: "B", said: "gdo 2" })], [], { panelId: P });
    expect(l.skipped.map((s) => s.why)).toEqual(["no-space", "twice"]);
    expect(l.toWrite).toHaveLength(1);
  });

  it("nothing readable is said as such, and the cap is one sentence", () => {
    expect(landedWords(0, { toWrite: [], skipped: [] })).toBe("Nothing readable in that photo — try one straight on with the door open.");
    expect(PHOTO_CAP_WORDS).toBe("3 photo reads a day on this job — ask the office for more.");
  });
});

describe("panelFacts: what the photo says about the panel, one line, only what differs", () => {
  it("brand, spaces and main, in that order, each only when the panel says otherwise", () => {
    const f = panelFacts({ brand: null, main_amps: 125, spaces: 32 }, { brand: "Siemens", main_amps: 200, spaces: 24 });
    expect(f).toEqual({
      words: "The photo says Siemens, 24 spaces, 200 A main.",
      patch: { brand: "Siemens", spaces: 24, main_amps: 200 },
      seen: { brand: null, spaces: 32, main_amps: 125 },
    });
  });

  it("the panel already saying it (any case) is no line at all; nonsense is never offered", () => {
    expect(panelFacts(PANEL, { brand: "siemens", main_amps: 125, spaces: 32 })).toBeNull();
    expect(panelFacts(PANEL, { brand: "Siemens", main_amps: 7, spaces: 999 })).toBeNull();
    expect(panelFacts(PANEL, { spaces: 40 })).toMatchObject({ words: "The photo says 40 spaces.", patch: { spaces: 40 }, seen: { spaces: 32 } });
    expect(panelFacts(null, { brand: "Siemens" })).toBeNull();
    expect(panelFacts(PANEL, null)).toBeNull();
  });

  it("names the No Stab spaces the panel doesn't mark yet, and Use It ADDS them (a read never takes one off)", () => {
    const f = panelFacts({ ...PANEL, dead_spaces: [5] }, { brand: PANEL.brand, main_amps: PANEL.main_amps, spaces: PANEL.spaces, dead_spaces: [31, 5, 32] });
    expect(f).toEqual({
      words: "The photo says 2 No Stab spaces (31, 32).",
      patch: { dead_spaces: [5, 31, 32] },
      seen: { dead_spaces: [5] },
    });
    // With the spaces too, in one line; one past the end of the panel is never offered.
    expect(panelFacts({ ...PANEL, dead_spaces: [] }, { spaces: 40, dead_spaces: [39, 44] })?.words).toBe("The photo says 40 spaces, 1 No Stab space (39).");
    // Already marked: no line.
    expect(panelFacts({ ...PANEL, dead_spaces: [31] }, { dead_spaces: [31] })).toBeNull();
  });
});

describe("matchRead (the plans and Nort): label checks never overwrite a kept circuit", () => {
  it("the door's own words already on the list (Entry Lights) are the same circuit, not a new one", () => {
    expect(matchRead(row({ said: "Entry Lights", amps: 15 }), FINAL_MAP, PANEL_ID, NORT_SAYS).kind).toBe("same");
  });

  it("a different size on the same space is said, and Use would change only the amps", () => {
    const c = circuit({ id: "k7", room: "Kitchen", description: "Outlets Right", amps: 20, space: 7 });
    const m = matchRead(row({ space: 7, said: "Outlets Right", amps: 15 }), [c], PANEL_ID, NORT_SAYS);
    expect(m.kind).toBe("differs");
    if (m.kind !== "differs") return;
    expect(m.words).toEqual(["Nort Heard 1P 15A On Space 7, Your List Says 1P 20A."]);
    expect(m.use).toEqual({ amps: 15 });
  });

  it("generic words and two candidates match nothing: a new suggestion, and a person decides", () => {
    expect(matchRead(row({ said: "Outlets" }), FINAL_MAP, PANEL_ID, NORT_SAYS).kind).toBe("none");
    // "Outlets East" is on the list twice (Living and Bedroom).
    expect(matchRead(row({ said: "Outlets East", amps: 20 }), FINAL_MAP, PANEL_ID, NORT_SAYS).kind).toBe("same");
    expect(matchRead(row({ said: "East" }), FINAL_MAP, PANEL_ID, NORT_SAYS).kind).toBe("none");
  });

  it("a suggestion or a taken-off circuit is not the list: only kept, live circuits match", () => {
    const off = circuit({ id: "off", room: "Kitchen", description: "Fridge", amps: 20, space: 12, removed_at: "2026-09-25T09:00:00Z" });
    const sug = circuit({ id: "sug", room: "Kitchen", description: "Fridge", amps: 20, space: 12, state: "suggested" });
    expect(matchRead(row({ space: 12, said: "Mini Fridge", amps: 20 }), [off, sug], PANEL_ID, NORT_SAYS).kind).toBe("none");
  });

  it("a tandem space said with no half is matched by its words, never by whichever half comes first", () => {
    const lights = circuit({ id: "25a", room: "Bath", panel_label: "Bath Lights", description: null, amps: 15, space: 25, half: "A" });
    const fan = circuit({ id: "25b", room: "Bath", panel_label: "Bath Fan", description: null, amps: 15, space: 25, half: "B" });
    expect(matchRead(row({ space: 25, half: null, said: "Bath Fan", amps: 15 }), [lights, fan], null, NORT_SAYS)).toMatchObject({ kind: "same", circuit: { id: "25b" } });
    const out = readerSuggestions({ source: "nort", rows: [row({ space: 25, half: null, said: "Bath Fan", amps: 15 })], circuits: [lights, fan], panelId: null, says: NORT_SAYS, startSort: 0 });
    expect(out).toMatchObject({ same: 1, flagged: 0, drafts: [] });
    // Words that fit neither half are a new suggestion a person decides, never a rename of one half.
    expect(matchRead(row({ space: 25, half: null, said: "Hall Smoke", amps: 15 }), [lights, fan], null, NORT_SAYS).kind).toBe("none");
    // Words near one half only are checked against that half.
    expect(matchRead(row({ space: 25, half: null, said: "Bath Exhaust Fan", amps: 15 }), [lights, fan], null, NORT_SAYS)).toMatchObject({ kind: "differs", circuit: { id: "25b" } });
  });

  it("the plans' words change what a circuit FEEDS, never the door label", () => {
    const kitchen = circuit({ id: "k1", room: "Kitchen", panel_label: "Kitchen", description: "Kitchen Counter", amps: 20 });
    const m = matchRead(row({ said: "Kitchen Receptacles", amps: 20, work: "new", extra: { sheet: "E-1", ckt: "7" } }), [kitchen], null, PLANS_SAY);
    expect(m.kind).toBe("differs");
    if (m.kind !== "differs") return;
    expect(m.words).toEqual(["Plans Say It Feeds Kitchen Receptacles, Your List Says Kitchen Counter."]);
    expect(m.use).toEqual({ description: "Kitchen Receptacles" });
    expect(m.was).toEqual({ description: "Kitchen Counter" });
  });

  it("Nort told the door's words apart checks them against the door label, and says it", () => {
    const fridge = circuit({ id: "f1", room: "Kitchen", panel_label: "Fridge", description: null, amps: 20, space: 12 });
    const m = matchRead(row({ said: "Fridge", door: "Mini Fridge", feeds: "Fridge", amps: 20 }), [fridge], null, NORT_SAYS);
    expect(m.kind).toBe("differs");
    if (m.kind !== "differs") return;
    expect(m.words).toEqual(["Nort Heard The Door Says Mini Fridge, Your List's Door Label Says Fridge."]);
    expect(m.use).toEqual({ panel_label: "Mini Fridge" });
    const out = readerSuggestions({ source: "nort", rows: [row({ said: "Fridge", door: "Mini Fridge", feeds: "Fridge", amps: 20 })], circuits: [fridge], panelId: null, says: NORT_SAYS, startSort: 0 });
    expect(out.drafts[0]).toMatchObject({ panel_label: "Mini Fridge", description: null, source_row: { flag_for: "f1" } });
  });
});

describe("readerSuggestions: the plans and Nort", () => {
  it("a label check is one suggestion row that names the circuit, occupies no space, and is keyed so a re-read doesn't repeat it", () => {
    const fridge = circuit({ id: "11111111-1111-4111-8111-111111111111", room: "Kitchen", description: "Fridge", amps: 20, space: 12, work: "reused" });
    const rows = [row({ space: 12, said: "Mini Fridge", amps: 20, work: "new" })];
    const out = readerSuggestions({ source: "nort", rows, circuits: [fridge], panelId: PANEL_ID, says: NORT_SAYS, startSort: 0 });
    expect(out.flagged).toBe(1);
    expect(out.drafts).toHaveLength(1);
    const d = out.drafts[0];
    expect(d.space).toBeNull();
    expect(d.state).toBe("suggested");
    expect(d.source_row).toMatchObject({ flag_for: fridge.id, check: "Nort Heard It Feeds Mini Fridge, Your List Says Fridge.", use: { description: "Mini Fridge" }, was: { description: "Fridge" } });
    expect(readerSummary("what Nort heard", 1, out)).toBe("Read 1 circuit off what Nort heard: 1 Label Check. Nothing counts until you keep it.");
    const again = readerSuggestions({ source: "nort", rows, circuits: [fridge, circuit({ ...d, id: "chk", state: "suggested" })], panelId: PANEL_ID, says: NORT_SAYS, startSort: 0 });
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

  it("a used check is known by its change being on the circuit", () => {
    const fridge = circuit({ id: "f1", room: "Kitchen", panel_label: "Mini Fridge", description: "Fridge" });
    expect(labelCheckApplied(fridge, { panel_label: "Mini Fridge" })).toBe(true);
    expect(labelCheckApplied(fridge, { panel_label: "Wine Fridge" })).toBe(false);
    expect(labelCheckApplied(fridge, { description: "fridge" })).toBe(true);
    expect(labelCheckApplied(fridge, {})).toBe(false);
    expect(labelCheckApplied(null, { panel_label: "Mini Fridge" })).toBe(false);
  });
});
