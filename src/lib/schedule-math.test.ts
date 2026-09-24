import { describe, expect, it } from "vitest";
import { keepWorkedDays, shiftSegmentCovering } from "./schedule-math";

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

  it("kept days next to the new window merge into one range, and duplicates collapse", () => {
    const before = [{ start: "2026-09-21", end: "2026-09-23" }];
    const moved = shiftSegmentCovering(before, "2026-09-21", "2026-09-24"); // 24th-26th
    const r = keepWorkedDays(before, moved, ["2026-09-22", "2026-09-23", "2026-09-23"], "2026-09-24");
    expect(r.kept).toEqual(["2026-09-22", "2026-09-23"]);
    expect(r.segments).toEqual([{ start: "2026-09-22", end: "2026-09-26" }]);
  });

  it("ignores malformed worked days", () => {
    const r = keepWorkedDays([{ start: "2026-09-22", end: "2026-09-22" }], [], ["", "garbage"], "2026-09-24");
    expect(r.kept).toEqual([]);
    expect(r.segments).toEqual([]);
  });
});
