import { describe, it, expect } from "vitest";
import { addDaySegment, applyRangeEdit, mergeSegments, shiftSegmentCovering } from "@/lib/schedule-math";

/**
 * Schedule math had ZERO tests while being the exact bug class the calendar gut
 * exists to kill: setJobScheduleRanges REPLACES all segments, so any move/place
 * that computes less than the FULL new set silently erases multi-range schedules
 * and worked-history days. These cases pin the read-modify-write contract.
 */
describe("shiftSegmentCovering — move one range, keep the rest", () => {
  it("shifts a single window to the new day, preserving its length", () => {
    expect(shiftSegmentCovering([{ start: "2026-07-06", end: "2026-07-08" }], "2026-07-07", "2026-07-13")).toEqual([
      { start: "2026-07-13", end: "2026-07-15" }, // 3 days in, 3 days out
    ]);
  });

  it("null fromDate moves the only/earliest segment", () => {
    expect(shiftSegmentCovering([{ start: "2026-07-06", end: "2026-07-06" }], null, "2026-07-10")).toEqual([
      { start: "2026-07-10", end: "2026-07-10" },
    ]);
    // multi-segment + null: the EARLIEST moves, the later one stays
    expect(
      shiftSegmentCovering(
        [
          { start: "2026-07-20", end: "2026-07-21" },
          { start: "2026-07-06", end: "2026-07-07" },
        ],
        null,
        "2026-07-10",
      ),
    ).toEqual([
      { start: "2026-07-10", end: "2026-07-11" },
      { start: "2026-07-20", end: "2026-07-21" },
    ]);
  });

  it("moves ONLY the segment covering fromDate on a multi-range job", () => {
    const segs = [
      { start: "2026-07-06", end: "2026-07-09" }, // this week
      { start: "2026-07-14", end: "2026-07-17" }, // next week — must survive
    ];
    expect(shiftSegmentCovering(segs, "2026-07-08", "2026-06-29")).toEqual([
      { start: "2026-06-29", end: "2026-07-02" },
      { start: "2026-07-14", end: "2026-07-17" },
    ]);
  });

  it("a shift landing on/next to another range merges with it", () => {
    const segs = [
      { start: "2026-07-06", end: "2026-07-07" },
      { start: "2026-07-15", end: "2026-07-16" },
    ];
    // 2-day segment moved to the 14th → covers 14-15, overlapping the 15-16 range
    expect(shiftSegmentCovering(segs, "2026-07-06", "2026-07-14")).toEqual([
      { start: "2026-07-14", end: "2026-07-16" },
    ]);
    // adjacent (ends the day before the other starts) coalesces too
    expect(shiftSegmentCovering(segs, "2026-07-06", "2026-07-13")).toEqual([
      { start: "2026-07-13", end: "2026-07-16" },
    ]);
  });

  it("a fromDate no segment covers (stale mirror day) falls back to the earliest", () => {
    const segs = [
      { start: "2026-07-06", end: "2026-07-07" },
      { start: "2026-07-14", end: "2026-07-15" },
    ];
    expect(shiftSegmentCovering(segs, "2026-07-10", "2026-07-20")).toEqual([
      { start: "2026-07-14", end: "2026-07-15" },
      { start: "2026-07-20", end: "2026-07-21" },
    ]);
  });

  it("empty segments → a one-day placement (a dateless job's move is a place)", () => {
    expect(shiftSegmentCovering([], "2026-07-06", "2026-07-10")).toEqual([{ start: "2026-07-10", end: "2026-07-10" }]);
    expect(shiftSegmentCovering([], null, "2026-07-10")).toEqual([{ start: "2026-07-10", end: "2026-07-10" }]);
  });

  it("survives a DST boundary without growing or shrinking the window", () => {
    // US spring-forward 2026 is March 8 — 3 days in, 3 days out across it.
    expect(shiftSegmentCovering([{ start: "2026-03-02", end: "2026-03-04" }], null, "2026-03-07")).toEqual([
      { start: "2026-03-07", end: "2026-03-09" },
    ]);
  });
});

