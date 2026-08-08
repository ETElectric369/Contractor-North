import { describe, it, expect } from "vitest";
import { READ_SYSTEM, coerceProposals, defaultTicked, duplicateCount } from "./proposals";

/**
 * The fixture is Sara Cain's real report (10410 Badger Ln B, Saturno Inspections, 49 pages) — the
 * job Erik was estimating when this was built. 5.1.1 and 8.1.1 are the SAME defect filed in two
 * sections, which is exactly the trap: estimate straight off the report and you bill it twice.
 */
const RAW = {
  items: [
    { kind: "scope", text: "Light did not turn on — upstairs, living room, dining room", from: { where: "page 18, item 5.1.1", quote: "LIGHT DID NOT TURN ON / MULTIPLE LOCATIONS" } },
    { kind: "scope", text: "Loose outlet in the living room", from: { where: "page 18, item 5.1.2", quote: "The outlet is loose and should be tightened to the junction box." } },
    { kind: "scope", text: "Damaged switch, entry level bathroom", from: { where: "page 27, item 7.1.1", quote: "Switch is damaged but is still operable." } },
    { kind: "scope", text: "Light did not turn on — upstairs, living room, dining room", from: { where: "page 32, item 8.1.1", quote: "LIGHT DID NOT TURN ON / MULTIPLE LOCATIONS" } },
    { kind: "note", text: "Contractor lock box at the front door", from: { where: "page 1", quote: "lock box at the front door" } },
  ],
};

describe("PROVENANCE OR NOTHING — the law that makes a tick-list checkable", () => {
  it("drops any item that can't point at where it came from", () => {
    const out = coerceProposals({
      items: [
        { kind: "scope", text: "Rewire the whole house", from: { where: "", quote: "" } },
        { kind: "scope", text: "No source at all" },
        { kind: "scope", text: "Quote but no location", from: { quote: "something" } },
        { kind: "scope", text: "Real one", from: { where: "page 4", quote: "the actual words" } },
      ],
    });
    expect(out.map((p) => p.text)).toEqual(["Real one"]);
  });

  it("keeps the source's OWN words, not a paraphrase we can't check", () => {
    const out = coerceProposals(RAW);
    expect(out[1].from).toEqual({
      where: "page 18, item 5.1.2",
      quote: "The outlet is loose and should be tightened to the junction box.",
    });
  });

  it("takes a bare array as happily as { items: [...] }", () => {
    expect(coerceProposals(RAW.items)).toHaveLength(5);
    expect(coerceProposals("nonsense")).toEqual([]);
    expect(coerceProposals(null)).toEqual([]);
  });
});

describe("THE DOUBLE-COUNT — the same defect filed twice", () => {
  const out = coerceProposals(RAW);

  it("keeps both, because the source really did say both, and marks the second", () => {
    expect(out).toHaveLength(5);
    expect(out[3].duplicateOf).toBe(out[0].id);
    expect(out[3].from.where).toBe("page 32, item 8.1.1"); // its own location survives
    expect(duplicateCount(out)).toBe(1);
  });

  it("but EVERYTHING stays ticked — a suspected duplicate is a question, not a verdict", () => {
    // Against the real report this dedup was wrong 3 times in 5: inspection boilerplate repeats
    // verbatim across genuinely separate defects (two carpets, three doors). A double-billed line
    // gets caught reading the estimate; a silently-unticked line becomes work that never happens.
    const ticked = defaultTicked(out);
    expect(ticked.size).toBe(out.length);
    expect(ticked.has(out[3].id)).toBe(true);
  });

  it("a different defect on the same page is NOT a duplicate", () => {
    expect(out[1].duplicateOf).toBeUndefined();
    expect(out[2].duplicateOf).toBeUndefined();
  });
});

describe("what Nort is told to do with a source", () => {
  it("forbids pricing — a guessed number laundered through a document is still a guess", () => {
    expect(READ_SYSTEM).toContain("NEVER PRICE ANYTHING");
  });

  it("forbids filtering by trade — deciding what's his is HIS call", () => {
    expect(READ_SYSTEM).toContain("DO NOT FILTER BY TRADE");
  });

  it("demands provenance in the same breath as the schema", () => {
    expect(READ_SYSTEM).toContain("EVERY ITEM MUST CARRY A REAL");
  });
});

describe("the dedup fingerprints the SOURCE's words, not the model's paraphrase", () => {
  /**
   * Run live against Sara Cain's real 49-page report, the first cut caught ZERO duplicates: the
   * model described 5.1.1 as "Interior lights not turning on…" and 8.1.1 differently, because a
   * paraphrase is free to vary. The report's own sentence is identical in both places. That is the
   * signal, and this is the fixture that proves it — both quotes verbatim from the PDF.
   */
  const REPEATED = "Replace light bulb. If a new bulb does not make the light turn on, contact a licensed electrical contractor for further evaluation.";

  it("catches the same defect filed in two sections, however it was worded", () => {
    const out = coerceProposals([
      { kind: "scope", text: "Interior lights not turning on, multiple locations", from: { where: "page 18, item 5.1.1", quote: REPEATED } },
      { kind: "scope", text: "Light did not turn on — kitchen area", from: { where: "page 32, item 8.1.1", quote: REPEATED } },
    ]);
    expect(out[1].duplicateOf).toBe(out[0].id);
    expect(defaultTicked(out).size).toBe(2); // flagged, both still ticked
  });

  it("but a SHORT quote falls back to the text — 'CRACKED TRIM' recurs under unrelated items", () => {
    const out = coerceProposals([
      { kind: "scope", text: "Cracked exterior trim, front", from: { where: "page 13, item 4.4.3", quote: "CRACKED TRIM" } },
      { kind: "scope", text: "Cracked trim around the garage door", from: { where: "page 20, item 5.5.1", quote: "CRACKED TRIM" } },
    ]);
    expect(out[1].duplicateOf).toBeUndefined();
  });
});
