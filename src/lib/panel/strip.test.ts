import { describe, it, expect } from "vitest";
import { stripLengthIn, stripLines, stripWords, type StripCircuit, type StripLine, type StripPanel } from "./strip";
import { DOOR_24, DOOR_24_REPLY } from "./__fixtures__/door-24";

/**
 * THE LABEL STRIPS, PINNED ON THE ONE 24-SPACE DOOR (__fixtures__/door-24, the photo reader's door
 * too): a Siemens door at an inch a space, laid out the way a real one hangs — mostly tandems (two
 * handles, A over B, in one space), three Siemens QUADS (Floor Heat on 1/3, Dryer on 13/15, TVSS on
 * 2/4), a full 2-pole on each side (Mini Split on 9/11, EV Charger on 6/8), one single (Laundry on
 * 19), and two empty spaces on the right (20, 24).
 *
 * A QUAD is two outer 1-poles and ONE centre 2-pole: the outer singles at sA and (s+2)B, the centre
 * 2-pole kept at sB, which covers sB and (s+2)A (model slotsOf) — the middle two handles. So the
 * strip reads Garage, Floor Heat, Floor Heat, Garage down spaces 1 and 3: ONE Floor Heat circuit
 * whose words show on both of its half-lines, and two Garage 1-poles.
 */

const PANEL_ID = "panel-larkspur";
const LARKSPUR: StripPanel = {
  id: PANEL_ID,
  brand: "Siemens",
  spaces: 24,
  numbering: "top_down",
  dead_spaces: [],
  twin_spaces: [],
  space_pitch_in: 1,
  label_width_in: null,
  label_width_in_right: null,
};

let seq = 0;
function c(space: number, half: "A" | "B" | null, words: string, over: Partial<StripCircuit> = {}): StripCircuit {
  seq++;
  return {
    id: `larkspur-${seq}`,
    panel_id: PANEL_ID,
    space,
    half,
    poles: 1,
    state: "kept",
    removed_at: null,
    room: null,
    description: words,
    panel_label: null,
    amps: 20,
    work: "existing",
    ...over,
  };
}

/** The door's 34 breakers as circuits: one per row of the parsed read, its amps from the reply. */
const ampsAt = (space: number, half: "A" | "B" | null) => DOOR_24_REPLY.lines.find((l) => l.space === space && l.half === half)?.amps ?? null;
const CIRCUITS = DOOR_24.map(([space, half, poles, words]) => c(space, half, words ?? "", { poles, amps: ampsAt(space, half) }));

const where = (l: StripLine) => `${l.space}${l.half ?? ""}`;
const worded = (ls: StripLine[]) => ls.filter((l) => l.text !== "");

