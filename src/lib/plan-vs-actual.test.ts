import { describe, it, expect } from "vitest";
import { comparePlanToActual, explain, needsAttention, type PlannedDay, type ActualEntry } from "./plan-vs-actual";

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

/**
 * THE SCHEDULE FALLBACK (2026-09-18). crew_day_assignments is an override Erik almost never sets —
 * 24 rows in the app's whole life, none since August — so taking the plan from it alone made every
 * day anybody worked read as "nothing planned". Five of those in one card, all false, and Erik:
 * "we worked on the job that was in the schedule". The schedule is the plan he actually keeps, so
 * it answers when no assignment does, and it is deliberately WEAKER than one.
 */
describe("plan vs actual — the schedule answers when no assignment does", () => {
  const sched = (jobId: string): PlannedDay[] => [
    { profileId: "brian", workDate: D, jobId, kind: "job", source: "schedule" },
  ];

  it("the schedule said the job and the hours went there — silent", () => {
    const r = one(sched("waldow"), worked("waldow"));
    expect(r.status).toBe("matched");
    expect(r.planSource).toBe("schedule");
    expect(needsAttention([r])).toHaveLength(0);
  });

  it("the schedule said one job and the hours went to another — a finding", () => {
    const r = one(sched("waldow"), worked("tahoe"));
    expect(r.status).toBe("moved");
    expect(needsAttention([r])).toHaveLength(1);
    // It says which layer it is quoting, so the line reads as the calendar being stale rather
    // than as an accusation.
    expect(explain(r, (id) => id, "Brian")).toBe(
      "The schedule has Brian on waldow that day, but the hours went to tahoe.",
    );
  });

  it("an explicit assignment BEATS the schedule, in either order (0139)", () => {
    const assigned: PlannedDay = { profileId: "brian", workDate: D, jobId: "callback", kind: "job" };
    const scheduled: PlannedDay = { profileId: "brian", workDate: D, jobId: "waldow", kind: "job", source: "schedule" };
    for (const rows of [[scheduled, assigned], [assigned, scheduled]]) {
      const r = comparePlanToActual(rows, worked("callback"))[0];
      expect(r.plannedJobId).toBe("callback");
      expect(r.planSource).toBe("assignment");
      expect(r.status).toBe("matched");
    }
  });

  it("a scheduled day nobody worked is SILENCE, not a no-show", () => {
    // A job range runs Monday to Friday over its own weekend and says nothing about who was
    // expected on it on any one day. Only an assignment is a promise somebody made.
    const r = one(sched("waldow"), []);
    expect(r.status).toBe("idle");
    expect(needsAttention([r])).toHaveLength(0);
    // The assignment half is untouched: that one is still a no-show.
    expect(one(plan("waldow"), []).status).toBe("no_show");
  });
});

/**
 * ERIK'S OWN SENTENCE, IN CODE: "we worked on the job that was in the schedule". A job the calendar
 * had RUNNING that day is a planned place for anybody's hours, whoever jobs.assigned_to names —
 * that roster is a coarse list nobody grooms, and a warning built on it fires on ordinary days.
 */
describe("plan vs actual — the calendar's own day", () => {
  const calendar = (jobIds: string[]) => new Map([[D, new Set(jobIds)]]);

  it("no plan for the person, but the calendar was running that job — silent", () => {
    const r = comparePlanToActual([], worked("waldow"), calendar(["waldow"]))[0];
    expect(r.status).toBe("matched");
    expect(needsAttention([r])).toHaveLength(0);
  });

  it("no plan and the calendar had nothing on that job — that IS worth saying", () => {
    const r = comparePlanToActual([], worked("waldow"), calendar(["tahoe"]))[0];
    expect(r.status).toBe("unplanned");
    expect(explain(r, (id) => id, "Brian")).toBe(
      "Brian worked 8.0h on waldow, which was not on the calendar for that day.",
    );
  });

  it("hours with no job on them at all say so, and never read as an empty job name", () => {
    const r = comparePlanToActual([], worked(null), calendar(["waldow"]))[0];
    expect(r.status).toBe("unplanned");
    expect(explain(r, (id) => id, "Erik Taylor")).toBe("Erik Taylor worked 8.0h with no job on the hours.");
  });

  it("the calendar softens the SCHEDULE's answer, never an assignment's", () => {
    const cal = calendar(["waldow", "tahoe"]);
    // Schedule said tahoe, hours went to waldow, which the calendar was running: nothing to say.
    const bySchedule = comparePlanToActual(
      [{ profileId: "brian", workDate: D, jobId: "tahoe", kind: "job", source: "schedule" }],
      worked("waldow"),
      cal,
    )[0];
    expect(bySchedule.status).toBe("matched");
    // A person PUT on tahoe for the day is a decision, and hours elsewhere contradict it even
    // though the calendar had that other job running. Precedence cuts both ways.
    const byAssignment = comparePlanToActual(plan("tahoe"), worked("waldow"), cal)[0];
    expect(byAssignment.status).toBe("moved");
  });

  it("a day nobody planned and nobody worked is still nothing at all", () => {
    expect(comparePlanToActual([], [], calendar(["waldow"]))).toHaveLength(0);
  });

  it("a moved day whose hours carry no job does not trail off", () => {
    // The rollup only collects a job id when the entry has one, so this sentence used to end
    // "but the hours went to ." — it names the real shape now.
    const rows = comparePlanToActual(
      [{ profileId: "p1", workDate: "2026-09-15", kind: "job", jobId: "jA" }],
      [{ profileId: "p1", workDate: "2026-09-15", jobId: null, hours: 8 }],
    );
    const moved = rows.find((r) => r.status === "moved")!;
    expect(moved).toBeTruthy();
    const said = explain(moved, (id) => (id === "jA" ? "Waldow" : id), "Erik Taylor");
    expect(said).toBe("Erik Taylor was put on Waldow but the hours have no job on them.");
    expect(said).not.toMatch(/to \.$/);
  });
});
