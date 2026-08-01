import { describe, it, expect } from "vitest";
import {
  parseInspectionSchema,
  visibleFields,
  clearHiddenAnswers,
  unansweredFields,
  answersForEstimator,
  measurementsFromAnswers,
  coerceAnswers,
  type InspectionField,
} from "./schema";

/**
 * "the inspection page shouldn't start with the panel questions, those should come up if i choose
 * a panel" — Erik, standing at a job with a phone.
 *
 * The evidence he was right: of 28 inspections in production, 27 had no answers at all, and the
 * one that did answered 3 of 16 fields. Ten controls between a man and the Notes box is not a
 * form, it's a wall.
 */

const SHEET: InspectionField[] = parseInspectionSchema([
  { key: "work_type", label: "What kind of work", type: "select", options: ["Service/panel", "Lighting", "Troubleshoot"] },
  { key: "panel_brand", label: "Panel brand", type: "text", showIf: { key: "work_type", in: ["Service/panel"] } },
  { key: "run_ft", label: "Run (ft)", type: "number", measured: true, showIf: { key: "work_type", in: ["Lighting", "Service/panel"] } },
  { key: "permit", label: "Permit needed", type: "checkbox" },
]);

describe("the sheet fragments into the questions that apply", () => {
  it("before anything is chosen, only the unconditional questions show", () => {
    const v = visibleFields(SHEET, {}).map((f) => f.key);
    expect(v).toEqual(["work_type", "permit"]);
  });

  it("choosing Troubleshoot leaves TWO controls, not ten", () => {
    const v = visibleFields(SHEET, { work_type: "Troubleshoot" }).map((f) => f.key);
    expect(v).toEqual(["work_type", "permit"]);
  });

  it("choosing Service/panel reveals exactly the panel questions", () => {
    const v = visibleFields(SHEET, { work_type: "Service/panel" }).map((f) => f.key);
    expect(v).toEqual(["work_type", "panel_brand", "run_ft", "permit"]);
  });

  it("a field with a rule whose router is unanswered stays hidden", () => {
    expect(visibleFields(SHEET, { work_type: null }).map((f) => f.key)).toEqual(["work_type", "permit"]);
  });

  it("a malformed rule means ALWAYS SHOW, never never-show", () => {
    // A question nobody can reach is worse than one asked needlessly — you don't know it exists.
    const bad = parseInspectionSchema([
      { key: "a", label: "A", type: "text", showIf: { key: "", in: ["x"] } },
      { key: "b", label: "B", type: "text", showIf: { key: "a", in: [] } },
    ]);
    expect(bad.every((f) => f.showIf === undefined)).toBe(true);
    expect(visibleFields(bad, {}).map((f) => f.key)).toEqual(["a", "b"]);
  });
});

describe("switching the router cannot strand a stale answer", () => {
  it("THE BUG THIS PREVENTS: a panel brand riding into a lighting estimate", () => {
    const answered = { work_type: "Service/panel", panel_brand: "Siemens", run_ft: 85, permit: true };
    const switched = clearHiddenAnswers(SHEET, { ...answered, work_type: "Troubleshoot" });
    expect(switched.panel_brand).toBeNull();
    expect(switched.run_ft).toBeNull();
    expect(switched.permit).toBe(true); // unconditional, survives
  });

  it("the estimator is never told about a question that no longer applies", () => {
    const stale = { work_type: "Troubleshoot", panel_brand: "Siemens", run_ft: 85 };
    const text = answersForEstimator(SHEET, stale);
    expect(text).not.toContain("Siemens");
    expect(text).not.toContain("85");
  });

  it("and a kit is never sized off a hidden measurement", () => {
    const sheet = parseInspectionSchema([
      { key: "work_type", label: "Type", type: "select", options: ["Deck", "Repair"] },
      { key: "length", label: "Length", type: "number", showIf: { key: "work_type", in: ["Deck"] } },
      { key: "width", label: "Width", type: "number", showIf: { key: "work_type", in: ["Deck"] } },
    ]);
    expect(measurementsFromAnswers(sheet, { work_type: "Deck", length: 20, width: 12 }).sqft).toBe(240);
    // Same stored numbers, different job type — the area must vanish, not persist.
    expect(measurementsFromAnswers(sheet, { work_type: "Repair", length: 20, width: 12 }).sqft).toBeNull();
  });
});

describe('"still open" counts only what applies', () => {
  it("does not nag about questions the job type ruled out", () => {
    const open = unansweredFields(SHEET, { work_type: "Troubleshoot" }).map((f) => f.key);
    expect(open).toEqual(["permit"]); // not panel_brand, not run_ft
  });

  it("an unchecked checkbox is an answer, not a gap", () => {
    const open = unansweredFields(SHEET, { work_type: "Troubleshoot", permit: false }).map((f) => f.key);
    expect(open).toEqual([]);
  });
});

describe("the typed contract still holds — this is the part that must NOT become dynamic", () => {
  it('"a while" in a number box is no answer, not zero', () => {
    // Number("") is 0. A silent zero-foot run reads as a real measurement all the way to the price.
    expect(coerceAnswers(SHEET, { work_type: "Lighting", run_ft: "a while" }).run_ft).toBeNull();
  });

  it("but what a person actually types on a phone still parses", () => {
    expect(coerceAnswers(SHEET, { work_type: "Lighting", run_ft: "85 ft" }).run_ft).toBe(85);
    expect(coerceAnswers(SHEET, { work_type: "Lighting", run_ft: "1,200" }).run_ft).toBe(1200);
  });

  it("an option outside the list is refused rather than stored", () => {
    expect(coerceAnswers(SHEET, { work_type: "Plumbing" }).work_type).toBeNull();
  });
});