describe("Larkspur: the two strips of a 24-space door", () => {
  const strips = stripLines(LARKSPUR, CIRCUITS);

  it("counts every handle: 21 worded lines on the left, 18 on the right, 34 circuits", () => {
    // LEFT LINES: 9 split spaces (1, 3, 5, 7, 13, 15, 17, 21, 23) × 2 half-lines = 18, plus the Mini
    // Split's 2 lines (9 and 11), plus the 1 single (Laundry on 19) = 21 lines, every one with words.
    expect(strips.left).toHaveLength(21);
    expect(worded(strips.left)).toHaveLength(21);
    // RIGHT LINES: 8 split spaces (2, 4, 10, 12, 14, 16, 18, 22) × 2 = 16, plus the EV Charger's 2
    // lines (6 and 8) = 18 lines with words, plus the 2 empty spaces (20, 24) = 20 lines.
    expect(strips.right).toHaveLength(20);
    expect(worded(strips.right)).toHaveLength(18);
    // CIRCUITS. Left: 2 quads × 3 (two outer 1-poles + one centre 2-pole) = 6, 5 tandems (5, 7, 17,
    // 21, 23) × 2 = 10, the Mini Split and Laundry = 2: 18. Right: 1 quad × 3 = 3, 6 tandems (10, 12,
    // 14, 16, 18, 22) × 2 = 12, the EV Charger = 1: 16. 18 + 16 = 34 — the 37 a pair of 1-poles per
    // quad centre would make, less one for each of the three quads.
    expect(CIRCUITS).toHaveLength(34);
    expect(new Set([...strips.left, ...strips.right].map((l) => l.circuitId).filter(Boolean)).size).toBe(34);
    // The 39 worded lines are the 34 circuits plus the second line of each of the five 2-poles
    // (Mini Split, EV Charger, and the three quads' Floor Heat, Dryer and TVSS).
    expect(worded(strips.left).length + worded(strips.right).length).toBe(39);
    expect(strips.warnings).toEqual([]);
  });

  it("hangs top down: odd spaces on the left, even on the right, each tandem A over B", () => {
    expect(strips.left.map(where)).toEqual([
      "1A", "1B", "3A", "3B", "5A", "5B", "7A", "7B", "9", "11", "13A", "13B", "15A", "15B", "17A", "17B", "19", "21A", "21B", "23A", "23B",
    ]);
    expect(strips.right.map(where)).toEqual([
      "2A", "2B", "4A", "4B", "6", "8", "10A", "10B", "12A", "12B", "14A", "14B", "16A", "16B", "18A", "18B", "20", "22A", "22B", "24",
    ]);
    expect(strips.left.slice(0, 4).map((l) => l.text)).toEqual(["Garage", "Floor Heat", "Floor Heat", "Garage"]);
    expect(strips.left.find((l) => l.space === 13 && l.half === "A")!.text).toBe("Entry Kitchen Living");
  });

  it("a tandem's line is half a space; a single and a 2-pole line are a whole one; each side is 12 in long", () => {
    for (const l of [...strips.left, ...strips.right]) {
      expect(l.heightIn).toBe(l.half ? 0.5 : 1);
      // A half-line is a tandem's handle, or a quad's centre 2-pole's.
      if (l.half) expect(["tandem", "pole2"]).toContain(l.kind);
    }
    // 24 spaces at an inch: 12 down each side (24 in of label in all).
    expect(stripLengthIn(strips.left)).toBe(12);
    expect(stripLengthIn(strips.right)).toBe(12);
    expect(strips.left.find((l) => l.space === 19)).toMatchObject({ kind: "single", text: "Laundry", amps: 20, heightIn: 1 });
  });

  it("a 2-pole repeats its words on both of its spaces, the same circuit on each", () => {
    const split = strips.left.filter((l) => l.text === "Mini Split");
    expect(split.map(where)).toEqual(["9", "11"]);
    expect(split.every((l) => l.kind === "pole2" && l.amps === 20 && l.heightIn === 1)).toBe(true);
    expect(new Set(split.map((l) => l.circuitId)).size).toBe(1);
    const ev = strips.right.filter((l) => l.text === "EV Charger");
    expect(ev.map(where)).toEqual(["6", "8"]);
    expect(ev.every((l) => l.kind === "pole2" && l.amps === 50)).toBe(true);
  });

  it("a quad's centre 2-pole is ONE circuit whose words show on both of its half-lines, in the middle of the quad", () => {
    const centre = (ls: StripLine[], words: string) => ls.filter((l) => l.text === words);
    for (const [ls, words, at, amps] of [
      [strips.left, "Floor Heat", ["1B", "3A"], 20],
      [strips.left, "Dryer", ["13B", "15A"], 30],
      [strips.right, "TVSS", ["2B", "4A"], 20],
    ] as const) {
      const got = centre(ls, words);
      expect(got.map(where), words).toEqual(at);
      expect(got.every((l) => l.kind === "pole2" && l.heightIn === 0.5 && l.amps === amps), words).toBe(true);
      expect(new Set(got.map((l) => l.circuitId)).size, words).toBe(1);
    }
    // The outer bottom single is kept on 15B, under the Dryer's second handle.
    const bath = CIRCUITS.find((x) => x.description === "Bath Lights")!;
    expect([bath.space, bath.half]).toEqual([15, "B"]);
    expect(strips.left.find((l) => l.space === 15 && l.half === "B")).toMatchObject({ text: "Bath Lights", kind: "tandem", circuitId: bath.id });
    // Two Garage 1-poles (the quad's outer poles), two circuits.
    expect(new Set(strips.left.filter((l) => l.text === "Garage").map((l) => l.circuitId)).size).toBe(2);
    expect(strips.right.slice(0, 4).map((l) => l.text)).toEqual(["GDO 1", "TVSS", "TVSS", "GDO 2"]);
  });

  it("an empty space is a blank box of a whole space, so the boxes below still line up", () => {
    const empties = strips.right.filter((l) => l.kind === "empty");
    expect(empties.map(where)).toEqual(["20", "24"]);
    expect(empties.every((l) => l.text === "" && l.amps === null && l.circuitId === null && l.heightIn === 1)).toBe(true);
  });

  it("runs bottom up when the panel's numbers do (A still over B)", () => {
    const up = stripLines({ ...LARKSPUR, numbering: "bottom_up" }, CIRCUITS);
    expect(up.left.map(where).slice(0, 5)).toEqual(["23A", "23B", "21A", "21B", "19"]);
    expect(up.right.map(where).slice(0, 4)).toEqual(["24", "22A", "22B", "20"]);
    expect(up.left.map(where).slice(-4)).toEqual(["3A", "3B", "1A", "1B"]);
  });

  it("follows the door's measured pitch: a 0.75 in space makes 0.375 in tandem lines", () => {
    const ch = stripLines({ ...LARKSPUR, space_pitch_in: 0.75 }, CIRCUITS);
    expect(ch.left[0].heightIn).toBe(0.375);
    expect(ch.left.find((l) => l.space === 19)!.heightIn).toBe(0.75);
    expect(stripLengthIn(ch.left)).toBe(9);
  });
});