describe("addDaySegment — union-place, never a replace", () => {
  it("keeps a needs-return job's past segments (the history MUST survive)", () => {
    const history = [{ start: "2026-06-22", end: "2026-06-24" }];
    expect(addDaySegment(history, "2026-07-10")).toEqual([
      { start: "2026-06-22", end: "2026-06-24" },
      { start: "2026-07-10", end: "2026-07-10" },
    ]);
  });

  it("empty → a single one-day segment", () => {
    expect(addDaySegment([], "2026-07-10")).toEqual([{ start: "2026-07-10", end: "2026-07-10" }]);
  });

  it("a day inside or adjacent to an existing range coalesces instead of duplicating", () => {
    expect(addDaySegment([{ start: "2026-07-06", end: "2026-07-08" }], "2026-07-07")).toEqual([
      { start: "2026-07-06", end: "2026-07-08" },
    ]);
    expect(addDaySegment([{ start: "2026-07-06", end: "2026-07-08" }], "2026-07-09")).toEqual([
      { start: "2026-07-06", end: "2026-07-09" },
    ]);
  });
});

describe("applyRangeEdit — edited bound wins, the other follows when crossed", () => {
  it("start pushed past end drags end to match (the bug-report flow: move a job later, start first)", () => {
    expect(applyRangeEdit({ start: "2026-07-07", end: "2026-07-11" }, { start: "2026-07-21" })).toEqual({
      start: "2026-07-21",
      end: "2026-07-21",
    });
  });

  it("end pulled before start drags start to match (move a job earlier, end first)", () => {
    expect(applyRangeEdit({ start: "2026-07-07", end: "2026-07-11" }, { end: "2026-07-03" })).toEqual({
      start: "2026-07-03",
      end: "2026-07-03",
    });
  });

  it("non-crossing edits pass through untouched", () => {
    expect(applyRangeEdit({ start: "2026-07-07", end: "2026-07-11" }, { start: "2026-07-09" })).toEqual({
      start: "2026-07-09",
      end: "2026-07-11",
    });
    expect(applyRangeEdit({ start: "2026-07-07", end: "2026-07-11" }, { end: "2026-07-30" })).toEqual({
      start: "2026-07-07",
      end: "2026-07-30",
    });
  });

  it("same-day (start === end) is a VALID one-day job — no adjustment, no error", () => {
    expect(applyRangeEdit({ start: "2026-07-07", end: "2026-07-11" }, { start: "2026-07-11" })).toEqual({
      start: "2026-07-11",
      end: "2026-07-11",
    });
    expect(applyRangeEdit({ start: "2026-07-07", end: "2026-07-11" }, { end: "2026-07-07" })).toEqual({
      start: "2026-07-07",
      end: "2026-07-07",
    });
  });

  it("blank or partial bounds pass through — a half-filled row isn't adjusted", () => {
    expect(applyRangeEdit({ start: "", end: "" }, { start: "2026-07-07" })).toEqual({
      start: "2026-07-07",
      end: "",
    });
    expect(applyRangeEdit({ start: "", end: "" }, { end: "2026-07-07" })).toEqual({
      start: "",
      end: "2026-07-07",
    });
  });

  it("both bounds patched inverted rights to a one-day range at the start (matches the server clamp)", () => {
    expect(applyRangeEdit({ start: "", end: "" }, { start: "2026-07-11", end: "2026-07-07" })).toEqual({
      start: "2026-07-11",
      end: "2026-07-11",
    });
  });
});

describe("mergeSegments — the shared coalescer", () => {
  it("merges overlaps + adjacency, sorts, and rights inverted rows", () => {
    expect(
      mergeSegments([
        { start: "2026-07-10", end: "2026-07-08" }, // inverted → one day (07-10)
        { start: "2026-07-06", end: "2026-07-07" },
        { start: "2026-07-08", end: "2026-07-09" }, // adjacent to both neighbors
      ]),
    ).toEqual([{ start: "2026-07-06", end: "2026-07-10" }]);
  });

  it("leaves gapped ranges apart and drops malformed rows", () => {
    expect(
      mergeSegments([
        { start: "2026-07-06", end: "2026-07-07" },
        { start: "not-a-date", end: "2026-07-08" },
        { start: "2026-07-14", end: "2026-07-15" },
      ]),
    ).toEqual([
      { start: "2026-07-06", end: "2026-07-07" },
      { start: "2026-07-14", end: "2026-07-15" },
    ]);
  });
});
