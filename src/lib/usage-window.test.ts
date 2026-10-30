import { describe, it, expect } from "vitest";
import { firstOfMonth, firstOfNextMonth, monthKeyFor, shortDate, todayIn, usageWindow } from "./usage-window";

/**
 * THE USAGE WINDOW'S MATH (cn-v1140): one percent, one state, one reset day, a forecast only when
 * the pace says the month will not last. Every state, the pace on either side of the reset, a
 * 31-day month, December into January, a zone where UTC is already tomorrow, a top-up lowering the
 * percent, the no-spend month, the trial's last day on the company's calendar.
 */
const TZ = "America/Los_Angeles";
const win = (spentUsd: number, today = "2026-10-15", extra: Partial<Parameters<typeof usageWindow>[0]> = {}) =>
  usageWindow({ spentUsd, budgetUsd: 10, today, timezone: TZ, ...extra });

describe("usageWindow — the states", () => {
  it("nothing spent is fine at 0% with no forecast, and resets on the 1st of next month", () => {
    expect(win(0)).toEqual({ pct: 0, state: "fine", resetOn: "2026-11-01", runOutOn: null, daysLeft: 17, monthKey: "2026-10" });
  });

  it("a little spent, on a pace that lasts the month, is fine", () => {
    // $2 by the 15th: pace $0.133/day, $8 left → 60 days → past the reset: no forecast.
    expect(win(2)).toMatchObject({ pct: 20, state: "fine", runOutOn: null });
  });

  it("50% or more WITH a run-out inside the month is watch; the same percent on a pace that lasts is fine", () => {
    // $5 on the 15th: pace 0.333/day, $5 left → 15 days → Oct 30, before Nov 1: watch, with the day.
    expect(win(5)).toMatchObject({ pct: 50, state: "watch", runOutOn: "2026-10-30" });
    // $5 on the 25th: pace 0.2/day, $5 left → 25 days → Nov 19, past the reset: fine, no forecast.
    expect(win(5, "2026-10-25")).toMatchObject({ pct: 50, state: "fine", runOutOn: null });
    // 49% with a run-out inside the month is still fine: the line is 50.
    expect(win(4.9, "2026-10-02")).toMatchObject({ pct: 49, state: "fine", runOutOn: "2026-10-05" });
  });

  it("80% is watch whatever the pace; 90% is almost; 100% is out, with no forecast", () => {
    expect(win(8, "2026-10-30")).toMatchObject({ pct: 80, state: "watch", runOutOn: null });
    expect(win(8.96, "2026-10-30")).toMatchObject({ pct: 89, state: "watch" }); // 89.6 FLOORS to 89: not almost yet
    expect(win(9, "2026-10-30")).toMatchObject({ pct: 90, state: "almost" });
    expect(win(9.4, "2026-10-30")).toMatchObject({ pct: 94, state: "almost" });
    expect(win(10)).toMatchObject({ pct: 100, state: "out", runOutOn: null });
    expect(win(23.7)).toMatchObject({ pct: 100, state: "out", runOutOn: null }); // never past 100
  });

  it("the percent is floored, never rounded: 99.5% is not out, 99.99% is not out, 100% is", () => {
    expect(win(9.95)).toMatchObject({ pct: 99, state: "almost" });
    expect(win(9.999)).toMatchObject({ pct: 99, state: "almost" });
    expect(win(7.99)).toMatchObject({ pct: 79 }); // not 80: the 80 notice waits for the real 80%
    expect(win(10)).toMatchObject({ pct: 100, state: "out" });
  });

  it("a run-out that lands today is today, not yesterday", () => {
    // $9.9 on the 1st: pace 9.9/day, $0.1 left → ceil(0.0101) = 1 day → Oct 2.
    expect(win(9.9, "2026-10-01")).toMatchObject({ pct: 99, state: "almost", runOutOn: "2026-10-02" });
  });
});

