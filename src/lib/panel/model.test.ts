import { describe, it, expect } from "vitest";
import {
  breakerCheck,
  breakerNeed,
  circuitLine,
  circuitName,
  doorRows,
  groupByRoom,
  labelDiffers,
  labelDiffersWords,
  needSentence,
  newSuggestionsOnly,
  nextProgress,
  parseQuoteBreaker,
  quadSpaceFree,
  quoteCircuitsToSuggestions,
  rankEstimateCandidates,
  slotsOf,
  spaceMap,
  NO_ROOM,
} from "./model";
import { E017, E017_ID, FINAL_MAP, J011, PANEL, PHOTO_EXISTING, TICKET, circuit } from "./__fixtures__/herringbone";

/**
 * THE POLE MATH, PROVEN ON THE NIGHT'S NUMBERS (Panel plan, phase 1). J-011's final map against the
 * CED ticket 8802-SO-257555 (8 x Q2020 + 1 x Q21530CT) must say, in these words:
 *   "Short One 2P 20A (Bath Floor Heat)." and "One 1P 20A Spare."
 * and the need line must be "Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A."
 */

describe("the Herringbone breaker count", () => {
  const all = [...FINAL_MAP, ...PHOTO_EXISTING];

  it("needs 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A; the range and the two reused circuits are already in", () => {
    const need = breakerNeed(FINAL_MAP);
    expect(needSentence(need)).toBe("Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A.");
    expect(need.alreadyIn).toEqual({ existing: 1, reused: 2 });
    expect(need.unsized).toEqual([]);
  });

  it("the photo's existing circuits never add to what to buy", () => {
    expect(needSentence(breakerNeed(all))).toBe("Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A.");
    expect(breakerNeed(all).alreadyIn).toEqual({ existing: 9, reused: 2 });
  });

  it("says Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.", () => {
    const check = breakerCheck(breakerNeed(all), TICKET);
    expect(check.lines).toEqual(["Short One 2P 20A (Bath Floor Heat).", "One 1P 20A Spare."]);
    expect(check.verdict).toBe("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
    expect(check.ok).toBe(false);
    expect(check.short).toHaveLength(1);
    expect(check.spare).toEqual([{ poles: 1, amps: 20, kind: null, count: 1 }]);
  });

  it("offers the quad swap, with the CT2 warning, only when a tandem-rated pair of spaces is free", () => {
    const need = breakerNeed(all);
    expect(breakerCheck(need, TICKET).swaps).toEqual([]);
    const swaps = breakerCheck(need, TICKET, { quadSpaceFree: true }).swaps;
    expect(swaps).toHaveLength(1);
    expect(swaps[0].get.part).toBe("Q22020CT");
    expect(swaps[0].warning).toBe("Not Q22020CT2, That Is Two 2-Pole 20s");
    expect(swaps[0].words).toContain("Swap One Q2020 For A Q22020CT");
  });

  it("buying the Q220 closes it: nothing short, the one 1P 20A still spare", () => {
    const withQ220 = [...TICKET, { label: "Q220", qty: 1, form: "double" as const, slots: [{ poles: 2, amps: 20, kind: null }] }];
    const check = breakerCheck(breakerNeed(all), withQ220);
    expect(check.ok).toBe(true);
    expect(check.lines).toEqual(["One 1P 20A Spare."]);
  });

  it("a taken-off or still-suggested circuit is not counted; a new one with no amps is said, not dropped", () => {
    const takenOff = FINAL_MAP.map((c) => (c.description === "Floor Heat" ? { ...c, removed_at: "2026-09-25T09:00:00Z" } : c));
    expect(breakerCheck(breakerNeed(takenOff), TICKET).lines).toEqual(["One 1P 20A Spare."]);
    const suggested = FINAL_MAP.map((c) => (c.description === "Floor Heat" ? { ...c, state: "suggested" as const } : c));
    expect(breakerCheck(breakerNeed(suggested), TICKET).ok).toBe(true);
    const unsized = [...FINAL_MAP, circuit({ room: "Garage", description: "Freezer", amps: null })];
    const check = breakerCheck(breakerNeed(unsized), TICKET);
    expect(check.lines).toContain("One New Circuit Has No Amps Yet (Garage Freezer).");
    expect(check.ok).toBe(false);
  });

  it("an AFCI need is not covered by a plain breaker, and a dual-function covers it", () => {
    const need = breakerNeed([circuit({ room: "Bedroom", description: "Outlets", amps: 20, kind: "afci" })]);
    expect(breakerCheck(need, [{ qty: 1, form: "single", slots: [{ poles: 1, amps: 20, kind: null }] }]).lines).toEqual([
      "Short One 1P 20A AFCI (Bedroom Outlets).",
      "One 1P 20A Spare.",
    ]);
    expect(breakerCheck(need, [{ qty: 1, form: "single", slots: [{ poles: 1, amps: 20, kind: "dual_function" }] }]).ok).toBe(true);
  });
});

describe("reading the estimate", () => {
  it("parses the take-off's breaker words", () => {
    expect(parseQuoteBreaker("2P 30A")).toEqual({ poles: 2, amps: 30, check: null });
    expect(parseQuoteBreaker("20A")).toEqual({ poles: 1, amps: 20, check: null });
    expect(parseQuoteBreaker("2P 50A")).toEqual({ poles: 2, amps: 50, check: null });
    expect(parseQuoteBreaker("2P 30A CB")).toEqual({ poles: 2, amps: 30, check: null });
    expect(parseQuoteBreaker("double pole 20 amp")).toEqual({ poles: 2, amps: 20, check: null });
    expect(parseQuoteBreaker("Q120")).toEqual({ poles: 1, amps: 20, check: null });
    expect(parseQuoteBreaker("")).toBeNull();
    expect(parseQuoteBreaker("see panel")).toBeNull();
  });

  it("says out loud when the words and the Siemens part disagree (E-017's SP 15A [Q120])", () => {
    expect(parseQuoteBreaker("SP 15A [Q120]")).toEqual({ poles: 1, amps: 15, check: "The estimate says 1P 15A, but Q120 is a 1P 20A." });
    // A twin's number is not read as a 2-pole 20.
    expect(parseQuoteBreaker("Q2020")).toBeNull();
  });

  it("brings in E-017 as 12 suggestions, sized from the take-off, with no space set", () => {
    const s = quoteCircuitsToSuggestions({ id: E017_ID, quote_number: "E-017", circuits: E017 });
    expect(s).toHaveLength(12);
    expect(s.every((d) => d.state === "suggested" && d.source === "estimate" && d.source_quote_id === E017_ID)).toBe(true);
    expect(s.map((d) => `${d.poles}P ${d.amps}A`)).toEqual([
      ...Array(6).fill("1P 20A"),
      ...Array(4).fill("1P 15A"),
      "2P 50A",
      "2P 30A",
    ]);
    expect(s[0].room).toBe("Kitchen");
    expect(s[4].room).toBe("Bath");
    expect(s[10].room).toBeNull(); // "Range": no room named, none guessed
    expect(s[0].source_row).toMatchObject({ quote_number: "E-017", ckt: "1", load: "Countertop GFCI receptacles" });
    expect(new Set(s.map((d) => d.source_row.key)).size).toBe(12);
    expect(s.map((d) => d.sort_order)).toEqual([...Array(12).keys()]);
  });

  it("a second Bring In adds nothing, and a Not This stays set aside", () => {
    const drafts = quoteCircuitsToSuggestions({ id: E017_ID, quote_number: "E-017", circuits: E017 });
    const onJob = drafts.map((d, i) => ({ source_quote_id: d.source_quote_id, source_row: d.source_row, removed_at: i === 2 ? "2026-09-25T09:00:00Z" : null }));
    expect(newSuggestionsOnly(drafts, onJob)).toEqual({ fresh: [], already: 11, setAside: 1 });
    expect(newSuggestionsOnly(drafts, []).fresh).toHaveLength(12);
  });

  it("finds the job's own estimate first, then the customer's unattached ones, only with circuits", () => {
    const got = rankEstimateCandidates(J011, "cust", [
      { id: "a", quote_number: "E-001", job_id: null, customer_id: "cust", circuits: E017, created_at: "2026-09-01" },
      { id: "b", quote_number: "E-002", job_id: J011, customer_id: "cust", circuits: [E017[0]], created_at: "2026-08-01" },
      { id: "c", quote_number: "E-003", job_id: null, customer_id: "cust", circuits: null },
      { id: "d", quote_number: "E-004", job_id: "other-job", customer_id: "cust", circuits: E017 },
      { id: "e", quote_number: "E-005", job_id: null, customer_id: "someone-else", circuits: E017 },
    ]);
    expect(got.map((g) => [g.quote_number, g.count])).toEqual([
      ["E-002", 1],
      ["E-001", 12],
    ]);
  });
});

describe("where circuits sit", () => {
  it("a 2P covers s and s+2; a quad's inner 2P at 25B covers 25B and 27B", () => {
    expect(slotsOf({ space: 25, half: null, poles: 2 })).toEqual([
      { space: 25, half: null },
      { space: 27, half: null },
    ]);
    expect(slotsOf({ space: 25, half: "B", poles: 2 })).toEqual([
      { space: 25, half: "B" },
      { space: 27, half: "B" },
    ]);
    expect(slotsOf({ space: null, half: null, poles: 1 })).toEqual([]);
  });

  it("the Q21530CT quad at 25/27 sits clean: outer 15s on the A halves, inner 2P 30 on the B halves", () => {
    const panel = { ...PANEL, twin_spaces: [25, 27] };
    const quad = [
      circuit({ room: "Bath", description: "Bath Lights", amps: 15, space: 25, half: "A" }),
      circuit({ room: "Bedroom", description: "Lights", amps: 15, space: 27, half: "A" }),
      circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, space: 25, half: "B" }),
    ];
    const map = spaceMap(panel, quad);
    expect(map.warnings).toEqual([]);
    expect(map.cells.get(25)).toEqual({ A: [quad[0].id], B: [quad[2].id], full: [] });
    expect(map.cells.get(27)).toEqual({ A: [quad[1].id], B: [quad[2].id], full: [] });
    expect(map.placed).toBe(3);
  });

  it("warns — never refuses — on two circuits in one space, a tandem the label doesn't allow, and No Stab", () => {
    const panel = { ...PANEL, spaces: 12, dead_spaces: [9], twin_spaces: [1, 3] };
    const a = circuit({ room: "Kitchen", description: "Outlets Right", amps: 20, space: 5 });
    const b = circuit({ room: "Kitchen", description: "Outlets Left", amps: 20, space: 5, half: "A" });
    const t = circuit({ room: "Bar", description: "Bar", amps: 20, space: 7, half: "B" });
    const d = circuit({ room: "Stairs", description: "Dedicated", amps: 20, space: 9 });
    const e = circuit({ room: "Laundry", description: "Dryer", amps: 30, poles: 2, space: 11 });
    const s = circuit({ room: "Garage", description: "Suggested", amps: 20, space: 5, state: "suggested" });
    const map = spaceMap(panel, [a, b, t, d, e, s]);
    const words = map.warnings.map((w) => w.message);
    expect(words).toContain("Space 5 has Kitchen Outlets Right and Kitchen Outlets Left on it.");
    expect(words).toContain("Bar is a tandem on space 7, and the panel label doesn't allow tandems there.");
    expect(words).toContain("Stairs Dedicated is on space 9, which has No Stab.");
    expect(words).toContain("Laundry Dryer runs to space 13, past the end of this 12-space panel.");
    // The suggestion occupies nothing.
    expect(map.placed).toBe(5);
  });

  it("the door: odd down the left, even down the right, flipped when the numbers run bottom up", () => {
    expect(doorRows({ spaces: 6, numbering: "top_down" })).toEqual([
      { left: 1, right: 2 },
      { left: 3, right: 4 },
      { left: 5, right: 6 },
    ]);
    expect(doorRows({ spaces: 4, numbering: "bottom_up" })).toEqual([
      { left: 3, right: 4 },
      { left: 1, right: 2 },
    ]);
  });

  it("a quad space is free only on a tandem-rated pair with nothing on it", () => {
    const panel = { ...PANEL, spaces: 8, twin_spaces: [5, 7] };
    expect(quadSpaceFree(panel, spaceMap(panel, []))).toBe(true);
    const taken = spaceMap(panel, [circuit({ room: "Bar", description: "Bar", amps: 20, space: 7 })]);
    expect(quadSpaceFree(panel, taken)).toBe(false);
    expect(quadSpaceFree({ ...panel, twin_spaces: [] }, spaceMap(panel, []))).toBe(false);
  });
});

