import { describe, it, expect } from "vitest";
import { dayLoad, durationLabel, fillsTheDay, KIND_LABEL, workKind } from "./work-shape";

/**
 * Erik: "what i need to know is how much time they are going to take hours or days and a tag
 * showing service call, job, inspection/walk through, or office … if one has 6 hours set and the
 * other has 1 hour set i can see that the visit is on the way."
 */
describe("workKind — the tag, from what already exists", () => {
  it("maps the appointment types he named to his words", () => {
    expect(KIND_LABEL[workKind({ type: "inspection" })]).toBe("Walk-through");
    expect(KIND_LABEL[workKind({ type: "final_inspection" })]).toBe("Walk-through");
    expect(KIND_LABEL[workKind({ type: "service_call" })]).toBe("Service Call");
    expect(KIND_LABEL[workKind({ type: "meeting" })]).toBe("Office");
    expect(KIND_LABEL[workKind({ kind: "job" })]).toBe("Job");
  });

  it("a LEAD is a walk-through — the only thing a lead can be scheduled as", () => {
    expect(workKind({ kind: "lead" })).toBe("walkthrough");
  });

  it("an unknown type is 'other', never a crash", () => {
    expect(workKind({ type: "something_new" })).toBe("other");
    expect(workKind({})).toBe("other");
  });
});

describe("durationLabel — BLANK IS NOT ZERO", () => {
  it("an unsized job reads as a dash, never as 0h", () => {
    // Zero is a claim that it takes no time; blank is the truth that nobody has sized it. He has
    // to tell those apart at a glance — one is ready to plan, the other is a question.
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(undefined)).toBe("—");
    expect(durationLabel(0)).toBe("—");
  });

  it("his own example: 6 hours and 1 hour", () => {
    expect(durationLabel(360)).toBe("6h");
    expect(durationLabel(60)).toBe("1h");
  });

  it("under an hour stays in minutes", () => {
    expect(durationLabel(30)).toBe("30m");
    expect(durationLabel(90)).toBe("1.5h");
  });

  it("a long day is still a day, not '1.4 days'", () => {
    expect(durationLabel(660)).toBe("11h");
  });

  it("two days and up read as days", () => {
    expect(durationLabel(960)).toBe("2 days");
    expect(durationLabel(1200)).toBe("2.5 days");
  });
});

describe("fillsTheDay — does it OWN the day or share it", () => {
  it("a 6h job owns the day", () => {
    expect(fillsTheDay(360)).toBe(true);
  });
  it("a 1h walk-through shares it — the 'visit is on the way' case", () => {
    expect(fillsTheDay(60)).toBe(false);
  });
  it("unsized never claims the day", () => {
    expect(fillsTheDay(null)).toBe(false);
  });
});

describe("dayLoad — what a day already holds", () => {
  it("his exact scenario: a 6h job plus a 1h visit is 7h", () => {
    expect(dayLoad([{ planned_minutes: 360 }, { planned_minutes: 60 }]).label).toBe("7h");
  });

  it("UNSIZED IS COUNTED, NOT ASSUMED ZERO", () => {
    // Treating unknown as nothing is how a day looks free right up until you arrive at it.
    const d = dayLoad([{ planned_minutes: 360 }, { planned_minutes: null }]);
    expect(d.minutes).toBe(360);
    expect(d.unsized).toBe(1);
    expect(d.label).toBe("6h · 1 unsized");
  });

  it("an all-unsized day says so rather than reading empty", () => {
    expect(dayLoad([{ planned_minutes: null }, {}]).label).toBe("2 unsized");
  });

  it("an empty day is empty", () => {
    expect(dayLoad([])).toMatchObject({ minutes: 0, unsized: 0, label: "" });
  });
});
