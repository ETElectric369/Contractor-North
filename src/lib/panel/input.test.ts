import { describe, it, expect } from "vitest";
import { normalizeCircuitPatch, normalizePanelPatch, parseSpaceList } from "./input";

/** What a circuit or panel write may carry: the form's fields only, in plain words when refused. */
describe("circuit writes carry only what the form offers", () => {
  it("keeps the edit fields and tidies the words", () => {
    const r = normalizeCircuitPatch({ room: "  kitchen ", description: "Outlets  Right", amps: "20", poles: 1, kind: "afci", space: "7", half: "B", work: "reused" });
    expect(r).toEqual({ ok: true, value: { room: "kitchen", description: "Outlets Right", amps: 20, poles: 1, kind: "afci", space: 7, half: "B", work: "reused" } });
  });

  it("refuses anything with a price, a part number, a stamp or provenance on it", () => {
    for (const k of ["est_cost", "part_number", "verified_by", "org_id", "source", "state", "source_quote_id", "removed_at"]) {
      expect(normalizeCircuitPatch({ [k]: "x" })).toEqual({ ok: false, error: "That isn't something a circuit keeps." });
    }
  });

  it("says what's wrong in plain words", () => {
    expect(normalizeCircuitPatch({ amps: 17 })).toEqual({ ok: false, error: "17 amps isn't a breaker size. Pick 15, 20, 30…" });
    expect(normalizeCircuitPatch({ poles: 4 })).toEqual({ ok: false, error: "A breaker is 1, 2 or 3 poles." });
    expect(normalizeCircuitPatch({ space: 0 })).toEqual({ ok: false, error: "The space has to be a whole number from 1 to 84." });
    expect(normalizeCircuitPatch({ half: "C" })).toEqual({ ok: false, error: "The half is A or B." });
  });

  it("clearing the space clears the half", () => {
    expect(normalizeCircuitPatch({ space: "" })).toEqual({ ok: true, value: { space: null, half: null } });
  });
});

describe("panel writes", () => {
  it("never carry the customer's-page switch", () => {
    expect(normalizePanelPatch({ shown_on_portal: true })).toEqual({ ok: false, error: "That isn't something a panel keeps." });
  });
  it("read space lists the way a person types them", () => {
    expect(parseSpaceList("25, 27 25")).toEqual({ ok: true, value: [25, 27] });
    expect(parseSpaceList("")).toEqual({ ok: true, value: [] });
    expect(parseSpaceList("9, x")).toEqual({ ok: false, error: 'Spaces are numbers from 1 to 84. "x" isn\'t one.' });
    expect(normalizePanelPatch({ dead_spaces: "9", spaces: "32", numbering: "bottom_up", name: " Main Panel " })).toEqual({
      ok: true,
      value: { name: "Main Panel", spaces: 32, numbering: "bottom_up", dead_spaces: [9] },
    });
  });
  it("a panel always has a name", () => {
    expect(normalizePanelPatch({ name: "  " })).toEqual({ ok: false, error: "Give the panel a name (Main Panel)." });
  });
});
