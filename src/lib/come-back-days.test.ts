import { describe, it, expect } from "vitest";
import {
  addDays,
  backWords,
  checkComeBackDay,
  comeBackDay,
  comeBackDue,
  isYmd,
  nextMonday,
  offHoldWords,
  PICK_TODAY_OR_LATER,
  resolveComeBack,
  shortDay,
} from "./come-back-days";

/**
 * EVERY WAIT HAS A DAY (0366). The chips work from the COMPANY's today, as calendar days: across a
 * Sunday and a Monday, across a month and a year end, and a picked day is today or later.
 */
const SUNDAY = "2026-09-27";
const MONDAY = "2026-09-28";

describe("the chips, from the company's today", () => {
  it("on a Sunday: Tomorrow and Mon are the same day, In A Week is next Sunday", () => {
    expect(comeBackDay(SUNDAY, "tomorrow")).toBe("2026-09-28");
    expect(comeBackDay(SUNDAY, "monday")).toBe("2026-09-28");
    expect(comeBackDay(SUNDAY, "week")).toBe("2026-10-04");
  });

  it("on a Monday: Mon is the NEXT Monday, never today", () => {
    expect(comeBackDay(MONDAY, "tomorrow")).toBe("2026-09-29");
    expect(comeBackDay(MONDAY, "monday")).toBe("2026-10-05");
    expect(comeBackDay(MONDAY, "week")).toBe("2026-10-05");
  });

  it("every other day of the week finds the Monday after it", () => {
    const want: Record<string, string> = {
      "2026-09-29": "2026-10-05", // Tue
      "2026-09-30": "2026-10-05", // Wed
      "2026-10-01": "2026-10-05", // Thu
      "2026-10-02": "2026-10-05", // Fri
      "2026-10-03": "2026-10-05", // Sat
    };
    for (const [d, m] of Object.entries(want)) expect(nextMonday(d), d).toBe(m);
  });

  it("walks the calendar across a month end, a year end and a leap day", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(nextMonday("2026-12-31")).toBe("2027-01-04");
  });
});

describe("a picked day", () => {
  it("today or later is fine; yesterday says so in words", () => {
    expect(checkComeBackDay(SUNDAY, SUNDAY)).toEqual({ ok: true, day: SUNDAY });
    expect(checkComeBackDay(SUNDAY, "2026-10-15")).toEqual({ ok: true, day: "2026-10-15" });
    expect(checkComeBackDay(SUNDAY, "2026-09-26")).toEqual({ ok: false, error: PICK_TODAY_OR_LATER });
    expect(PICK_TODAY_OR_LATER).toBe("Pick today or later");
  });

  it("anything that isn't a real day asks for one", () => {
    for (const bad of ["", "2026-02-30", "10/3/2026", null, 5, "2026-9-3"]) {
      expect(checkComeBackDay(SUNDAY, bad as never), String(bad)).toEqual({ ok: false, error: "Pick a day." });
    }
    expect(isYmd("2028-02-29")).toBe(true);
    expect(isYmd("2027-02-29")).toBe(false);
  });

  it("what a door sends resolves the same way on the server: a chip's name or a date", () => {
    expect(resolveComeBack(SUNDAY, { pick: "week" })).toEqual({ ok: true, day: "2026-10-04" });
    expect(resolveComeBack(MONDAY, { pick: "monday" })).toEqual({ ok: true, day: "2026-10-05" });
    expect(resolveComeBack(SUNDAY, { date: "2026-10-09" })).toEqual({ ok: true, day: "2026-10-09" });
    expect(resolveComeBack(SUNDAY, { date: "2026-09-01" })).toEqual({ ok: false, error: PICK_TODAY_OR_LATER });
    expect(resolveComeBack(SUNDAY, { pick: "someday" as never })).toEqual({ ok: false, error: "Pick a day." });
    expect(resolveComeBack(SUNDAY, null)).toEqual({ ok: false, error: "Pick a day." });
  });
});

describe("the words", () => {
  it("'Back Oct 3', 'Back Today' once it has come, and 'No Day Set' for a hold from before the day existed", () => {
    expect(backWords("2026-10-03", SUNDAY)).toBe("Back Oct 3");
    expect(backWords(SUNDAY, SUNDAY)).toBe("Back Today");
    expect(backWords("2026-09-20", SUNDAY)).toBe("Back Today");
    expect(backWords(null, SUNDAY)).toBe("No Day Set");
    expect(shortDay("2027-01-04")).toBe("Jan 4");
  });

  it("due: today, a day gone by, or no day at all; not a day still ahead", () => {
    expect(comeBackDue(SUNDAY, SUNDAY)).toBe(true);
    expect(comeBackDue("2026-09-01", SUNDAY)).toBe(true);
    expect(comeBackDue(null, SUNDAY)).toBe(true);
    expect(comeBackDue("2026-09-28", SUNDAY)).toBe(false);
  });

  it("a hold that comes off by itself says which job and why, in one sentence", () => {
    expect(offHoldWords({ jobNumber: "J-048", reason: "waiting on the permit" })).toBe(
      "J-048 was on hold (waiting on the permit). It's off hold now.",
    );
    expect(offHoldWords({ jobNumber: "J-048", reason: "Waiting on the permit." })).toBe(
      "J-048 was on hold (Waiting on the permit). It's off hold now.",
    );
    expect(offHoldWords({ jobNumber: null, name: "Tanager Ln", reason: null })).toBe("Tanager Ln was on hold. It's off hold now.");
    expect(offHoldWords({})).toBe("That job was on hold. It's off hold now.");
  });
});
