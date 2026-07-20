import { describe, it, expect } from "vitest";
import { buildShiftSpan, crossesMidnight, spanGrossHours } from "./shift-span";

describe("crossesMidnight", () => {
  it("is true when the end time is earlier in the day than the start", () => {
    expect(crossesMidnight("18:00", "02:00")).toBe(true);
    expect(crossesMidnight("23:30", "00:15")).toBe(true);
  });
  it("is false for an ordinary day shift", () => {
    expect(crossesMidnight("07:00", "16:00")).toBe(false);
  });
  it("is false when the times are equal (a typo, not an overnight)", () => {
    expect(crossesMidnight("08:00", "08:00")).toBe(false);
  });
  it("is false on unparseable input rather than guessing", () => {
    expect(crossesMidnight("", "02:00")).toBe(false);
  });
});

describe("buildShiftSpan — overnight shifts are editable", () => {
  // THE BUG: both office modals rebuilt clock-in AND clock-out from one date, so a
  // 6pm–2am night service call came out as clock_out <= clock_in and the save was
  // rejected ("End must be after start") — the shift could not be entered or corrected.
  it("rolls the end onto the next day when it precedes the start", () => {
    const span = buildShiftSpan("2026-07-20", "18:00", "02:00")!;
    expect(span.overnight).toBe(true);
    expect(spanGrossHours(span)).toBeCloseTo(8, 6);
    expect(span.clockOut.getTime()).toBeGreaterThan(span.clockIn.getTime());
    expect(span.clockOut.getDate()).toBe(21);
  });

  it("leaves an ordinary day shift on its own date", () => {
    const span = buildShiftSpan("2026-07-20", "07:00", "15:30")!;
    expect(span.overnight).toBe(false);
    expect(spanGrossHours(span)).toBeCloseTo(8.5, 6);
    expect(span.clockOut.getDate()).toBe(20);
  });

  it("does NOT invent 24 hours when start and end are equal", () => {
    const span = buildShiftSpan("2026-07-20", "08:00", "08:00")!;
    expect(span.overnight).toBe(false);
    // Zero span ⇒ the caller's "End must be after start" still fires; hours are never guessed.
    expect(spanGrossHours(span)).toBe(0);
  });

  it("honors an explicit end date over the derivation", () => {
    // The 30-hour forgotten-clock-out the office comes to /timecards to fix: the edit
    // modal seeds the stored end date, so opening and saving can't truncate it to 6h.
    const span = buildShiftSpan("2026-07-20", "07:00", "13:00", "2026-07-21")!;
    expect(span.overnight).toBe(true);
    expect(spanGrossHours(span)).toBeCloseTo(30, 6);
  });

  it("an explicit end date equal to the start date is a same-day shift", () => {
    const span = buildShiftSpan("2026-07-20", "07:00", "15:00", "2026-07-20")!;
    expect(span.overnight).toBe(false);
    expect(spanGrossHours(span)).toBeCloseTo(8, 6);
  });

  it("returns null on missing/garbage input instead of a bogus span", () => {
    expect(buildShiftSpan("", "07:00", "15:00")).toBeNull();
    expect(buildShiftSpan("2026-07-20", "", "15:00")).toBeNull();
    expect(buildShiftSpan("2026-07-20", "07:00", "")).toBeNull();
    expect(buildShiftSpan("not-a-date", "07:00", "15:00")).toBeNull();
    expect(buildShiftSpan("2026-07-20", "07:00", "15:00", "not-a-date")).toBeNull();
  });

  it("keeps the stated wall-clock end time across a DST boundary", () => {
    // US spring-forward night (2026-03-08). setDate() keeps 06:00 as 06:00 local; the
    // paid SPAN is what shortens, exactly like the real clock on the wall.
    const span = buildShiftSpan("2026-03-07", "22:00", "06:00")!;
    expect(span.overnight).toBe(true);
    expect(span.clockOut.getHours()).toBe(6);
    expect(spanGrossHours(span)).toBeGreaterThan(0);
  });
});

describe("spanGrossHours", () => {
  it("is 0 for a null span or an end at/behind the start", () => {
    expect(spanGrossHours(null)).toBe(0);
    const bad = buildShiftSpan("2026-07-20", "07:00", "07:00");
    expect(spanGrossHours(bad)).toBe(0);
  });
});
