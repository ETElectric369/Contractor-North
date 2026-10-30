import { describe, it, expect } from "vitest";
import { DOOR_DEFAULTS, UNKNOWN_DOOR, brandDefaults, doorFamily, panelGeometry, parseInches } from "./geometry";

/** The door's two measurements: the make's default from ONE table, the panel's own when measured. */
describe("brandDefaults: one table, read the way the Breakers card reads a make", () => {
  it("an inch a space for every make it knows but the CH, which is three quarters", () => {
    for (const b of ["Siemens", "Square D QO", "Square D Homeline", "Eaton BR", "Cutler-Hammer BR", "Murray", "GE PowerMark"]) {
      expect(brandDefaults(b).pitchIn).toBe(1);
    }
    expect(brandDefaults("Eaton CH")).toEqual({ pitchIn: 0.75, labelWidthIn: 1 });
    expect(brandDefaults("Cutler-Hammer CH")).toEqual({ pitchIn: 0.75, labelWidthIn: 1 });
  });

  it("a 1.125 in label area on a Siemens door, an inch on every other (Murray is its own row)", () => {
    expect(brandDefaults("Siemens")).toEqual({ pitchIn: 1, labelWidthIn: 1.125 });
    expect(brandDefaults("SIEMENS PN Series")).toEqual({ pitchIn: 1, labelWidthIn: 1.125 });
    expect(brandDefaults("siemens")).toEqual({ pitchIn: 1, labelWidthIn: 1.125 });
    expect(doorFamily("Murray")).toBe("murray");
    expect(brandDefaults("Murray")).toEqual({ pitchIn: 1, labelWidthIn: 1 });
    expect(brandDefaults("Square D Homeline").labelWidthIn).toBe(1);
  });

  it("unknown, blank, or not named well enough to tell (a bare Eaton) reads an inch and an inch", () => {
    for (const b of [null, undefined, "", "Zinsco", "Eaton", "Square D"]) expect(brandDefaults(b)).toEqual(UNKNOWN_DOOR);
    expect(UNKNOWN_DOOR).toEqual({ pitchIn: 1, labelWidthIn: 1 });
    // A caller can't bend the table through the copy it gets back.
    brandDefaults("Siemens").pitchIn = 9;
    expect(DOOR_DEFAULTS.siemens.pitchIn).toBe(1);
  });
});

describe("panelGeometry: the panel's own numbers where a person measured them", () => {
  it("falls back to the make's, and the right strip to the left's", () => {
    expect(panelGeometry({ brand: "Siemens", space_pitch_in: null, label_width_in: null, label_width_in_right: null })).toEqual({
      pitchIn: 1,
      labelWidthLeftIn: 1.125,
      labelWidthRightIn: 1.125,
    });
    expect(panelGeometry({ brand: "Eaton CH" })).toEqual({ pitchIn: 0.75, labelWidthLeftIn: 1, labelWidthRightIn: 1 });
  });

  it("stored measurements win, each on its own; a numeric that comes back as a string still reads", () => {
    expect(panelGeometry({ brand: "Siemens", space_pitch_in: 0.875, label_width_in: 1.25, label_width_in_right: null })).toEqual({
      pitchIn: 0.875,
      labelWidthLeftIn: 1.25,
      labelWidthRightIn: 1.25,
    });
    expect(
      panelGeometry({ brand: null, space_pitch_in: "1.0" as unknown as number, label_width_in: 1, label_width_in_right: 1.5 }),
    ).toEqual({ pitchIn: 1, labelWidthLeftIn: 1, labelWidthRightIn: 1.5 });
  });
});

describe("parseInches: a tape reading as inches", () => {
  it("reads decimals, mixed and plain fractions, with or without the unit", () => {
    expect(parseInches("1.125")).toBe(1.125);
    expect(parseInches("1 1/8")).toBe(1.125);
    expect(parseInches("1-1/8")).toBe(1.125);
    expect(parseInches("9/8")).toBe(1.125);
    expect(parseInches('3/4"')).toBe(0.75);
    expect(parseInches("1 in")).toBe(1);
    expect(parseInches(".75")).toBe(0.75);
    expect(parseInches(1.5)).toBe(1.5);
  });
  it("is null for anything that isn't a number of inches", () => {
    for (const v of ["", "  ", "wide", "1/0", "-1", null, undefined, {}, Number.NaN]) expect(parseInches(v)).toBeNull();
  });
});
