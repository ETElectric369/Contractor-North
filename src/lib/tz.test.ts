import { describe, it, expect } from "vitest";
import { payPeriodBounds, payPeriodForOffset, timeEntryGridSpan, todayStrInTz, tzMinutesOfDay, weekDayStrs } from "@/lib/tz";

const ANCHOR = "2026-01-05"; // a Monday

describe("payPeriodBounds", () => {
  it("biweekly: the anchor day starts a period (end exclusive, +14d)", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-05")).toEqual({ start: "2026-01-05", end: "2026-01-19" });
  });
  it("biweekly: a mid-period day maps to the same period", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-18")).toEqual({ start: "2026-01-05", end: "2026-01-19" });
  });
  it("biweekly: the end day rolls into the next period", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-19")).toEqual({ start: "2026-01-19", end: "2026-02-02" });
  });
  it("biweekly: a day before the anchor cascades backwards", () => {
    expect(payPeriodBounds("biweekly", ANCHOR, "2026-01-04")).toEqual({ start: "2025-12-22", end: "2026-01-05" });
  });
  it("weekly: 7-day periods from the anchor", () => {
    expect(payPeriodBounds("weekly", ANCHOR, "2026-01-06")).toEqual({ start: "2026-01-05", end: "2026-01-12" });
  });
  it("monthly: calendar month (end exclusive = 1st of next)", () => {
    expect(payPeriodBounds("monthly", ANCHOR, "2026-06-15")).toEqual({ start: "2026-06-01", end: "2026-07-01" });
  });
  it("semimonthly: splits at the 16th", () => {
    expect(payPeriodBounds("semimonthly", ANCHOR, "2026-06-15")).toEqual({ start: "2026-06-01", end: "2026-06-16" });
    expect(payPeriodBounds("semimonthly", ANCHOR, "2026-06-16")).toEqual({ start: "2026-06-16", end: "2026-07-01" });
  });
});

describe("payPeriodForOffset", () => {
  it("offset 0 is the current period, 1 the prior, 2 two back", () => {
    expect(payPeriodForOffset("biweekly", ANCHOR, "2026-01-20", 0)).toEqual({ start: "2026-01-19", end: "2026-02-02" });
    expect(payPeriodForOffset("biweekly", ANCHOR, "2026-01-20", 1)).toEqual({ start: "2026-01-05", end: "2026-01-19" });
    expect(payPeriodForOffset("biweekly", ANCHOR, "2026-01-20", 2)).toEqual({ start: "2025-12-22", end: "2026-01-05" });
  });
});

// THE grid mapping (Erik: "UTC timezone problem persists in the new calendars").
// An instant must land on its ORG-LOCAL day column at its org-local minutes —
// never the server's UTC day or the browser's zone.
const PT = "America/Los_Angeles";

describe("timeEntryGridSpan", () => {
  it("7:00 AM Pacific renders at 7:00 AM on the Pacific day column", () => {
    // 2026-07-14T14:00Z = 7:00 AM PDT on July 14
    const s = timeEntryGridSpan("2026-07-14T14:00:00Z", "2026-07-14T22:30:00Z", PT);
    expect(s).toEqual({ dayStr: "2026-07-14", startMin: 7 * 60, endMin: 15 * 60 + 30 });
  });
  it("a Pacific EVENING entry stays on its Pacific day (UTC would bucket it tomorrow)", () => {
    // 2026-07-15T02:30Z = 7:30 PM PDT on July 14 — toISOString().slice says "2026-07-15"
    const s = timeEntryGridSpan("2026-07-15T02:30:00Z", null, PT);
    expect(s.dayStr).toBe("2026-07-14");
    expect(s.startMin).toBe(19 * 60 + 30);
    expect(s.endMin).toBeNull(); // open entry → the grid runs it to the now line
  });
  it("an overnight shift clamps at the day edge (1440), not the next column", () => {
    // in 3:00 PM PDT Jul 14, out 2:00 AM PDT Jul 15
    const s = timeEntryGridSpan("2026-07-14T22:00:00Z", "2026-07-15T09:00:00Z", PT);
    expect(s).toEqual({ dayStr: "2026-07-14", startMin: 15 * 60, endMin: 1440 });
  });
  it("honors DST: winter 7:00 AM PST is still minute 420", () => {
    // 2026-01-14T15:00Z = 7:00 AM PST (UTC-8)
    const s = timeEntryGridSpan("2026-01-14T15:00:00Z", null, PT);
    expect(s).toMatchObject({ dayStr: "2026-01-14", startMin: 7 * 60 });
  });
  it("a zero/negative span still renders a visible pill (endMin > startMin)", () => {
    const s = timeEntryGridSpan("2026-07-14T14:00:00Z", "2026-07-14T14:00:00Z", PT);
    expect(s.endMin).toBe(s.startMin + 1);
  });
  it("maps by the org tz argument, not any ambient zone", () => {
    // Same instant, New York org: 10:00 AM EDT on July 14
    const s = timeEntryGridSpan("2026-07-14T14:00:00Z", null, "America/New_York");
    expect(s).toMatchObject({ dayStr: "2026-07-14", startMin: 10 * 60 });
  });
});

// The crew week-planner's day columns (crew_day_assignments, 0139). SIGNED offset,
// POSITIVE = FUTURE — deliberately the opposite of /timecards' back-paging weekRange.
describe("weekDayStrs", () => {
  it("monday week containing a Wednesday runs Mon..Sun", () => {
    // 2026-07-15 is a Wednesday
    expect(weekDayStrs("2026-07-15", "monday", 0)).toEqual([
      "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19",
    ]);
  });
  it("sunday-start orgs shift the same week back a day", () => {
    expect(weekDayStrs("2026-07-15", "sunday", 0)).toEqual([
      "2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18",
    ]);
  });
  it("today ON the week boundary starts its own week (Monday, monday-start)", () => {
    expect(weekDayStrs("2026-07-13", "monday", 0)[0]).toBe("2026-07-13");
    // …and a Sunday belongs to the PREVIOUS monday-start week.
    expect(weekDayStrs("2026-07-19", "monday", 0)[0]).toBe("2026-07-13");
  });
  it("positive offset pages FORWARD (next week), negative back", () => {
    expect(weekDayStrs("2026-07-15", "monday", 1)[0]).toBe("2026-07-20");
    expect(weekDayStrs("2026-07-15", "monday", -1)[0]).toBe("2026-07-06");
  });
  it("crosses month/year boundaries by real calendar days", () => {
    expect(weekDayStrs("2026-12-30", "monday", 0)).toEqual([
      "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
    ]);
  });
  it("garbage input never throws — falls back to a fixed week", () => {
    expect(() => weekDayStrs("2026-13-40", "monday", Number.NaN)).not.toThrow();
    expect(weekDayStrs("nope", "monday", 0)).toHaveLength(7);
  });
});

describe("appointment grid primitives (the /schedule week/day mapping)", () => {
  it("a 9:00 AM Pacific appointment sits at minute 540 on its Pacific day", () => {
    const iso = "2026-07-15T16:00:00Z"; // 9:00 AM PDT
    expect(todayStrInTz(PT, new Date(iso))).toBe("2026-07-15");
    expect(tzMinutesOfDay(iso, PT)).toBe(9 * 60);
  });
  it("a late Pacific appointment does not leak onto the UTC next-day column", () => {
    const iso = "2026-07-16T04:00:00Z"; // 9:00 PM PDT on July 15
    expect(todayStrInTz(PT, new Date(iso))).toBe("2026-07-15");
    expect(tzMinutesOfDay(iso, PT)).toBe(21 * 60);
  });
});
