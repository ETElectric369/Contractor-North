import { describe, it, expect } from "vitest";
import { parseInspectionSchema, coerceAnswers, unansweredFields, answersForEstimator, measurementsFromAnswers, type InspectionField } from "./schema";

const fields: InspectionField[] = [
  { key: "run_ft", label: "Run from panel", type: "number" },
  { key: "panel_amps", label: "Existing panel", type: "select", options: ["100A", "200A", "400A"] },
  { key: "attic_access", label: "Attic access", type: "checkbox" },
  { key: "notes", label: "Anything else", type: "textarea" },
];

describe("a number field holds a number", () => {
  it("strips the units a person actually types on a phone", () => {
    expect(coerceAnswers(fields, { run_ft: "85 ft" }).run_ft).toBe(85);
    expect(coerceAnswers(fields, { run_ft: "1,200" }).run_ft).toBe(1200);
    expect(coerceAnswers(fields, { run_ft: " 9.5 " }).run_ft).toBe(9.5);
  });

  it("unparseable becomes null, NOT NaN", () => {
    // NaN is the dangerous outcome: it survives three function calls and produces a wrong
    // estimate with no error anywhere. null is visible.
    const a = coerceAnswers(fields, { run_ft: "a while" });
    expect(a.run_ft).toBeNull();
    expect(Number.isNaN(a.run_ft as number)).toBe(false);
  });
});

describe("answers are constrained to the schema", () => {
  it("keys the template doesn't declare are dropped", () => {
    // These are written from a client form; accepting unknown keys would let a crafted payload
    // stuff arbitrary jsonb onto the appointment row.
    const a = coerceAnswers(fields, { run_ft: 10, evil: "payload", __proto__: "x" });
    expect(a).not.toHaveProperty("evil");
    expect(Object.keys(a).sort()).toEqual(["attic_access", "notes", "panel_amps", "run_ft"]);
  });

  it("a select value outside its options is refused, not stored", () => {
    expect(coerceAnswers(fields, { panel_amps: "600A" }).panel_amps).toBeNull();
    expect(coerceAnswers(fields, { panel_amps: "200A" }).panel_amps).toBe("200A");
  });

  it("checkbox accepts every shape an HTML form can send", () => {
    for (const v of [true, "true", "on", 1, "1"]) {
      expect(coerceAnswers(fields, { attic_access: v }).attic_access).toBe(true);
    }
    for (const v of [false, "false", "", undefined]) {
      expect(coerceAnswers(fields, { attic_access: v }).attic_access).toBeFalsy();
    }
  });

  it("long text is capped so one answer can't bloat the row", () => {
    const a = coerceAnswers(fields, { notes: "x".repeat(20000) });
    expect(String(a.notes).length).toBe(8000);
  });
});

describe("the schema parser survives bad data", () => {
  it("non-array input yields no fields rather than throwing", () => {
    expect(parseInspectionSchema(null)).toEqual([]);
    expect(parseInspectionSchema("nope")).toEqual([]);
  });
  it("drops malformed rows and duplicate keys, keeps the good ones", () => {
    const parsed = parseInspectionSchema([
      { key: "a", label: "A", type: "number" },
      { key: "a", label: "Dup", type: "text" },
      { key: "", label: "No key", type: "text" },
      { key: "b", label: "B", type: "bogus" },
      { key: "c", label: "C", type: "select", options: ["x", "y"] },
    ]);
    expect(parsed.map((f) => f.key)).toEqual(["a", "c"]);
    expect(parsed[1].options).toEqual(["x", "y"]);
  });
});

describe("what's still missing is computed, not guessed", () => {
  it("lists only genuinely unanswered questions", () => {
    const answers = coerceAnswers(fields, { run_ft: 85, panel_amps: "200A" });
    // coerce fills every declared key, so an explicit null is the gap signal.
    expect(unansweredFields(fields, answers).map((f) => f.key)).toEqual(["notes"]);
  });

  it("an UNCHECKED checkbox is an answer ('no'), not a gap", () => {
    const answers = coerceAnswers(fields, { attic_access: false });
    expect(unansweredFields(fields, answers).map((f) => f.key)).not.toContain("attic_access");
  });
});

