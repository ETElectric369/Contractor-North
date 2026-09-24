import { describe, it, expect } from "vitest";
import {
  LONG_SHIFT_HOURS,
  MAX_SHIFT_HOURS,
  isLongOpenShift,
  stopWindow,
  stopProblem,
  quietHold,
  pickLongShiftNudges,
  startedEarlierDay,
} from "./long-shift";

const H = 3_600_000;
const TZ = "America/Los_Angeles";
// 2001-01-01 08:00 Pacific (PST, UTC-8). No real shift is on this day.
const START = Date.parse("2001-01-01T16:00:00Z");

describe("isLongOpenShift: one threshold, ten hours", () => {
  it("is the constants the rest of the app reads", () => {
    expect(LONG_SHIFT_HOURS).toBe(10);
    expect(MAX_SHIFT_HOURS).toBe(18);
  });

  it("9.9 hours is an ordinary long day", () => {
    expect(isLongOpenShift(START, START + 9.9 * H)).toBe(false);
  });

  it("10.0 hours is a clock to ask about", () => {
    expect(isLongOpenShift(START, START + 10 * H)).toBe(true);
  });

  it("a 7 PM callback that crosses midnight is not forgotten", () => {
    const sevenPm = Date.parse("2001-01-02T03:00:00Z"); // Jan 1, 7:00 PM Pacific
    expect(isLongOpenShift(sevenPm, sevenPm + 5.5 * H)).toBe(false);
  });

  it("a garbage clock-in is never a long shift", () => {
    expect(isLongOpenShift(NaN, START)).toBe(false);
  });
});

describe("stopWindow: a minute after the clock-in, up to now, never past 18 hours", () => {
  it("is bounded by now on a short shift", () => {
    const now = START + 5 * H;
    expect(stopWindow(START, now)).toEqual({ minMs: START + 60_000, maxMs: now + 60_000 });
  });

  it("is bounded by the 18-hour ceiling on a clock left running for days", () => {
    const now = START + 40 * H;
    expect(stopWindow(START, now)).toEqual({ minMs: START + 60_000, maxMs: START + 18 * H });
  });
});

describe("stopProblem: a plain sentence for every wrong stop time", () => {
  const now = START + 30 * H;
  const base = { startMs: START, nowMs: now, lunchMin: 0, who: "he" as const, tz: TZ };

  it("a stop before the start names the start", () => {
    expect(stopProblem({ ...base, stopMs: START - H })).toBe("Pick a stop time after 8:00 AM.");
    expect(stopProblem({ ...base, stopMs: START })).toBe("Pick a stop time after 8:00 AM.");
  });

  it("a stop in the future is refused", () => {
    expect(stopProblem({ ...base, startMs: now - 2 * H, stopMs: now + 2 * H })).toBe("That time hasn't happened yet.");
  });

  it("a stop more than 18 hours in says so, for the office and for the crew", () => {
    expect(stopProblem({ ...base, stopMs: START + 19 * H })).toBe(
      "That's more than 18 hours after the clock-in. Pick when the shift really stopped.",
    );
    expect(stopProblem({ ...base, who: "you", stopMs: START + 19 * H })).toBe(
      "That's more than 18 hours after you clocked in. Pick when you really stopped.",
    );
  });

  it("a lunch as long as the shift is refused", () => {
    expect(stopProblem({ ...base, stopMs: START + 0.5 * H, lunchMin: 30 })).toBe("The lunch is longer than the shift.");
  });

  it("a real stop passes, at both edges of the window", () => {
    expect(stopProblem({ ...base, stopMs: START + 9 * H, lunchMin: 30 })).toBeNull();
    expect(stopProblem({ ...base, stopMs: START + 60_000 })).toBeNull();
    expect(stopProblem({ ...base, stopMs: START + 18 * H })).toBeNull();
  });

  it("never uses an em-dash", () => {
    for (const stopMs of [START - H, now + 3 * H, START + 19 * H]) {
      expect(stopProblem({ ...base, stopMs }) ?? "").not.toMatch(/—/);
    }
  });
});

describe("quietHold: nobody is woken up about a clock", () => {
  // 2001-01-01 is PST: 20:59 Pacific = 04:59Z next day.
  const at = (hm: string, day = "2001-01-01") => {
    const [h, m] = hm.split(":").map(Number);
    return Date.parse(`${day}T00:00:00Z`) + (h + 8) * H + m * 60_000;
  };
  it("20:59 is not held", () => expect(quietHold(at("20:59"), TZ)).toBe(false));
  it("21:00 is held", () => expect(quietHold(at("21:00"), TZ)).toBe(true));
  it("05:59 is held", () => expect(quietHold(at("05:59"), TZ)).toBe(true));
  it("06:00 is not held", () => expect(quietHold(at("06:00"), TZ)).toBe(false));
});

describe("pickLongShiftNudges: ten hours in, asked once, never at night", () => {
  // 2001-01-01 13:37 Pacific clock-in (Brian's case, moved to a day nobody worked).
  const clockIn = "2001-01-01T21:37:00Z";
  const rows = [
    { id: "a", clock_in: clockIn, long_shift_nudged_at: null },
    { id: "b", clock_in: clockIn, long_shift_nudged_at: "2001-01-02T14:00:00Z" },
    { id: "c", clock_in: "2001-01-02T13:30:00Z", long_shift_nudged_at: null }, // 5:30 AM start
  ];

  it("holds everything at 11:37 PM, when the ten hours land", () => {
    expect(pickLongShiftNudges(rows, Date.parse("2001-01-02T07:37:00Z"), TZ)).toEqual([]);
  });

  it("the 6 AM run asks about the forgotten one, once", () => {
    const sixAm = Date.parse("2001-01-02T14:00:00Z");
    expect(pickLongShiftNudges(rows, sixAm, TZ).map((r) => r.id)).toEqual(["a"]);
  });

  it("a shift under ten hours is left alone", () => {
    const noon = Date.parse("2001-01-02T20:00:00Z");
    expect(pickLongShiftNudges([rows[2]], noon, TZ)).toEqual([]);
  });
});

describe("startedEarlierDay", () => {
  it("reads the org's day, not UTC's", () => {
    // 7 PM Pacific Jan 1 is Jan 2 in UTC; at 11 PM Pacific it is still the same day.
    expect(startedEarlierDay(Date.parse("2001-01-02T03:00:00Z"), Date.parse("2001-01-02T07:00:00Z"), TZ)).toBe(false);
    expect(startedEarlierDay(Date.parse("2001-01-02T03:00:00Z"), Date.parse("2001-01-02T09:00:00Z"), TZ)).toBe(true);
  });
});
