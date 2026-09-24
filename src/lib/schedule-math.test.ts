import { describe, expect, it } from "vitest";
import { keepWorkedDays, moveKeepingWorkedDays, shiftSegmentCovering, workedDaysFrom } from "./schedule-math";

describe("keepWorkedDays: a reschedule moves the plan, not the history", () => {
  it("Herringbone: moving a 22nd-23rd job to the 24th keeps the 22nd, where time was logged", () => {
    const before = [{ start: "2026-09-22", end: "2026-09-23" }];
    const after = [{ start: "2026-09-24", end: "2026-09-24" }];
    const r = keepWorkedDays(before, after, ["2026-09-18", "2026-09-22"], "2026-09-24");
    expect(r.kept).toEqual(["2026-09-22"]);
    expect(r.segments).toEqual([
      { start: "2026-09-22", end: "2026-09-22" },
      { start: "2026-09-24", end: "2026-09-24" },
    ]);
  });

  it("a worked day that was never on the schedule is not invented", () => {
    const r = keepWorkedDays([{ start: "2026-09-22", end: "2026-09-22" }], [{ start: "2026-09-25", end: "2026-09-25" }], ["2026-09-18"], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([{ start: "2026-09-25", end: "2026-09-25" }]);
  });

  it("a past scheduled day nobody worked moves like any other", () => {
    const r = keepWorkedDays([{ start: "2026-09-22", end: "2026-09-23" }], [{ start: "2026-09-28", end: "2026-09-29" }], [], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([{ start: "2026-09-28", end: "2026-09-29" }]);
  });

  it("today's logged time counts as history; a future 'worked' day does not", () => {
    const r = keepWorkedDays(
      [{ start: "2026-09-24", end: "2026-09-26" }],
      [{ start: "2026-10-01", end: "2026-10-03" }],
      ["2026-09-24", "2026-09-26"],
      "2026-09-24",
    );
    expect(r.kept).toEqual(["2026-09-24"]);
  });

  it("a day the new window still covers is not reported as kept", () => {
    const r = keepWorkedDays([{ start: "2026-09-22", end: "2026-09-23" }], [{ start: "2026-09-22", end: "2026-09-25" }], ["2026-09-22"], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([{ start: "2026-09-22", end: "2026-09-25" }]);
  });

  it("the job's listed start (the mirror) follows the new window, not the kept day", () => {
    // Herringbone again: the calendar keeps the 22nd, but the job's scheduled_start must read the
    // 24th, or Nort's "what's on the 24th" (which reads the mirror) no longer lists the job.
    const r = keepWorkedDays(
      [{ start: "2026-09-22", end: "2026-09-23" }],
      [{ start: "2026-09-24", end: "2026-09-24" }],
      ["2026-09-22"],
      "2026-09-24",
    );
    expect(r.segments[0].start).toBe("2026-09-22");
    expect(r.mirror).toEqual({ start: "2026-09-24", end: "2026-09-24" });
  });

  it("ignores malformed worked days", () => {
    const r = keepWorkedDays([{ start: "2026-09-22", end: "2026-09-22" }], [], ["", "garbage"], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([]);
  });
});

describe("moveKeepingWorkedDays: only the days not yet worked travel", () => {
  it("a 3-day range with 2 days worked moves as 1 day; the job never gains days", () => {
    const r = moveKeepingWorkedDays([{ start: "2026-09-21", end: "2026-09-23" }], "2026-09-21", "2026-09-24", ["2026-09-22", "2026-09-23", "2026-09-23"], "2026-09-24");
    expect(r.kept).toEqual(["2026-09-22", "2026-09-23"]);
    expect(r.moved).toEqual({ start: "2026-09-24", end: "2026-09-24" });
    expect(r.rangeDays).toBe(3);
    expect(r.workedInRange).toBe(2);
    // The kept days sit next to the moved one and merge: 3 days before, 3 days after.
    expect(r.segments).toEqual([{ start: "2026-09-22", end: "2026-09-24" }]);
    expect(r.mirror).toEqual({ start: "2026-09-24", end: "2026-09-24" });
  });

  it("an unworked range keeps its full length, as before", () => {
    const r = moveKeepingWorkedDays([{ start: "2026-09-28", end: "2026-09-30" }], null, "2026-10-05", ["2026-09-22"], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([{ start: "2026-10-05", end: "2026-10-07" }]);
  });

  it("a range worked in full still moves as one day: the work goes on", () => {
    const r = moveKeepingWorkedDays([{ start: "2026-09-22", end: "2026-09-22" }], "2026-09-22", "2026-09-26", ["2026-09-22"], "2026-09-24");
    expect(r.kept).toEqual(["2026-09-22"]);
    expect(r.workedInRange).toBe(r.rangeDays);
    expect(r.segments).toEqual([
      { start: "2026-09-22", end: "2026-09-22" },
      { start: "2026-09-26", end: "2026-09-26" },
    ]);
  });

  it("with no from day, the plan moves, not a kept day of history", () => {
    // After an earlier move kept the 22nd, "push it to Friday" must move the 24th, not the 22nd.
    const segs = [
      { start: "2026-09-22", end: "2026-09-22" },
      { start: "2026-09-25", end: "2026-09-25" },
    ];
    const r = moveKeepingWorkedDays(segs, null, "2026-09-29", ["2026-09-22"], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([
      { start: "2026-09-22", end: "2026-09-22" },
      { start: "2026-09-29", end: "2026-09-29" },
    ]);
  });

  it("an unscheduled job just lands on the day", () => {
    const r = moveKeepingWorkedDays([], null, "2026-09-29", [], "2026-09-24");
    expect(r.segments).toEqual([{ start: "2026-09-29", end: "2026-09-29" }]);
    expect(r.kept).toEqual([]);
  });
});

describe("workedDaysFrom: what counts as a worked day", () => {
  const tz = "America/Los_Angeles";
  it("a time entry counts, on its org-timezone day", () => {
    // 02:30 UTC on the 23rd is 7:30 PM on the 22nd in Truckee.
    expect(workedDaysFrom([{ clock_in: "2026-09-23T02:30:00Z" }], [], tz)).toEqual(["2026-09-22"]);
  });

  it("a visit closed out as done counts; one still 'scheduled' or cancelled does not", () => {
    const visits = [
      { starts_at: "2026-09-21T15:00:00Z", status: "completed" },
      { starts_at: "2026-09-22T15:00:00Z", status: "scheduled" }, // nobody closed it out
      { starts_at: "2026-09-23T15:00:00Z", status: "cancelled" },
    ];
    expect(workedDaysFrom([], visits, tz)).toEqual(["2026-09-21"]);
  });

  it("a day resting only on an unclosed visit moves with the rest", () => {
    // The office moves today's job to tomorrow because the crew never went; the 8am visit is
    // still 'scheduled'. Today is not history, so nothing is kept.
    const worked = workedDaysFrom([], [{ starts_at: "2026-09-24T15:00:00Z", status: "scheduled" }], tz);
    const r = moveKeepingWorkedDays([{ start: "2026-09-24", end: "2026-09-24" }], "2026-09-24", "2026-09-25", worked, "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([{ start: "2026-09-25", end: "2026-09-25" }]);
  });
});

describe("shiftSegmentCovering: the plain move, no history", () => {
  it("moves the covering range at full length and leaves the others", () => {
    const segs = [
      { start: "2026-09-21", end: "2026-09-23" },
      { start: "2026-10-01", end: "2026-10-01" },
    ];
    expect(shiftSegmentCovering(segs, "2026-09-22", "2026-09-28")).toEqual([
      { start: "2026-09-28", end: "2026-10-01" },
    ]);
    expect(shiftSegmentCovering(segs, "2026-12-25", "2026-11-02")).toEqual([
      { start: "2026-10-01", end: "2026-10-01" },
      { start: "2026-11-02", end: "2026-11-04" },
    ]);
  });
});
