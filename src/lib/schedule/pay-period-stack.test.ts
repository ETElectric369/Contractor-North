import { describe, it, expect } from "vitest";
import { hoursInPeriod, periodLabel, periodOpeningIn } from "./pay-period-stack";

// ET Electric: biweekly, anchored on a Monday.
const BIWEEKLY = { schedule: "biweekly" as const, anchor: "2026-01-05" };
const week = (mondayYmd: string): string[] => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(mondayYmd)!;
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
};

describe("the break line lands where a pay period actually opens", () => {
  it("marks the week a biweekly period starts", () => {
    const mark = periodOpeningIn(week("2026-01-05"), BIWEEKLY.schedule, BIWEEKLY.anchor);
    expect(mark?.start).toBe("2026-01-05");
    expect(mark?.midWeek).toBe(false);
  });

  // THE POINT OF THE LINE: for biweekly, every OTHER week has no break — which is what makes the
  // break a signal rather than a rule that repeats until nobody reads it.
  it("says nothing about the second week of a biweekly period", () => {
    expect(periodOpeningIn(week("2026-01-12"), BIWEEKLY.schedule, BIWEEKLY.anchor)).toBeNull();
  });

  it("marks every week when the schedule is weekly", () => {
    expect(periodOpeningIn(week("2026-01-05"), "weekly", BIWEEKLY.anchor)?.start).toBe("2026-01-05");
    expect(periodOpeningIn(week("2026-01-12"), "weekly", BIWEEKLY.anchor)?.start).toBe("2026-01-12");
  });

  // Semimonthly opens on the 16th, which is a Friday in Sept 2026 — the line must not imply the
  // period began on the Monday above it.
  it("catches a mid-week opening and says it is mid-week", () => {
    const mark = periodOpeningIn(week("2026-09-14"), "semimonthly", BIWEEKLY.anchor);
    expect(mark?.start).toBe("2026-09-16");
    expect(mark?.midWeek).toBe(true);
  });
});

describe("the period is named by the last day actually worked", () => {
  // payPeriodBounds is HALF-OPEN: end is the next period's first day. Printing it verbatim names a
  // period running a day into the next one, which is what payroll arguments are made of.
  it("does not run a day into the next period", () => {
    expect(periodLabel({ start: "2026-01-05", end: "2026-01-19" })).toBe("Jan 5–18, 2026");
  });

  it("names both months when the period straddles one", () => {
    expect(periodLabel({ start: "2026-08-31", end: "2026-09-14" })).toBe("Aug 31 – Sep 13, 2026");
  });

  it("hands back something honest for junk rather than inventing a range", () => {
    expect(periodLabel({ start: "", end: "" })).toBe(" – ");
  });
});

describe("the hours on the line are the hours in the period", () => {
  const rows = [
    { dayStr: "2026-01-04", hours: 8 },   // the period before — must not count
    { dayStr: "2026-01-05", hours: 8 },
    { dayStr: "2026-01-18", hours: 7.5 }, // the last day IS in it
    { dayStr: "2026-01-19", hours: 8 },   // the next period's first day — must not count
  ];

  it("counts the half-open range and nothing either side of it", () => {
    expect(hoursInPeriod(rows, { start: "2026-01-05", end: "2026-01-19" })).toBe(15.5);
  });

  it("is zero, not NaN, on an empty period", () => {
    expect(hoursInPeriod([], { start: "2026-01-05", end: "2026-01-19" })).toBe(0);
    expect(hoursInPeriod([{ dayStr: "2026-01-06", hours: NaN }], { start: "2026-01-05", end: "2026-01-19" })).toBe(0);
  });
});