describe("the boxes the model's rules make", () => {
  const SMALL: StripPanel = { ...LARKSPUR, spaces: 8, space_pitch_in: null, brand: "Siemens", twin_spaces: [1, 3] };

  it("a quad (model.test's Q21530CT) hangs outer, centre, centre, outer: the singles at 1A and 3B, the 2-pole on 1B and 3A", () => {
    const quad = [c(1, "A", "Porch", { amps: 15 }), c(3, "B", "Hall", { amps: 15 }), c(1, "B", "Dryer", { poles: 2, amps: 30 })];
    const s = stripLines(SMALL, quad);
    expect(s.left.slice(0, 4).map((l) => [where(l), l.kind, l.text, l.heightIn, l.circuitId])).toEqual([
      ["1A", "tandem", "Porch", 0.5, quad[0].id],
      ["1B", "pole2", "Dryer", 0.5, quad[2].id],
      ["3A", "pole2", "Dryer", 0.5, quad[2].id],
      ["3B", "tandem", "Hall", 0.5, quad[1].id],
    ]);
    expect(s.warnings).toEqual([]);
    // A plain twin is A over B, and a full 2-pole covers both its whole spaces.
    const twin = stripLines(SMALL, [c(5, "A", "Bar"), c(5, "B", "Office"), c(2, null, "Range", { poles: 2, amps: 50 })]);
    expect(twin.left.filter((l) => l.space === 5).map((l) => [where(l), l.text])).toEqual([
      ["5A", "Bar"],
      ["5B", "Office"],
    ]);
    expect(twin.right.filter((l) => l.text === "Range").map(where)).toEqual(["2", "4"]);
  });

  it("a 3-pole covers three spaces on its side, each with its words", () => {
    const s = stripLines(SMALL, [c(2, null, "Shop Motor", { poles: 3, amps: 30 })]);
    expect(s.right.filter((l) => l.kind === "pole3").map((l) => [where(l), l.text])).toEqual([
      ["2", "Shop Motor"],
      ["4", "Shop Motor"],
      ["6", "Shop Motor"],
    ]);
  });

  it("a No Stab space with nothing on it is a dead, blank box; an unused tandem half is an empty one", () => {
    const s = stripLines({ ...SMALL, dead_spaces: [5] }, [c(3, "A", "Hall")]);
    expect(s.left.find((l) => l.space === 5)).toMatchObject({ kind: "dead", text: "", half: null, heightIn: 1 });
    expect(s.left.filter((l) => l.space === 3).map((l) => [l.half, l.kind, l.text])).toEqual([
      ["A", "tandem", "Hall"],
      ["B", "empty", ""],
    ]);
  });

  it("the door's words win over what it feeds; a suggestion, a circuit taken off and one coming out get no label", () => {
    const s = stripLines(SMALL, [
      c(1, null, "Kitchen And Living", { panel_label: "  Entry   Lights " }),
      c(3, null, "Suggested", { state: "suggested" }),
      c(5, null, "Taken Off", { removed_at: "2026-10-30T00:00:00Z" }),
      c(7, null, "Coming Out", { work: "removed" }),
      c(2, null, "Elsewhere", { panel_id: "another-panel" }),
    ]);
    expect(s.left.map((l) => l.text)).toEqual(["Entry Lights", "", "", ""]);
    expect(s.right.every((l) => l.kind === "empty")).toBe(true);
    expect(stripWords({ panel_label: null, description: " Fridge " })).toBe("Fridge");
  });

  it("two circuits on one line are both said, and the model's warning rides along; past the end is a warning, never a box", () => {
    const s = stripLines(SMALL, [c(1, null, "Bar"), c(1, null, "Office"), c(7, null, "Dryer", { poles: 2 })]);
    expect(s.left[0].text).toBe("Bar / Office");
    expect(s.left.map(where)).toEqual(["1", "3", "5", "7"]);
    expect(s.warnings).toContain("Space 1 has Bar and Office on it.");
    expect(s.warnings).toContain("Dryer runs to space 9, past the end of this 8-space panel.");
  });

  it("an odd panel: the cell beside its last space is NONE — no box, no words, no length — and a 1-space panel is one box", () => {
    const odd = stripLines({ ...SMALL, spaces: 7, twin_spaces: [] }, [c(7, null, "Laundry")]);
    expect(odd.left.map(where)).toEqual(["1", "3", "5", "7"]);
    expect(odd.right.map((l) => [where(l), l.kind])).toEqual([
      ["2", "empty"],
      ["4", "empty"],
      ["6", "empty"],
      ["8", "none"],
    ]);
    expect(odd.right.at(-1)).toMatchObject({ text: "", circuitId: null, amps: null });
    // The printed strip is three boxes long on the right, four on the left.
    expect(stripLengthIn(odd.left)).toBe(4);
    expect(stripLengthIn(odd.right)).toBe(3);
    // Bottom up, the gap is at the top of the right strip, so the two still line up row by row.
    expect(stripLines({ ...SMALL, spaces: 7, numbering: "bottom_up" }, []).right[0].kind).toBe("none");
    const one = stripLines({ ...SMALL, spaces: 1 }, []);
    expect([one.left.map((l) => l.kind), one.right.map((l) => l.kind)]).toEqual([["empty"], ["none"]]);
  });

  it("a panel whose size nobody said runs as far as its circuits do", () => {
    const s = stripLines({ ...SMALL, spaces: null }, [c(9, null, "Laundry")]);
    expect(s.left.map(where)).toEqual(["1", "3", "5", "7", "9"]);
    expect(s.right.map(where)).toEqual(["2", "4", "6", "8", "10"]);
  });
});