describe("the list", () => {
  it("groups by room in the order rooms first appear, unroomed last", () => {
    const groups = groupByRoom([...FINAL_MAP, circuit({ room: null, description: "Mystery" })]);
    expect(groups.map((g) => g.room)).toEqual(["Bath", "Bedroom", "Kitchen", "Bar", "Living", "Office", "Laundry", "Stairs", NO_ROOM]);
    expect(groups.find((g) => g.room === "Kitchen")!.circuits).toHaveLength(6);
  });

  it("reads a line the way the plan does: 20A · 1P · Outlets Right", () => {
    expect(circuitLine(FINAL_MAP[3])).toBe("20A · 1P · Outlets Right");
    expect(circuitName(FINAL_MAP[3])).toBe("Kitchen Outlets Right");
    expect(circuitLine(FINAL_MAP[21])).toBe("50A · 2P · GFCI · Range");
  });

  it("flags the door label that differs from what the circuit feeds, and not a punctuation difference", () => {
    const entry = FINAL_MAP[2];
    expect(labelDiffers(entry)).toBe(true);
    expect(labelDiffersWords(entry)).toBe("The door says Entry Lights, but it feeds Kitchen And Living Lights.");
    expect(labelDiffers({ panel_label: "Kitchen + Living", description: "kitchen and living" })).toBe(false);
    expect(labelDiffers({ panel_label: null, description: "Fridge" })).toBe(false);
  });

  it("one tap moves Planned → Roughed → Done → Planned", () => {
    expect(nextProgress("planned")).toBe("roughed");
    expect(nextProgress("roughed")).toBe("done");
    expect(nextProgress("done")).toBe("planned");
  });
});