describe("usageWindow — the calendar", () => {
  it("a 31-day month counts its days to the 1st", () => {
    expect(win(0, "2026-10-01")).toMatchObject({ resetOn: "2026-11-01", daysLeft: 31 });
    expect(win(0, "2026-10-31")).toMatchObject({ resetOn: "2026-11-01", daysLeft: 1 });
    expect(win(0, "2026-02-10")).toMatchObject({ resetOn: "2026-03-01", daysLeft: 19 });
  });

  it("December resets on next January's 1st, and the month key is December's", () => {
    expect(win(3, "2026-12-20")).toMatchObject({ resetOn: "2027-01-01", monthKey: "2026-12", daysLeft: 12 });
    expect(firstOfNextMonth("2026-12-31")).toBe("2027-01-01");
    expect(firstOfMonth("2026-12")).toBe("2026-12-01");
  });

  it("a forecast past December's reset is no forecast", () => {
    // $5 on Dec 25: pace 0.2/day, $5 left → 25 days → Jan 19: past Jan 1.
    expect(win(5, "2026-12-25")).toMatchObject({ state: "fine", runOutOn: null });
    // $7 on Dec 25: pace 0.28/day, $3 left → 11 days → Jan 5: past Jan 1, so 70% is fine.
    expect(win(7, "2026-12-25")).toMatchObject({ pct: 70, state: "fine", runOutOn: null });
    // $7 on Dec 5: pace 1.4/day, $3 left → 3 days → Dec 8: watch.
    expect(win(7, "2026-12-05")).toMatchObject({ pct: 70, state: "watch", runOutOn: "2026-12-08" });
  });

  it("today comes from the company's zone, not UTC: at 8 PM Pacific on Oct 31 it is still October there, and the ring says so", () => {
    const at = new Date("2026-11-01T03:00:00Z"); // 8 PM Pacific, Oct 31
    expect(todayIn(TZ, at)).toBe("2026-10-31");
    expect(todayIn("UTC", at)).toBe("2026-11-01");
    expect(monthKeyFor(at, TZ)).toBe("2026-10");
    expect(monthKeyFor(at, "UTC")).toBe("2026-11");
    // A zone east of UTC where it is already tomorrow: Kiritimati is a day ahead of Honolulu.
    const noonUtc = new Date("2026-10-31T11:00:00Z");
    expect(todayIn("Pacific/Kiritimati", noonUtc)).toBe("2026-11-01");
    expect(todayIn("Pacific/Honolulu", noonUtc)).toBe("2026-10-31");
    expect(usageWindow({ spentUsd: 1, budgetUsd: 10, today: todayIn("Pacific/Kiritimati", noonUtc) })).toMatchObject({ monthKey: "2026-11", resetOn: "2026-12-01" });
  });

  it("a zone Intl does not know falls back to UTC rather than throwing; a malformed today is read in the zone given", () => {
    expect(todayIn("Mars/Olympus", new Date("2026-10-31T11:00:00Z"))).toBe("2026-10-31");
    expect(() => usageWindow({ spentUsd: 0, budgetUsd: 10, today: "yesterday", timezone: "UTC" })).not.toThrow();
    const w = usageWindow({ spentUsd: 0, budgetUsd: 10, today: "2026-02-30", timezone: "UTC" });
    expect(w.monthKey).toBe(todayIn("UTC").slice(0, 7));
    expect(w.resetOn).toBe(firstOfNextMonth(todayIn("UTC")));
  });
});

describe("usageWindow — the cap", () => {
  it("a top-up raises the cap and lowers the percent, and can turn out back into watch", () => {
    expect(win(10)).toMatchObject({ pct: 100, state: "out" });
    expect(win(10, "2026-10-15", { topupUsd: 10 })).toMatchObject({ pct: 50, state: "watch", runOutOn: "2026-10-30" });
    expect(win(10, "2026-10-15", { topupUsd: 40 })).toMatchObject({ pct: 20, state: "fine", runOutOn: null });
  });

  it("a plan with no budget reads as out the moment a cent is spent, and fine at nothing — never a division by zero", () => {
    expect(usageWindow({ spentUsd: 0.01, budgetUsd: 0, today: "2026-10-15" })).toMatchObject({ pct: 100, state: "out" });
    expect(usageWindow({ spentUsd: 0, budgetUsd: 0, today: "2026-10-15" })).toMatchObject({ pct: 0, state: "fine" });
  });

  it("nonsense in is zero: a negative spend, NaN, a missing top-up", () => {
    expect(usageWindow({ spentUsd: -4, budgetUsd: 10, today: "2026-10-15" })).toMatchObject({ pct: 0, state: "fine" });
    expect(usageWindow({ spentUsd: Number.NaN, budgetUsd: 10, today: "2026-10-15", topupUsd: Number.NaN })).toMatchObject({ pct: 0, state: "fine" });
  });
});

describe("usageWindow — the trial", () => {
  it("the trial's last day is read on the company's calendar", () => {
    // Ends at 2 AM UTC on Nov 8 = 7 PM Pacific on Nov 7.
    expect(win(0, "2026-10-30", { trialEndsAt: "2026-11-08T02:00:00Z" }).trialEndsOn).toBe("2026-11-07");
    expect(usageWindow({ spentUsd: 0, budgetUsd: 10, today: "2026-10-30", timezone: "UTC", trialEndsAt: "2026-11-08T02:00:00Z" }).trialEndsOn).toBe("2026-11-08");
  });

  it("no trial, or a trial end that is not a date, leaves the field out", () => {
    expect("trialEndsOn" in win(0)).toBe(false);
    expect("trialEndsOn" in win(0, "2026-10-30", { trialEndsAt: null })).toBe(false);
    expect("trialEndsOn" in win(0, "2026-10-30", { trialEndsAt: "soon" })).toBe(false);
  });
});

describe("shortDate — the day under the ring, in the person's language", () => {
  it("English reads Nov 1, Spanish 1 nov; a value that is not a date comes back as it was", () => {
    expect(shortDate("2026-11-01", "en")).toBe("Nov 1");
    expect(shortDate("2026-11-01", "es")).toBe("1 nov");
    expect(shortDate("2027-01-01", "en")).toBe("Jan 1");
    expect(shortDate("2027-01-01", "es")).toBe("1 ene");
    expect(shortDate("2026-10-30", null)).toBe("Oct 30");
    expect(shortDate("never", "en")).toBe("never");
  });
});