describe("the estimator receives labelled facts, not prose to re-parse", () => {
  it("renders answered fields with their labels", () => {
    const out = answersForEstimator(fields, coerceAnswers(fields, { run_ft: 85, panel_amps: "200A", attic_access: true }));
    expect(out).toContain("Run from panel: 85");
    expect(out).toContain("Existing panel: 200A");
    expect(out).toContain("Attic access: yes");
  });
  it("omits unanswered fields rather than emitting blanks", () => {
    const out = answersForEstimator(fields, coerceAnswers(fields, { run_ft: 85 }));
    expect(out).not.toContain("Anything else");
  });
  it("returns empty when nothing was answered, so the caller can skip the section", () => {
    expect(answersForEstimator(fields, coerceAnswers(fields, {}))).toBe("");
  });
});

/**
 * THE JOIN between a walk-through and a priced line. If this returns a wrong number, every
 * coefficient line in the kit is wrong by the same factor and the estimate looks perfectly
 * plausible — which is the failure mode that actually reaches a customer.
 */
describe("measurements a kit can size itself from", () => {
  const deck: InspectionField[] = [
    { key: "length_ft", label: "Length (ft)", type: "number" },
    { key: "width_ft", label: "Width / depth (ft)", type: "number" },
    { key: "railing_lf", label: "Railing (linear ft)", type: "number" },
    { key: "notes", label: "Notes", type: "textarea" },
  ];

  it("derives area from length x width", () => {
    const a = coerceAnswers(deck, { length_ft: 20, width_ft: 15 });
    expect(measurementsFromAnswers(deck, a).sqft).toBe(300);
  });

  it("uses the measured railing run when there is one", () => {
    const a = coerceAnswers(deck, { length_ft: 20, width_ft: 15, railing_lf: 46 });
    expect(measurementsFromAnswers(deck, a).linearFt).toBe(46);
  });

  it("falls back to the footprint's perimeter for linear feet", () => {
    // Railing runs along the edge, so the perimeter is the honest default when nobody measured it.
    const a = coerceAnswers(deck, { length_ft: 20, width_ft: 15 });
    expect(measurementsFromAnswers(deck, a).linearFt).toBe(70);
  });

  it("HALF a rectangle is not an area — one missing side yields null, never a guess", () => {
    // Treating a missing width as 1 would under-size every coefficient line in the kit, quietly.
    const a = coerceAnswers(deck, { length_ft: 20 });
    expect(measurementsFromAnswers(deck, a).sqft).toBeNull();
  });

  it("an explicit area beats the derived one", () => {
    const withArea: InspectionField[] = [...deck, { key: "deck_sqft", label: "Deck area (sq ft)", type: "number" }];
    const a = coerceAnswers(withArea, { length_ft: 20, width_ft: 15, deck_sqft: 260 });
    expect(measurementsFromAnswers(withArea, a).sqft).toBe(260);
  });

  it("nothing measured yields nulls, not zeros", () => {
    // A zero would size every line to zero and read as a real, free estimate.
    const m = measurementsFromAnswers(deck, coerceAnswers(deck, {}));
    expect(m.sqft).toBeNull();
    expect(m.linearFt).toBeNull();
  });

  it("works on a sheet somebody typed themselves, with different keys", () => {
    // The sheet is per-org DATA — it must not require one blessed schema to be useful.
    const custom: InspectionField[] = [
      { key: "how_long", label: "Length of the deck in feet", type: "number" },
      { key: "how_wide", label: "Width in feet", type: "number" },
    ];
    const m = measurementsFromAnswers(custom, coerceAnswers(custom, { how_long: 10, how_wide: 12 }));
    expect(m.sqft).toBe(120);
  });
})
