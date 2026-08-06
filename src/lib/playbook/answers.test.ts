import { describe, it, expect } from "vitest";
import { answerText, coerceByPlaybook, coerceNeed, factsForEstimator } from "./answers";
import { playbookFromSheet } from "./from-sheet";
import { looseNumber } from "@/lib/inspection/capture";
import { ET_ELECTRIC } from "./starters/et-electric";
import type { Need, Playbook } from "./types";

const need = (n: Partial<Need> & { key: string }): Need => ({ label: n.key, ask: `${n.key}?`, ...n });

describe("numbers — no digits means no answer, never zero", () => {
  const n = need({ key: "run_ft", slot: { type: "number" }, measured: true });

  it.each([
    ["85 ft", 85],
    ["1,200", 1200],
    [" 9.5 ", 9.5],
    [0, 0], // a real, deliberate zero survives
  ])("%s → %s", (input, expected) => {
    expect(coerceNeed(n, input)).toBe(expected);
  });

  it.each(["a while", "", "  ", null, undefined])("%s → null", (input) => {
    expect(coerceNeed(n, input)).toBeNull();
  });

  it("ONE PARSER, shared with the box he types into — two parsers is two answers", () => {
    // Stripping every non-digit made "16 and 20" into 1620 and "$85-95/hr" into 8595, while the
    // client's own box read the same strings as 16 and 85. A number that means one thing on screen
    // and another in the row is the worst kind of wrong: nothing looks broken.
    expect(coerceNeed(n, "16 and 20")).toBe(looseNumber("16 and 20"));
    expect(coerceNeed(n, "16 and 20")).toBe(16);
    expect(coerceNeed(n, "$85-95/hr")).toBe(85);
    expect(coerceNeed(n, "12 x 16")).toBe(12);
  });
});

describe("selects, and the checkbox that became one", () => {
  const permit = playbookFromSheet([{ key: "permit", label: "Permit needed", type: "checkbox" }]).needs[0];

  it("THE SPLIT-BRAIN THIS FILE EXISTS FOR: 'No' must not read as yes", () => {
    // Coerced against the SHEET, "No" hits the checkbox branch as a non-empty string and comes out
    // `true` — a job with no permit stored as permitted. Coerced against the playbook it is "No".
    expect(coerceNeed(permit, "No")).toBe("No");
    expect(coerceNeed(permit, "Yes")).toBe("Yes");
  });

  it("a boolean from the OLD renderer is migrated, not discarded", () => {
    // Rejecting it would null a real answer on the next autosave — a regression that erases data
    // while looking like nothing happened.
    expect(coerceNeed(permit, true)).toBe("Yes");
    expect(coerceNeed(permit, false)).toBe("No");
  });

  it("an option outside the list is refused — stale template or tampered payload", () => {
    expect(coerceNeed(permit, "Maybe")).toBeNull();
  });

  it("multi stores an array even of one; single stores a scalar even from an array", () => {
    const multi = need({ key: "work", slot: { type: "select", multi: true, options: ["A", "B"] } });
    const single = need({ key: "work", slot: { type: "select", options: ["A", "B"] } });
    expect(coerceNeed(multi, "A")).toEqual(["A"]);
    expect(coerceNeed(multi, ["A", "B", "Z"])).toEqual(["A", "B"]);
    expect(coerceNeed(single, ["B", "A"])).toBe("B");
    // Deselecting the last chip is NOT an answer — otherwise the question leaves the screen having
    // never been answered, which is precisely how the permit vanished.
    expect(coerceNeed(multi, [])).toBeNull();
  });
});

describe("open needs — the sentence no control can hold", () => {
  const gotcha = need({ key: "gotcha" }); // no slot

  it("keeps the prose", () => {
    expect(coerceNeed(gotcha, "  meter base is pulling off the wall ")).toBe("meter base is pulling off the wall");
  });

  it("blank is still nothing", () => {
    expect(coerceNeed(gotcha, "   ")).toBeNull();
  });

  it("Erik's whole paragraph survives the trip", () => {
    const said =
      "2 new circuits one for lights and one for outlets installed new in a finished room with sheetrock and paint";
    expect(coerceByPlaybook(ET_ELECTRIC, { power_source: said }).power_source).toBe(said);
  });
});

describe("the payload boundary", () => {
  const pb: Playbook = { needs: [need({ key: "a", slot: { type: "text" } })] };

  it("a key the playbook never declared is dropped, not stored", () => {
    // The row is reachable through PostgREST, so an unknown key is arbitrary jsonb on the record.
    expect(coerceByPlaybook(pb, { a: "ok", is_admin: true })).toEqual({ a: "ok" });
  });

  it("every declared need gets a key, so absence is explicit", () => {
    expect(coerceByPlaybook(pb, {})).toEqual({ a: null });
  });

  it("garbage in is an empty answer set, not a throw", () => {
    expect(coerceByPlaybook(pb, "nope")).toEqual({ a: null });
    expect(coerceByPlaybook(pb, null)).toEqual({ a: null });
  });
});

describe("what the estimator is told", () => {
  it("only what still applies — a stale answer handed over as a given is the whole failure", () => {
    const pb: Playbook = {
      needs: [
        need({ key: "work", slot: { type: "select", options: ["Lighting", "Panel"] } }),
        need({ key: "brand", label: "Panel brand", slot: { type: "text" }, when: [{ key: "work", in: ["Panel"] }] }),
      ],
    };
    const stale = { work: "Lighting", brand: "Zinsco" };
    expect(factsForEstimator(pb, stale)).toBe("- work: Lighting");
  });

  it("a multi-select reads as one answer, because it is one", () => {
    expect(answerText(["Add circuits", "Lighting"])).toBe("Add circuits, Lighting");
  });

  it("nothing answered is an empty string, not a header with no rows", () => {
    expect(factsForEstimator(ET_ELECTRIC, {})).toBe("");
  });
});

describe("factsForEstimator clears to a FIXED POINT before handing facts to the estimator", () => {
  /**
   * Found by the cn-v658 audit, reproduced against the real ET_ELECTRIC playbook.
   *
   * applicableNeeds is ONE pass. With work="Troubleshoot" it correctly drops `power_source` — but
   * the stale power_source VALUE keeps `feed` applicable, and stale `feed` keeps `run_ft`
   * applicable. So a 25-ft feeder measurement from an abandoned branch was handed to the estimator
   * under the header "MEASURED ON SITE (these are given — use them, don't re-derive them)".
   *
   * A number that reaches a price must survive the same clear the inspector applies on save.
   */
  const stale = {
    work: ["Troubleshoot"],
    power_source: "meter panel, 2 slots",
    feed: "Subpanel at the source",
    run_ft: 25,
  };

  it("does NOT hand a measurement from an abandoned branch to the estimator", () => {
    const out = factsForEstimator(ET_ELECTRIC, stale);
    expect(out).not.toContain("Run (ft)");
    expect(out).not.toContain("25");
  });

  it("and still carries the facts that DO apply", () => {
    const live = { work: ["Add circuits"], power_source: "meter panel", feed: "Subpanel at the source", run_ft: 25 };
    expect(factsForEstimator(ET_ELECTRIC, live)).toContain("25");
  });
});
