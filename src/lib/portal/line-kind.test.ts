import { describe, it, expect } from "vitest";
import { LINE_GROUP_LABEL, isHoursUnit, lineGroup, sectionLines } from "./line-kind";
import { groupInvoiceLines } from "@/lib/invoice-math";

describe("which group a line is in: what it stored first, and a typed line by the /i rule", () => {
  it("each importer's source is its group", () => {
    expect(lineGroup({ import_source: "labor" })).toBe("labor");
    expect(lineGroup({ import_source: "costs" })).toBe("materials");
    expect(lineGroup({ import_source: "change_orders" })).toBe("change_orders");
    expect(lineGroup({ import_source: "quote" })).toBe("estimate");
    expect(lineGroup({ import_source: "milestone" })).toBe("contract");
    expect(lineGroup({ import_source: "draw_credit" })).toBe("credit");
    expect(lineGroup({ import_source: "something_new" })).toBe("other");
    // A stored source wins over the words.
    expect(lineGroup({ import_source: "change_orders", description: "Labor - add a circuit" })).toBe("change_orders");
  });

  it("a deposit bill's own lines are the Deposit, whatever they say", () => {
    expect(lineGroup({ import_source: null, unit: "hr" }, "deposit")).toBe("deposit");
    expect(lineGroup({ import_source: null, unit: "lot", description: "Materials deposit" }, "deposit")).toBe("deposit");
  });

  it("a typed line: billed in hours, or worded Labor / Materials, the same as the /i Cost Breakdown", () => {
    const typed = (description: string, unit = "ea") => ({ import_source: null, unit, description });
    // The live lines the review found under Other (INV-059, J-006, J-010, J-032).
    expect(lineGroup(typed("Labor - Erik "))).toBe("labor");
    expect(lineGroup(typed("Labor - Brian"))).toBe("labor");
    expect(lineGroup(typed("Erik Labor"))).toBe("labor");
    expect(lineGroup(typed("Materials"))).toBe("materials");
    expect(lineGroup(typed("Material: Wire, boxes, GFCI, Faceplate"))).toBe("materials");
    expect(lineGroup(typed("Materials — CED"))).toBe("materials");
    expect(lineGroup(typed("Labor: travel"))).toBe("labor");
    expect(lineGroup(typed("Saturday callout", " Hrs "))).toBe("labor");
    expect(lineGroup(typed("Less previous billings", "lot"))).toBe("credit");
    // What the words do not settle stays Other: never guessed at.
    expect(lineGroup(typed("Emergency service call"))).toBe("other");
    expect(lineGroup(typed("10/3 romex"))).toBe("other");
    expect(lineGroup(typed("Labor and materials"))).toBe("other");
    expect(lineGroup(typed("Permit fee"))).toBe("other");
    expect(lineGroup({ import_source: null, unit: null })).toBe("other");
  });

  it("the portal and groupInvoiceLines file every typed line in the same place", () => {
    const words = ["Labor - Erik ", "Erik Labor", "Materials", "Material: Wire", "Less previous billings", "Permit fee", "10/3 romex", "Labor and materials"];
    for (const description of words) {
      for (const unit of ["ea", "hrs"]) {
        const line = { description, unit, import_source: null, line_total: 10 };
        const g = groupInvoiceLines([line]);
        const bucket = g.labor.lines.length ? "labor" : g.materials.lines.length ? "materials" : g.credits.lines.length ? "credit" : "other";
        expect([description, unit, lineGroup(line)]).toEqual([description, unit, bucket]);
      }
    }
  });

  it("hours units", () => {
    for (const u of ["hr", "hrs", "hour", "Hours", "man-hours", "manhour"]) expect(isHoursUnit(u)).toBe(true);
    for (const u of ["ea", "lot", "", null, "hrly"]) expect(isHoursUnit(u)).toBe(false);
  });

  it("sections come in one order, keep each line's order inside, and subtotal to the cent", () => {
    const s = sectionLines([
      { import_source: "costs", line_total: 0.1, n: 1 },
      { import_source: "labor", line_total: 100, n: 2 },
      { import_source: null, unit: "ea", description: "Discount", line_total: -5, n: 3 },
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
