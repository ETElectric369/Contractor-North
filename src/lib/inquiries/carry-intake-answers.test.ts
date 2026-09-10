import { describe, it, expect } from "vitest";
import { answersFromIntake, intakeAnswerLines } from "./carry-intake-answers";
import { ET_ELECTRIC } from "@/lib/playbook/starters/et-electric";
import { TAHOE_DECK } from "@/lib/playbook/starters/tahoe-deck";
import type { Playbook } from "@/lib/playbook/types";

describe("a customer may answer a question, never take a measurement", () => {
  it("carries Chris's choices and refuses his tape", () => {
    // Everything a homeowner can honestly say about their own deck, plus the four numbers only a
    // tape settles. If a guessed depth carried, it would reach the estimator inside a block headed
    // "take these as given" and get multiplied by a per-square-foot rate.
    const { answers, carried } = answersFromIntake(TAHOE_DECK, {
      project_type: "New deck",
      material: "Composite (Trex / TimberTech)",
      trpa: "Yes",
      length_ft: 20,
      width_ft: 12,
      height_ft: 9,
      railing_lf: 64,
    });
    expect(answers.project_type).toBe("New deck");
    expect(answers.material).toBe("Composite (Trex / TimberTech)");
    expect(answers.trpa).toBe("Yes");
    expect(answers.length_ft).toBeUndefined();
    expect(answers.width_ft).toBeUndefined();
    expect(answers.height_ft).toBeUndefined();
    expect(answers.railing_lf).toBeUndefined();
    expect(carried).toContain("Kind of project");
    expect(carried).not.toContain("Length");
  });

  it("carries Erik's forks the same way", () => {
    const { answers } = answersFromIntake(ET_ELECTRIC, {
      work_kind: "Service call",
      work: ["Lighting"],
      run_ft: 85,
      device_count: 12,
    });
    expect(answers.work_kind).toBe("Service call");
    expect(answers.work).toEqual(["Lighting"]);
    expect(answers.run_ft).toBeUndefined();
    expect(answers.device_count).toBeUndefined();
  });
});

describe("what a crafted intake payload cannot do", () => {
  const pb: Playbook = {
    needs: [
      { key: "project_type", label: "Kind of project", ask: "?", slot: { type: "select", options: ["New deck", "Remodel"] } },
      { key: "remodel_scopes", label: "Remodel scopes", ask: "?", slot: { type: "scopes", codes: ["R1"] } },
      { key: "plans", label: "Plans", ask: "?", slot: { type: "file", multi: true } },
      { key: "site_notes", label: "Anything else", ask: "?" },
    ],
  } as Playbook;

  it("drops a scopes answer — its options ARE the price list, so a stranger never saw that question", () => {
    const { answers } = answersFromIntake(pb, {
      project_type: "Remodel",
      remodel_scopes: [{ code: "R1", qty: 1, price: 999999 }],
    });
    expect(answers.remodel_scopes).toBeUndefined();
    expect(answers.project_type).toBe("Remodel");
  });

  it("drops file paths — the intake bucket is not the inspector's, so a carried path is a broken name", () => {
    const { answers } = answersFromIntake(pb, { plans: ["org-1/intake/1754-uuid-plans.pdf"] });
    expect(answers.plans).toBeUndefined();
  });

  it("drops a key the WALK-THROUGH doesn't declare, however the payload spells it", () => {
    const { answers, carried } = answersFromIntake(pb, { not_a_need: "boom", "<img src=x>": "boom" });
    expect(answers).toEqual({});
    expect(carried).toEqual([]);
  });

  it("an open need still carries — the customer typing a paragraph is the whole point", () => {
    const { answers, carried } = answersFromIntake(pb, { site_notes: "There's a hot tub on the old one." });
    expect(answers.site_notes).toBe("There's a hot tub on the old one.");
    expect(carried).toEqual(["Anything else"]);
  });
});

describe("nothing to carry means nothing is touched", () => {
  it.each([null, undefined, {}, "not an object", 42])("%s → no template, no answers", (stored) => {
    const { answers, carried } = answersFromIntake(TAHOE_DECK, stored);
    expect(answers).toEqual({});
    expect(carried).toEqual([]);
  });

  it("an empty playbook carries nothing rather than throwing", () => {
    expect(answersFromIntake({ needs: [] } as Playbook, { project_type: "New deck" })).toEqual({
      answers: {},
      carried: [],
    });
  });
});

