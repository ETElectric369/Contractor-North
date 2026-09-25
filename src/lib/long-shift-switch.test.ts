import { describe, it, expect } from "vitest";
import { candidateStartMs, forgottenReason, isForgottenShift, pickLongShiftSteps } from "./long-shift";

/**
 * AUDIT v994: THE SHIFT, NOT THE PIECE (SW1), AND WHICH SHEET SAYS WHAT (SI9).
 *
 * Since 0288 a Switch Job cuts the running entry, so the open row may be only the part since the
 * last switch. Erik, 2026-09-24: the twelve hours count from the START OF THE DAY.
 */
const H = 3_600_000;
const TZ = "America/Los_Angeles";
const START = Date.parse("2001-01-01T16:00:00Z"); // 8:00 AM Pacific, a day nobody worked

describe("pickLongShiftSteps after a Switch Job (SW1)", () => {
  // Brian in at 7:00 AM Pacific (15:00Z), switched at 3:00 PM (23:00Z), forgot to clock out.
  const running = {
    id: "b",
    clock_in: "2001-01-01T23:00:00Z",
    shift_start: "2001-01-01T15:00:00Z",
    long_shift_warned_at: null,
    long_shift_nudged_at: null,
  };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("the bell comes at 5:00 PM, ten hours into the SHIFT, not at 1:00 AM", () => {
    expect(ids(pickLongShiftSteps([running], Date.parse("2001-01-02T01:00:00Z"), TZ).bell)).toEqual(["b"]);
    // Read from the piece (the old behaviour), 5 PM is only two hours in.
    expect(pickLongShiftSteps([{ ...running, shift_start: null }], Date.parse("2001-01-02T01:00:00Z"), TZ).bell).toEqual([]);
  });

  it("the question and the buzz come at 7:00 PM, twelve hours in, not the next morning", () => {
    expect(ids(pickLongShiftSteps([running], Date.parse("2001-01-02T03:00:00Z"), TZ).nudge)).toEqual(["b"]);
  });

  it("a step that went out on the piece before the switch is not sent again on the new piece", () => {
    const r = pickLongShiftSteps([{ ...running, shift_warned: true }], Date.parse("2001-01-02T03:00:00Z"), TZ);
    expect(r.bell).toEqual([]);
    expect(ids(r.nudge)).toEqual(["b"]);
    expect(
      pickLongShiftSteps([{ ...running, shift_warned: true, shift_nudged: true }], Date.parse("2001-01-02T04:00:00Z"), TZ),
    ).toEqual({ bell: [], nudge: [] });
  });

  it("the night still holds the push, counted from the shift", () => {
    // In at 1:00 PM Pacific (21:00Z), switched at 6 PM; 12 hours is 1:00 AM, inside the hold.
    const late = { ...running, clock_in: "2001-01-02T02:00:00Z", shift_start: "2001-01-01T21:00:00Z" };
    const r = pickLongShiftSteps([late], Date.parse("2001-01-02T09:00:00Z"), TZ);
    expect(ids(r.bell)).toEqual(["b"]);
    expect(r.nudge).toEqual([]);
  });

  it("candidateStartMs reads the shift's start, else the clock-in", () => {
    expect(candidateStartMs(running)).toBe(Date.parse("2001-01-01T15:00:00Z"));
    expect(candidateStartMs({ ...running, shift_start: null })).toBe(Date.parse("2001-01-01T23:00:00Z"));
    expect(candidateStartMs({ ...running, shift_start: "not a time" })).toBe(Date.parse("2001-01-01T23:00:00Z"));
  });
});

describe("forgottenReason: the office sheet says WHY its clock-out starts empty (SI9)", () => {
  it("under twelve hours, begun today: nothing to say", () => {
    expect(forgottenReason(START, START + 5 * H, TZ)).toBeNull();
  });
  it("twelve hours of the shift: long", () => {
    expect(forgottenReason(START, START + 12 * H, TZ)).toBe("long");
    expect(isForgottenShift(START, START + 12 * H, TZ)).toBe(true);
  });
  it("a 7 PM callback stopped at 12:40 AM is an earlier day, never 'a long time'", () => {
    // 7 PM Pacific Jan 1 = 03:00Z Jan 2; 12:40 AM Pacific Jan 2 = 08:40Z.
    expect(forgottenReason(Date.parse("2001-01-02T03:00:00Z"), Date.parse("2001-01-02T08:40:00Z"), TZ)).toBe("earlier_day");
  });
  it("an unreadable start is no reason", () => {
    expect(forgottenReason(NaN, START, TZ)).toBeNull();
  });
});
