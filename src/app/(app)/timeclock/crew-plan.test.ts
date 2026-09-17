import { describe, expect, it } from "vitest";
import { pickScheduledJobForDay } from "./crew-plan";

// The week-math, label and optimistic-patch cases that used to sit here went with the two crew
// planner components they covered (cn-v951 — see crew-plan.ts). This is the surviving pure pick.

describe("pickScheduledJobForDay", () => {
  const jobs = [
    { id: "seg", scheduled_start: null as string | null },
    { id: "early", scheduled_start: "2026-07-21T15:00:00Z" },
    { id: "late", scheduled_start: "2026-07-21T18:00:00Z" },
    { id: "elsewhere", scheduled_start: "2026-07-24T15:00:00Z" },
  ];
  const segs = new Map([["seg", [{ start: "2026-07-20", end: "2026-07-22" }]]]);
  // The caller resolves scheduled_start → org-local day; mirror that here.
  const schedDays = new Map<string, string | null>([
    ["seg", null],
    ["early", "2026-07-21"],
    ["late", "2026-07-21"],
    ["elsewhere", "2026-07-24"],
  ]);

  it("a segment covering the day matches (inclusive bounds)", () => {
    expect(pickScheduledJobForDay([jobs[0]], "2026-07-20", segs, schedDays)?.id).toBe("seg");
    expect(pickScheduledJobForDay([jobs[0]], "2026-07-22", segs, schedDays)?.id).toBe("seg");
    expect(pickScheduledJobForDay([jobs[0]], "2026-07-23", segs, schedDays)).toBeNull();
  });

  it("scheduled_start's org-local day matches segment-less jobs", () => {
    expect(pickScheduledJobForDay([jobs[1]], "2026-07-21", segs, schedDays)?.id).toBe("early");
    expect(pickScheduledJobForDay([jobs[1]], "2026-07-22", segs, schedDays)).toBeNull();
  });

  it("earliest scheduled_start wins; segment-only jobs sort last (the pickJobScheduledToday tie-break)", () => {
    expect(pickScheduledJobForDay(jobs, "2026-07-21", segs, schedDays)?.id).toBe("early");
    // On a day only the segment covers, the segment job is the (sole) pick.
    expect(pickScheduledJobForDay(jobs, "2026-07-20", segs, schedDays)?.id).toBe("seg");
  });

  it("no schedule on that day → null (the day stays quietly blank)", () => {
    expect(pickScheduledJobForDay(jobs, "2026-07-23", segs, schedDays)).toBeNull();
    expect(pickScheduledJobForDay([], "2026-07-21", segs, schedDays)).toBeNull();
  });
});