describe("the walk-through's declaration governs, but its RULES wait their turn", () => {
  const pb: Playbook = {
    needs: [
      { key: "project_type", label: "Kind of project", ask: "?", slot: { type: "select", options: ["New deck", "Remodel"] } },
      { key: "length_ft", label: "Length", ask: "?", slot: { type: "number" }, measured: true },
      {
        key: "shape",
        label: "Shape",
        ask: "?",
        slot: { type: "select", options: ["Rectangular", "Irregular"] },
        when: [{ key: "length_ft", known: true }],
      },
    ],
  } as Playbook;

  it("a value outside the walk-through's option list is dropped, not forced in", () => {
    const { answers } = answersFromIntake(pb, { project_type: "Gazebo" });
    expect(answers.project_type).toBeUndefined();
  });

  it("KEEPS an answer gated behind a measurement nobody has taken yet", () => {
    // This is the case that made clearInapplicable wrong here. `shape` waits on `length_ft`, and
    // `length_ft` is measured — the one thing a customer may never supply. Clearing would throw
    // away "Irregular" (the DS6C cutting rate) because the deck has not been measured, which is
    // true and is not a reason to forget what the customer said.
    const { answers, carried } = answersFromIntake(pb, { project_type: "New deck", shape: "Irregular" });
    expect(answers.shape).toBe("Irregular");
    expect(carried).toEqual(["Kind of project", "Shape"]);
  });

  it("and an answer under a question that never applies is inert, not dangerous", () => {
    // It is never rendered (the resolver hides it), never priced (factsForEstimator clears first),
    // and gone at the inspector's first autosave — which runs once the measurements exist.
    const { answers } = answersFromIntake(pb, { shape: "Irregular" });
    expect(answers.shape).toBe("Irregular");
  });
});

describe("what the walk-through cannot ask is shown, not dropped (Andy Colar)", () => {
  // Vivian Builders' real shape, trimmed: an intake form with its own auto-generated keys and a
  // walk-through that shares none of them. Before this, everything below reached the visit as one
  // unattributed paragraph in the appointment's notes.
  const intakePb = {
    needs: [
      { key: "q_msmg9uwv", label: "Project Address", ask: "Where is it?", slot: { type: "text" } },
      { key: "describe", label: "The project", ask: "What is it?", slot: { type: "select", options: ["Residential Remodel"] } },
      { key: "q_mst1drw8", label: "Residential Remodel", ask: "Which rooms?", slot: { type: "select", options: ["Kitchen"] } },
      { key: "timeline", label: "Timeline", ask: "When?", slot: { type: "select", options: ["As soon as possible"] } },
      { key: "has_plans", label: "Plans", ask: "Got plans?", slot: { type: "select", options: ["Yes", "No"] } },
      { key: "plan_files", label: "Plan files", ask: "Upload them.", slot: { type: "file", multi: true } },
    ],
  } as Playbook;

  const answered = {
    q_msmg9uwv: "13897 Herringbone Way",
    describe: "Residential Remodel",
    q_mst1drw8: "Kitchen",
    timeline: "As soon as possible",
    has_plans: "No",
    plan_files: null,
    designer_city: null,
  };

  it("gives every answer its question back, in the order it was asked", () => {
    const lines = intakeAnswerLines(intakePb, answered);
    expect(lines.map((l) => l.label)).toEqual([
      "Project Address",
      "The project",
      "Residential Remodel",
      "Timeline",
      "Plans",
    ]);
    expect(lines[2].value).toBe("Kitchen");
  });

  it("leaves file answers to IntakeFiles — a storage path is not something to read out", () => {
    const lines = intakeAnswerLines(intakePb, { ...answered, plan_files: ["org/intake/plans.pdf"] });
    expect(lines.some((l) => l.key === "plan_files")).toBe(false);
  });

  it("says nothing twice: what the walk-through already pre-filled is skipped", () => {
    const lines = intakeAnswerLines(intakePb, answered, new Set(["describe", "timeline"]));
    expect(lines.map((l) => l.key)).toEqual(["q_msmg9uwv", "q_mst1drw8", "has_plans"]);
  });

  it("rescues an answer whose question has since been deleted from the form", () => {
    // Andrew renames and removes Vivian Builders' questions weekly. A question that left the form
    // must not take the customer's answer off the screen with it.
    const lines = intakeAnswerLines({ needs: [] } as Playbook, { budget: "Over $50,000" });
    expect(lines).toEqual([{ key: "budget", label: "Budget", value: "Over $50,000" }]);
  });

  it("nothing answered means nothing rendered, rather than a card made of blanks", () => {
    expect(intakeAnswerLines(intakePb, null)).toEqual([]);
    expect(intakeAnswerLines(intakePb, { describe: null, timeline: "" })).toEqual([]);
  });
});
