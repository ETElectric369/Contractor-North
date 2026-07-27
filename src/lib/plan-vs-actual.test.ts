import { describe, it, expect } from "vitest";
import { comparePlanToActual, needsAttention, type PlannedDay, type ActualEntry } from "./plan-vs-actual";

const D = "2026-07-28";
const plan = (jobId: string | null, kind: "job" | "off" = "job"): PlannedDay[] => [
  { profileId: "brian", workDate: D, jobId, kind },
];
const worked = (jobId: string | null, hours = 8): ActualEntry[] => [
  { profileId: "brian", workDate: D, jobId, hours },
];
const one = (p: PlannedDay[], a: ActualEntry[]) => comparePlanToActual(p, a)[0];

/**
 * THE HARM this catches: hours landing on the wrong job. Nobody notices until invoicing, by which
 * point the customer is already looking at a number built from them. The office finding out on
 * Friday is the whole point — this is not a discipline tool, it's a costing tool.
 */
describe("plan vs actual", () => {
  it("worked the planned job — nothing to say", () => {
    expect(one(plan("miller"), worked("miller")).status).toBe("matched");
  });

  it("hours went somewhere else — MOVED", () => {
    const r = one(plan("miller"), worked("tahoe"));
    expect(r.status).toBe("moved");
    expect(r.actualJobIds).toEqual(["tahoe"]);
  });

  it("a split day that INCLUDES the planned job still counts as matched", () => {
    // A crew that starts where it was planned and gets pulled to a callback has not failed the
    // plan. Calling that a miss would train everyone to ignore the report.
    const split: ActualEntry[] = [
      { profileId: "brian", workDate: D, jobId: "miller", hours: 5 },
      { profileId: "brian", workDate: D, jobId: "callback", hours: 3 },
    ];
    const r = one(plan("miller"), split);
    expect(r.status).toBe("matched");
    expect(r.hours).toBe(8);
  });

  it("worked with nothing planned — UNPLANNED", () => {
    expect(one([], worked("tahoe")).status).toBe("unplanned");
  });

  it("worked on a day marked off — worth a look in either direction", () => {
    // Either the vacation was cancelled and nobody updated it, or the hours are wrong.
    expect(one(plan(null, "off"), worked("miller")).status).toBe("worked_off");
  });

  it("planned onto a job, no hours — NO SHOW", () => {
    expect(one(plan("miller"), []).status).toBe("no_show");
  });

  it("marked off and didn't work — exactly right, NOT a finding", () => {
    const r = one(plan(null, "off"), []);
    expect(r.status).toBe("off");
    expect(needsAttention([r])).toHaveLength(0);
  });

  it("nothing planned and nothing worked is not a finding either", () => {
    // Otherwise every unplanned Saturday for every employee becomes a row somebody has to dismiss.
    expect(comparePlanToActual([], [])).toHaveLength(0);
    const r = one([{ profileId: "brian", workDate: D, jobId: null, kind: "job" }], []);
    expect(r.status).toBe("idle");
    expect(needsAttention([r])).toHaveLength(0);
  });

  it("surfaces only what a person should look at", () => {
    const rows = comparePlanToActual(
      [
        { profileId: "a", workDate: D, jobId: "j1", kind: "job" },
        { profileId: "b", workDate: D, jobId: "j1", kind: "job" },
        { profileId: "c", workDate: D, jobId: null, kind: "off" },
      ],
      [
        { profileId: "a", workDate: D, jobId: "j1", hours: 8 }, // matched
        { profileId: "b", workDate: D, jobId: "j2", hours: 8 }, // moved
      ],
    );
    expect(needsAttention(rows).map((r) => r.profileId).sort()).toEqual(["b"]);
  });

  it("zero-hour entries don't read as work", () => {
    // An open shift with no time on it yet must not fire "unplanned".
    expect(one([], worked("tahoe", 0)).status).toBe("idle");
  });
});
