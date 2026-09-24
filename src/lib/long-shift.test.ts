import { describe, it, expect } from "vitest";
import {
  LONG_SHIFT_HOURS,
  LONG_SHIFT_PHRASE,
  MAX_SHIFT_HOURS,
  OFFICE_BELL_HOURS,
  clockDoorWords,
  isForgottenShift,
  isLongOpenShift,
  stopWindow,
  stopProblem,
  quietHold,
  pickLongShiftSteps,
  startedEarlierDay,
} from "./long-shift";

const H = 3_600_000;
const TZ = "America/Los_Angeles";
// 2001-01-01 08:00 Pacific (PST, UTC-8). No real shift is on this day.
const START = Date.parse("2001-01-01T16:00:00Z");

describe("isLongOpenShift: one threshold, twelve hours", () => {
  it("is the constants the rest of the app reads", () => {
    // Erik, 2026-09-24: "I think 12 hours is a good question point mark". "Put a line on the Bell
    // at 10 hours and buzz at 12".
    expect(LONG_SHIFT_HOURS).toBe(12);
    expect(OFFICE_BELL_HOURS).toBe(10);
    expect(MAX_SHIFT_HOURS).toBe(18);
    expect(LONG_SHIFT_PHRASE).toBe("more than 12 hours");
  });

  it("11.9 hours is an ordinary long day", () => {
    expect(isLongOpenShift(START, START + 11.9 * H)).toBe(false);
  });

  it("10 hours is no longer a clock to ask about", () => {
    expect(isLongOpenShift(START, START + 10 * H)).toBe(false);
  });

  it("12.0 hours is a clock to ask about", () => {
    expect(isLongOpenShift(START, START + 12 * H)).toBe(true);
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

describe("pickLongShiftSteps: a bell line at ten hours, a question and a buzz at twelve", () => {
  // Morning clock-ins (Pacific), so every mark below lands in the daytime unless a case says not.
  const at = (h: number) => START + h * H; // START = 8:00 AM Pacific
  const fresh = (id: string) => ({ id, clock_in: new Date(START).toISOString(), long_shift_warned_at: null, long_shift_nudged_at: null });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("9.9 hours: nothing yet", () => {
    expect(pickLongShiftSteps([fresh("a")], at(9.9), TZ)).toEqual({ bell: [], nudge: [] });
  });

  it("10 hours: the office's bell line, and no push", () => {
    const r = pickLongShiftSteps([fresh("a")], at(10), TZ);
    expect(ids(r.bell)).toEqual(["a"]);
    expect(r.nudge).toEqual([]);
  });

  it("11.9 hours: the bell line is sent once, and nobody is asked yet", () => {
    const warned = { ...fresh("a"), long_shift_warned_at: new Date(at(10)).toISOString() };
    expect(pickLongShiftSteps([warned], at(11.9), TZ)).toEqual({ bell: [], nudge: [] });
    // A bell the job missed (it was down at 10) still goes out, alone.
    const r = pickLongShiftSteps([fresh("b")], at(11.9), TZ);
    expect(ids(r.bell)).toEqual(["b"]);
    expect(r.nudge).toEqual([]);
  });

  it("12 hours: the question and the buzz, once", () => {
    const warned = { ...fresh("a"), long_shift_warned_at: new Date(at(10)).toISOString() };
    const r = pickLongShiftSteps([warned], at(12), TZ);
    expect(r.bell).toEqual([]);
    expect(ids(r.nudge)).toEqual(["a"]);
    const asked = { ...warned, long_shift_nudged_at: new Date(at(12)).toISOString() };
    expect(pickLongShiftSteps([asked], at(13), TZ)).toEqual({ bell: [], nudge: [] });
  });

  it("12 hours with no bell yet: both steps on the one run, neither in place of the other", () => {
    const r = pickLongShiftSteps([fresh("a")], at(12), TZ);
    expect(ids(r.bell)).toEqual(["a"]);
    expect(ids(r.nudge)).toEqual(["a"]);
  });

  describe("the quiet hours hold pushes only", () => {
    // Brian's case, moved to a day nobody worked: clocked in 2001-01-01 at 1:37 PM Pacific.
    const brian = { id: "brian", clock_in: "2001-01-01T21:37:00Z", long_shift_warned_at: null, long_shift_nudged_at: null };

    it("11:37 PM, ten hours in: the bell line goes out in the night (it is silent)", () => {
      const r = pickLongShiftSteps([brian], Date.parse("2001-01-02T07:37:00Z"), TZ);
      expect(ids(r.bell)).toEqual(["brian"]);
      expect(r.nudge).toEqual([]);
    });

    it("1:37 AM, twelve hours in: the question and the buzz wait", () => {
      const warned = { ...brian, long_shift_warned_at: "2001-01-02T07:37:00Z" };
      expect(pickLongShiftSteps([warned], Date.parse("2001-01-02T09:37:00Z"), TZ)).toEqual({ bell: [], nudge: [] });
    });

    it("the 6 AM run asks, 16.4 hours in and under the 18-hour ceiling", () => {
      const warned = { ...brian, long_shift_warned_at: "2001-01-02T07:37:00Z" };
      const sixAm = Date.parse("2001-01-02T14:00:00Z");
      expect(ids(pickLongShiftSteps([warned], sixAm, TZ).nudge)).toEqual(["brian"]);
      expect((sixAm - Date.parse(brian.clock_in)) / H).toBeLessThan(MAX_SHIFT_HOURS);
    });
  });

  it("a garbage clock-in is never picked", () => {
    expect(pickLongShiftSteps([{ id: "x", clock_in: "not a time" }], at(20), TZ)).toEqual({ bell: [], nudge: [] });
  });
});

describe("clockDoorWords: the office's door names whose clock it is", () => {
  it("names the first name, in Title Case words", () => {
    expect(clockDoorWords("Brian Cole")).toEqual({ clockOut: "Clock Out Brian", stop: "Stop Brian's Clock" });
  });

  it("has words for a row with no name", () => {
    expect(clockDoorWords(null)).toEqual({ clockOut: "Clock Them Out", stop: "Stop Their Clock" });
    expect(clockDoorWords("   ")).toEqual({ clockOut: "Clock Them Out", stop: "Stop Their Clock" });
    expect(clockDoorWords("—")).toEqual({ clockOut: "Clock Them Out", stop: "Stop Their Clock" });
  });

  it("never names the viewer to himself", () => {
    expect(clockDoorWords("Erik Taylor", { self: true })).toEqual({ clockOut: "Clock Out", stop: "Stop Your Clock" });
  });
});

describe("isForgottenShift: which sheet the office gets", () => {
  it("an ordinary shift under twelve hours is a clock-out", () => {
    expect(isForgottenShift(START, START + 11.9 * H, TZ)).toBe(false);
  });
  it("twelve hours is forgotten", () => {
    expect(isForgottenShift(START, START + 12 * H, TZ)).toBe(true);
  });
  it("a clock begun on an earlier day is forgotten, however short", () => {
    // 11 PM Jan 1 Pacific to 1 AM Jan 2 Pacific: two hours, but yesterday's clock.
    expect(isForgottenShift(Date.parse("2001-01-02T07:00:00Z"), Date.parse("2001-01-02T09:00:00Z"), TZ)).toBe(true);
  });
});

describe("startedEarlierDay", () => {
  it("reads the org's day, not UTC's", () => {
    // 7 PM Pacific Jan 1 is Jan 2 in UTC; at 11 PM Pacific it is still the same day.
    expect(startedEarlierDay(Date.parse("2001-01-02T03:00:00Z"), Date.parse("2001-01-02T07:00:00Z"), TZ)).toBe(false);
    expect(startedEarlierDay(Date.parse("2001-01-02T03:00:00Z"), Date.parse("2001-01-02T09:00:00Z"), TZ)).toBe(true);
  });
});
