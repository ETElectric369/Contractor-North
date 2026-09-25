import { describe, it, expect } from "vitest";
import { LINE_GROUP_LABEL, isHoursUnit, lineGroup, sectionLines } from "./line-kind";

describe("which group a line is in: what it stored, never its words", () => {
  it("each importer's source is its group", () => {
    expect(lineGroup({ import_source: "labor" })).toBe("labor");
    expect(lineGroup({ import_source: "costs" })).toBe("materials");
    expect(lineGroup({ import_source: "change_orders" })).toBe("change_orders");
    expect(lineGroup({ import_source: "quote" })).toBe("estimate");
    expect(lineGroup({ import_source: "milestone" })).toBe("contract");
    expect(lineGroup({ import_source: "draw_credit" })).toBe("credit");
    expect(lineGroup({ import_source: "something_new" })).toBe("other");
  });

  it("a hand-typed line is Other, unless the office billed it in hours or it is a deposit bill's own line", () => {
    expect(lineGroup({ import_source: null, unit: "ea" })).toBe("other");
    expect(lineGroup({ import_source: null, unit: null })).toBe("other");
    expect(lineGroup({ import_source: null, unit: " Hrs " })).toBe("labor");
    expect(lineGroup({ import_source: null, unit: "hr" }, "deposit")).toBe("deposit");
    expect(lineGroup({ import_source: null, unit: "lot" }, "deposit")).toBe("deposit");
    // The words are never read: a line that says "Labor" or "Materials" but stored nothing is Other.
    const worded = (description: string) => ({ import_source: null, unit: "ea", description });
    expect(lineGroup(worded("Labor - extra hour"))).toBe("other");
    expect(lineGroup(worded("Materials — CED"))).toBe("other");
  });

  it("hours units", () => {
    for (const u of ["hr", "hrs", "hour", "Hours", "man-hours", "manhour"]) expect(isHoursUnit(u)).toBe(true);
    for (const u of ["ea", "lot", "", null, "hrly"]) expect(isHoursUnit(u)).toBe(false);
  });

  it("sections come in one order, keep each line's order inside, and subtotal to the cent", () => {
    const s = sectionLines([
      { import_source: "costs", line_total: 0.1, n: 1 },
      { import_source: "labor", line_total: 100, n: 2 },
      { import_source: null, unit: "ea", line_total: -5, n: 3 },
      { import_source: "costs", line_total: 0.2, n: 4 },
      { import_source: "draw_credit", line_total: "-50.00", n: 5 },
    ]);
    expect(s.map((x) => [x.label, x.subtotal, x.lines.map((l) => l.n)])).toEqual([
      ["Labor", 100, [2]],
      ["Materials", 0.3, [1, 4]],
      ["Credits", -50, [5]],
      ["Other", -5, [3]],
    ]);
    expect(LINE_GROUP_LABEL.labor).toBe("Labor");
  });
});
