import { describe, it, expect } from "vitest";
import { normalizeUnit, sameUnit, isHoursUnit, UNIT_SUGGESTIONS } from "./units";

describe("normalizeUnit — one vocabulary", () => {
  it("collapses the spellings the three books actually contain", () => {
    expect(normalizeUnit("EA")).toBe("ea");
    expect(normalizeUnit("each")).toBe("ea");
    expect(normalizeUnit("SQ FT")).toBe("sq ft");
    expect(normalizeUnit("sqft")).toBe("sq ft");
    expect(normalizeUnit("LF")).toBe("ft");
    expect(normalizeUnit("lin ft")).toBe("ft");
    expect(normalizeUnit("hrs")).toBe("hr");
    expect(normalizeUnit("  Box ")).toBe("box");
  });
  it("keeps an unknown unit verbatim (suggestions, never a limit) and defaults blank to ea", () => {
    expect(normalizeUnit("pallet")).toBe("pallet");
    expect(normalizeUnit("")).toBe("ea");
    expect(normalizeUnit(null)).toBe("ea");
  });
  it("compares across spellings", () => {
    expect(sameUnit("LF", "ft")).toBe(true);
    expect(sameUnit("EA", "sq ft")).toBe(false);
    expect(isHoursUnit("man-hr")).toBe(true);
    expect(isHoursUnit("ea")).toBe(false);
  });
  it("every suggestion normalizes to itself", () => {
    for (const u of UNIT_SUGGESTIONS) expect(normalizeUnit(u)).toBe(u);
  });
});
