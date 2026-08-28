import { describe, it, expect } from "vitest";
import { dayLabel, spanLabel } from "./span-label";

// Local Dates on purpose. `new Date("2026-08-27")` is UTC midnight and reads as the 26th west of
// Greenwich — the bug that once flagged every lead due today as overdue.
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe("the year is always there", () => {
  it("names it even when it is this year — the whole point of Erik's ask", () => {
    expect(spanLabel(d(2026, 8, 25), d(2026, 8, 31), { month: "long" })).toBe("August 25–31, 2026");
  });

  it("names it on the short form too", () => {
    expect(spanLabel(d(2026, 8, 23), d(2026, 9, 19))).toBe("Aug 23 – Sep 19, 2026");
  });

  it("is on a single day as well", () => {
    expect(dayLabel(d(2026, 8, 31))).toContain("2026");
    expect(dayLabel(d(2026, 8, 31))).toContain("Monday");
  });
});

describe("a week that crosses something says so", () => {
  it("names both months", () => {
    expect(spanLabel(d(2026, 8, 31), d(2026, 9, 6), { month: "short" })).toBe("Aug 31 – Sep 6, 2026");
  });

  // The case continuous scroll made real: 26 weeks back and 52 forward crosses New Year twice.
  it("names BOTH years across a new year, because both are true", () => {
    expect(spanLabel(d(2026, 12, 28), d(2027, 1, 3), { month: "short" }))
      .toBe("Dec 28, 2026 – Jan 3, 2027");
  });

  it("doesn't collapse a same-month span in different years", () => {
    // Not a week, but the rule must not read month-equality without year-equality.
    expect(spanLabel(d(2026, 2, 9), d(2027, 2, 15), { month: "short" }))
      .toBe("Feb 9, 2026 – Feb 15, 2027");
  });
});

describe("the shape stays readable", () => {
  it("uses an en dash without spaces inside one month, spaced across months", () => {
    expect(spanLabel(d(2026, 3, 1), d(2026, 3, 7), { month: "long" })).toBe("March 1–7, 2026");
    expect(spanLabel(d(2026, 3, 30), d(2026, 4, 5), { month: "long" })).toBe("March 30 – April 5, 2026");
  });

  it("handles a single day given as both ends", () => {
    expect(spanLabel(d(2026, 8, 31), d(2026, 8, 31), { month: "long" })).toBe("August 31–31, 2026");
  });
});
