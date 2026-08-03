import { describe, it, expect } from "vitest";
import { lintInspectionSheet, severeSheetProblems } from "./lint";
import { STARTER_TRADES, starterSchemaJson } from "./starter-sheets";

/**
 * THE SHEET THIS FILE EXISTS BECAUSE OF — TAHOE DECK's, exactly as stored in production on
 * 2026-08-03. The router offers "Full replacement" and "Resurface (existing frame)"; six rules
 * point at "Deck replacement" and "Resurface". On six of eight job types those six questions
 * silently never render. One of twenty inspections there has any answers at all.
 */
const TAHOE_DECK_AS_STORED = [
  {
    key: "project_type", label: "What kind of job", type: "select",
    options: ["New deck", "Full replacement", "Resurface (existing frame)", "Extension", "Railing only", "Stairs only", "Repair", "Staining"],
  },
  { key: "material", label: "Decking material", type: "select", options: ["Wood", "Composite"] },
  { key: "length_ft", label: "Length (ft)", type: "number" },
  { key: "width_ft", label: "Width / depth (ft)", type: "number" },
  { key: "height_ft", label: "Height at the tallest point (ft)", type: "number" },
  { key: "shape", label: "Shape", type: "select", options: ["Rectangle", "Irregular"], showIf: { key: "project_type", in: ["New deck", "Deck replacement", "Resurface", "Repair"] } },
  { key: "railing_lf", label: "Railing (linear ft)", type: "number", showIf: { key: "project_type", in: ["New deck", "Deck replacement", "Resurface", "Repair"] } },
];

describe("the bug that made a man stop using his own form", () => {
  const problems = lintInspectionSheet(TAHOE_DECK_AS_STORED);

  it("catches the values that can never match", () => {
    const bad = problems.filter((p) => p.kind === "unmatchable_value");
    expect(bad.map((p) => p.key).sort()).toEqual(["railing_lf", "shape"]);
    expect(bad.every((p) => p.severe)).toBe(true);
  });

  it("names the wrong value AND the real choices, in the contractor's words", () => {
    // A message that says "invalid showIf.in" tells the person nothing. It has to say which
    // words are wrong and which words are right, because they are the one who must fix it.
    const m = problems.find((p) => p.kind === "unmatchable_value")!.message;
    expect(m).toContain("Deck replacement");
    expect(m).toContain("Full replacement");
    expect(m).not.toMatch(/showIf|schema|null|undefined/);
  });

  it("also notices you land on five questions before saying what the job is", () => {
    expect(problems.some((p) => p.kind === "wall")).toBe(true);
  });
});

describe("rules that point nowhere", () => {
  it("a rule naming a question that doesn't exist", () => {
    const p = severeSheetProblems([
      { key: "a", label: "A", type: "text" },
      { key: "b", label: "B", type: "text", showIf: { key: "nope", in: ["x"] } },
    ]);
    expect(p).toHaveLength(1);
    expect(p[0].kind).toBe("orphan_rule");
  });

  it("a rule pointing at a LATER question — unsatisfiable at the moment it is checked", () => {
    const p = severeSheetProblems([
      { key: "first", label: "First", type: "text", showIf: { key: "later", in: ["x"] } },
      { key: "later", label: "Later", type: "select", options: ["x"] },
    ]);
    expect(p.map((x) => x.kind)).toEqual(["forward_rule"]);
  });

  it("a rule against a free-text field is left alone — there is no option list to check", () => {
    // Only a select has a closed set. Flagging a text-gated rule would be a false alarm, and a
    // linter that cries wolf gets ignored, which costs more than the rule it was guarding.
    expect(
      severeSheetProblems([
        { key: "brand", label: "Brand", type: "text" },
        { key: "notes", label: "Notes", type: "textarea", showIf: { key: "brand", in: ["Zinsco"] } },
      ]),
    ).toEqual([]);
  });
});

describe("shape advice, never severe", () => {
  it("a router option that reveals nothing is a dead end", () => {
    const p = lintInspectionSheet([
      { key: "t", label: "Type", type: "select", options: ["A", "B"] },
      { key: "x", label: "X", type: "text", showIf: { key: "t", in: ["A"] } },
    ]);
    const dead = p.filter((q) => q.kind === "dead_branch");
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toContain("“B”");
    expect(dead[0].severe).toBe(false);
  });

  it("a sheet with no conditional questions at all", () => {
    const p = lintInspectionSheet([
      { key: "a", label: "A", type: "text" },
      { key: "b", label: "B", type: "text" },
      { key: "c", label: "C", type: "text" },
      { key: "d", label: "D", type: "text" },
    ]);
    expect(p.some((q) => q.kind === "no_router")).toBe(true);
    expect(p.every((q) => !q.severe)).toBe(true);
  });

  it("never blocks: shape problems are advice, so a half-built sheet still saves", () => {
    const p = lintInspectionSheet([{ key: "a", label: "A", type: "text" }]);
    expect(p.filter((q) => q.severe)).toEqual([]);
  });
});

describe("the sheets we ship are clean by our own linter", () => {
  it.each(STARTER_TRADES)("%s has zero problems of any kind", (trade) => {
    // If the starters can't pass this, the linter is wrong or the starters are — either way
    // it is caught here rather than by a contractor on a ladder.
    expect(lintInspectionSheet(starterSchemaJson(trade))).toEqual([]);
  });
});

describe("an empty or unparseable sheet says nothing", () => {
  it("no fields, no complaints — that is the empty state's job, not the linter's", () => {
    expect(lintInspectionSheet([])).toEqual([]);
    expect(lintInspectionSheet(null)).toEqual([]);
    expect(lintInspectionSheet("garbage")).toEqual([]);
  });
});
