import { describe, it, expect } from "vitest";
import { DECK_INTAKE, ELECTRICAL_INTAKE, intakeStarterForTrade } from "./intake";
import { ET_ELECTRIC } from "./et-electric";
import { TAHOE_DECK } from "./tahoe-deck";
import { INTAKE_STARTER, publicIntakeNeeds } from "@/lib/playbook/public-intake";
import { answersFromIntake } from "@/lib/inquiries/carry-intake-answers";
import type { Need, Playbook } from "@/lib/playbook/types";

const byKey = (pb: Playbook) => new Map(pb.needs.map((n) => [n.key, n]));

const PAIRS: [string, Playbook, Playbook][] = [
  ["decks", DECK_INTAKE, TAHOE_DECK],
  ["electrical", ELECTRICAL_INTAKE, ET_ELECTRIC],
];

describe.each(PAIRS)("%s — a shared key must stay shareable", (_trade, intake, walk) => {
  const wk = byKey(walk);
  const shared = intake.needs.filter((n) => wk.has(n.key));

  it("shares real keys with the walk-through — otherwise nothing carries at all", () => {
    expect(shared.length).toBeGreaterThanOrEqual(4);
  });

  it.each(shared.map((n) => [n.key, n] as [string, Need]))(
    "%s — same option strings as the walk-through",
    (key, need) => {
      const other = wk.get(key)!;
      // coerceByPlaybook matches a select answer against the WALK-THROUGH's option list, exactly.
      // "Composite (Trex/TimberTech)" here against "Composite (Trex / TimberTech)" there is not a
      // near miss, it is a dropped answer — and a dropped answer is silent.
      if (need.slot?.type === "select" && other.slot?.type === "select") {
        for (const o of need.slot.options) expect(other.slot.options).toContain(o);
        expect(!!need.slot.multi).toBe(!!other.slot.multi);
      }
    },
  );

  it("never asks the customer for something the contractor measures", () => {
    // answersFromIntake refuses a measured answer on arrival, so asking would collect friction and
    // throw the result away. Catch it here, where somebody can just delete the question.
    const measured = shared.filter((n) => wk.get(n.key)!.measured).map((n) => n.key);
    expect(measured).toEqual([]);
  });

  it("has a slot on every question — an open need renders NOTHING on the public page", () => {
    // There is no Nort on /intake to phrase an open question, so a need with no slot is invisible:
    // the customer never sees it and the contractor never learns it was skipped.
    expect(intake.needs.filter((n) => !n.slot).map((n) => n.key)).toEqual([]);
  });

  it("offers no scopes question — those options are the org's own price-list codes", () => {
    expect(intake.needs.filter((n) => n.slot?.type === "scopes")).toEqual([]);
  });

  it("leaks no why line and no note to the public page", () => {
    // publicIntakeNeeds is the allowlist projection; this asserts the source is clean too, so a
    // starter can never be the thing that puts his pricing logic on a stranger's screen.
    expect(intake.needs.some((n) => n.why || n.note)).toBe(false);
    for (const n of publicIntakeNeeds(intake)) expect(Object.keys(n).sort()).toEqual(
      expect.arrayContaining(["ask", "key", "label"]),
    );
  });

  it("every `when` rule names a question that is actually on this form", () => {
    const keys = new Set(intake.needs.map((n) => n.key));
    for (const n of intake.needs) for (const c of n.when ?? []) expect(keys.has(c.key)).toBe(true);
  });

  it("and names one ABOVE it — a rule pointing forwards can never resolve", () => {
    const seen = new Set<string>();
    for (const n of intake.needs) {
      for (const c of n.when ?? []) expect(seen.has(c.key)).toBe(true);
      seen.add(n.key);
    }
  });
});

describe("end to end: what a customer fills in is what the inspector already has", () => {
  it("Chris's five carry; the tape does not", () => {
    const { answers, carried } = answersFromIntake(TAHOE_DECK, {
      project_type: "Resurface — new boards, keep the frame",
      material: "Composite (Trex / TimberTech)",
      shape: "Irregular",
      wrap_around: "Yes",
      trpa: "Yes",
      site_notes: "Hot tub sits on the far corner.",
      // Not on the deck intake at all, but a crafted payload can send anything.
      length_ft: 20,
    });
    expect(carried).toEqual([
      "Kind of project",
      "Decking material",
      "Shape",
      "Wraps the house",
      "TRPA basin",
      "Anything else",
    ]);
    expect(answers.length_ft).toBeUndefined();
  });

  it("Erik's four carry", () => {
    const { carried } = answersFromIntake(ET_ELECTRIC, {
      work_kind: "Contract job",
      work: ["Add circuits", "Lighting"],
      walls: "Finished",
      access: "From below — cut and drill",
      gotcha: "Old knob and tube in the attic.",
    });
    expect(carried).toEqual([
      "Service call or contract",
      "Kind of work",
      "Anything that'll bite us",
      "Walls",
      "Access",
    ]);
  });
});

describe("which starter a new door gets", () => {
  it.each([
    ["deck builder", DECK_INTAKE],
    ["Deck & Fence", DECK_INTAKE],
    ["electrical contractor", ELECTRICAL_INTAKE],
    ["Electrician", ELECTRICAL_INTAKE],
    ["Construction", INTAKE_STARTER],
    ["", INTAKE_STARTER],
    [null, INTAKE_STARTER],
  ])("%s", (label, expected) => {
    expect(intakeStarterForTrade(label, INTAKE_STARTER)).toBe(expected);
  });

  it("does not match a word that merely CONTAINS the trade", () => {
    // "Decking" should match; "Redeck" should not become a deck company by accident, and neither
    // should anything that happens to end in -deck.
    expect(intakeStarterForTrade("Decking and railings", INTAKE_STARTER)).toBe(DECK_INTAKE);
    expect(intakeStarterForTrade("Redeckorating", INTAKE_STARTER)).toBe(INTAKE_STARTER);
  });
});
