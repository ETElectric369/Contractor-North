import { describe, it, expect } from "vitest";
import { daysNeeded, parseDuration, workingDaysFrom, durationLabel } from "./work-shape";

describe("type how long it takes, the way you'd say it", () => {
  it("reads the shapes a person actually writes", () => {
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45 min")).toBe(45);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("3 hours")).toBe(180);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("2 hours 15")).toBe(135);
  });

  it("counts a DAY as a working day, never 24 hours", () => {
    expect(parseDuration("1d")).toBe(480);
    expect(parseDuration("3 days")).toBe(1440);
    expect(parseDuration("1 week")).toBe(2400); // five working days
  });

  it("treats a bare number as minutes — '90' is a 90-minute visit, not two days", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("480")).toBe(480);
  });

  // NULL IS NOT ZERO. An unreadable entry must leave the old value alone rather than store a
  // confident wrong answer — the caller says so out loud instead.
  it("refuses what it cannot read", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("a while")).toBeNull();
    expect(parseDuration("soon-ish")).toBeNull();
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("-3h")).toBeNull();
    expect(parseDuration("99 days")).toBeNull(); // past the column's 30-day ceiling
  });

  it("round-trips through the label he'll see", () => {
    expect(durationLabel(parseDuration("45m"))).toBe("45m");
    expect(durationLabel(parseDuration("1.5h"))).toBe("1.5h");
    expect(durationLabel(parseDuration("3 days"))).toBe("3 days");
  });
});

describe("three days means three days on the calendar", () => {
  // Erik: "i just set it for 3 days and it only showed up on the schedule for 1 day."
  it("turns a size into a number of days", () => {
    expect(daysNeeded(1440)).toBe(3);
    expect(daysNeeded(960)).toBe(2);
    expect(daysNeeded(480)).toBe(1);
    expect(daysNeeded(120)).toBe(1);
    expect(daysNeeded(600)).toBe(2); // a day and a bit still occupies two days
  });

  it("gives an unsized job one day, never zero", () => {
    expect(daysNeeded(null)).toBe(1);
    expect(daysNeeded(0)).toBe(1);
  });

  it("runs consecutive days and skips the weekend", () => {
    // Wed 2026-09-02 → Wed, Thu, Fri
    expect(workingDaysFrom("2026-09-02", 3)).toEqual(["2026-09-02", "2026-09-03", "2026-09-04"]);
    // Thu 2026-09-03 → Thu, Fri, then MONDAY
    expect(workingDaysFrom("2026-09-03", 3)).toEqual(["2026-09-03", "2026-09-04", "2026-09-07"]);
  });

  // THE DAY HE TAPPED IS ALWAYS DAY ONE — second-guessing the one day he explicitly chose would
  // be the app knowing better than the person.
  it("honours a weekend start he chose himself", () => {
    expect(workingDaysFrom("2026-09-05", 2)).toEqual(["2026-09-05", "2026-09-07"]); // Sat, then Mon
  });

  it("does not slip a day west of UTC", () => {
    // Parsed as a LOCAL date; new Date("2026-09-02") would be the 1st in Truckee.
    expect(workingDaysFrom("2026-09-02", 1)).toEqual(["2026-09-02"]);
  });

  it("returns nothing for a non-date rather than guessing", () => {
    expect(workingDaysFrom("nope", 3)).toEqual([]);
  });
});
