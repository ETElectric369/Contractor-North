import { describe, it, expect } from "vitest";
import { clockInSlotMs, clockOutDueHour, clockSince, dueToClockOut, isClockInDue, shiftsInPlay, type OpenShift } from "./timeclock-reminders";

/**
 * THE TWO REMINDERS' RULES (cn-v1192), as tables. Thursday 2001-01-04 in Pacific (PST, UTC-8):
 * the company's midnight is 08:00 UTC, its 6 PM is 02:00 UTC on the 5th.
 */
const TZ = "America/Los_Angeles";
const local = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return Date.parse("2001-01-04T08:00:00.000Z") + (h * 60 + m) * 60_000;
};
const DAY_START = local("00:00");

describe("clockOutDueHour: 6 PM, or the first whole hour at or after a later end; none after 11 PM", () => {
  it.each([
    [null, 18],
    [17 * 60, 18],
    [18 * 60, 18],
    [18 * 60 + 1, 19],
    [19 * 60 + 30, 20],
    [20 * 60, 20],
    [23 * 60, 23],
    [23 * 60 + 1, null],
    [24 * 60, null],
  ])("hours ending at minute %s are due at %s", (end, due) => {
    expect(clockOutDueHour(end)).toBe(due);
  });
});

describe("dueToClockOut", () => {
  const shift = (o: Partial<OpenShift> & { profileId: string }): OpenShift => ({
    clockInMs: local("07:00"),
    startMs: local("07:00"),
    jobId: null,
    nudged: false,
    active: true,
    ...o,
  });
  // Larkspur (J-901) ends at 7:30 PM today; Snowbell (J-902) is not on today; J-903 ends at 11:30 PM.
  const ends: Record<string, number | null> = { "j-901": 19 * 60 + 30, "j-902": null, "j-903": 23 * 60 + 30 };
  const run = (runHour: number, shifts: OpenShift[]) =>
    dueToClockOut({ shifts, jobEndMin: (id) => ends[id] ?? null, runHour, nowMs: local(`${runHour}:00`), dayStartMs: DAY_START }).map((d) => d.profileId);

  it("no job, or a job not on today: the 6 PM run, and no other", () => {
    const shifts = [shift({ profileId: "sam" }), shift({ profileId: "dana", jobId: "j-902" })];
    expect(run(18, shifts)).toEqual(["sam", "dana"]);
    for (const h of [19, 20, 21, 22, 23]) expect(run(h, shifts), String(h)).toEqual([]);
  });

  it("a job whose hours end later: its first whole hour, never 6 PM", () => {
    const shifts = [shift({ profileId: "sam", jobId: "j-901" })];
    expect(run(18, shifts)).toEqual([]);
    expect(run(19, shifts)).toEqual([]);
    expect(run(20, shifts)).toEqual(["sam"]);
  });

  it("hours that end after 11 PM: no run reminds", () => {
    const shifts = [shift({ profileId: "sam", jobId: "j-903" })];
    for (const h of [18, 19, 20, 21, 22, 23]) expect(run(h, shifts), String(h)).toEqual([]);
  });

  it("a shift under an hour old at its due run is skipped, and nothing reminds it later that evening", () => {
    const shifts = [shift({ profileId: "sam", startMs: local("17:05"), clockInMs: local("17:05") })];
    expect(run(18, shifts)).toEqual([]);
    expect(run(19, shifts)).toEqual([]);
    // An hour old exactly is old enough.
    expect(run(18, [shift({ profileId: "sam", startMs: local("17:00"), clockInMs: local("17:00") })])).toEqual(["sam"]);
  });

  it("the 12-hour question already asked, a removed person, a shift from yesterday: never", () => {
    expect(run(18, [shift({ profileId: "sam", nudged: true })])).toEqual([]);
    expect(run(18, [shift({ profileId: "sam", active: false })])).toEqual([]);
    expect(run(18, [shift({ profileId: "sam", startMs: DAY_START - 3_600_000 })])).toEqual([]);
  });

  it("shiftsInPlay, the one place that decides which open shifts are in play: active, not asked, began today and not after now", () => {
    const shifts = [
      shift({ profileId: "sam" }),
      shift({ profileId: "dana", nudged: true }),
      shift({ profileId: "rook-2", active: false }),
      shift({ profileId: "old-1", startMs: DAY_START - 1 }),
      shift({ profileId: "edge-1", startMs: DAY_START }),
      shift({ profileId: "later-1", startMs: local("19:00") }),
      shift({ profileId: "nan-1", startMs: NaN }),
    ];
    expect(shiftsInPlay(shifts, { dayStartMs: DAY_START, nowMs: local("18:00") }).map((s) => s.profileId)).toEqual(["sam", "edge-1"]);
  });

  it("two open rows of one person: one reminder, the shift's first start, the job of the row clocked into last", () => {
    const shifts = [
      shift({ profileId: "sam", startMs: local("07:00"), clockInMs: local("07:00"), jobId: "j-902" }),
      shift({ profileId: "sam", startMs: local("09:00"), clockInMs: local("09:00"), jobId: "j-901" }),
    ];
    expect(run(18, shifts)).toEqual([]);
    const at20 = dueToClockOut({ shifts, jobEndMin: (id) => ends[id] ?? null, runHour: 20, nowMs: local("20:00"), dayStartMs: DAY_START });
    expect(at20).toEqual([{ profileId: "sam", startMs: local("07:00") }]);
  });
});

describe("the clock-in run's slot and window", () => {
  it("the slot is the run's time floored to the quarter hour", () => {
    expect(clockInSlotMs(local("09:15") + 42_000)).toBe(local("09:15"));
    expect(clockInSlotMs(local("09:29"))).toBe(local("09:15"));
    expect(clockInSlotMs(local("09:30"))).toBe(local("09:30"));
  });

  it("a 9:00 start is due at 9:15, an 8:30 start at 8:45, an 8:05 start at 8:30", () => {
    expect(isClockInDue(local("09:00"), local("09:15"))).toBe(true);
    expect(isClockInDue(local("08:30"), local("08:45"))).toBe(true);
    expect(isClockInDue(local("08:05"), local("08:30"))).toBe(true);
    // The window is slot - 30 < start <= slot - 15.
    expect(isClockInDue(local("08:45"), local("09:15"))).toBe(false);
    expect(isClockInDue(local("08:46"), local("09:15"))).toBe(true);
    expect(isClockInDue(local("09:01"), local("09:15"))).toBe(false);
    expect(isClockInDue(local("08:30"), local("09:15"))).toBe(false);
  });

  it("every start of the day has exactly one run, 15 to 30 minutes after it", () => {
    const slots = Array.from({ length: 24 * 4 + 4 }, (_, i) => DAY_START + i * 15 * 60_000);
    for (let m = 0; m < 24 * 60; m += 7) {
      const start = DAY_START + m * 60_000;
      const hits = slots.filter((s) => isClockInDue(start, s));
      expect(hits.length, String(m)).toBe(1);
      expect(hits[0] - start).toBeGreaterThanOrEqual(15 * 60_000);
      expect(hits[0] - start).toBeLessThan(30 * 60_000);
    }
  });
});

describe("clockSince: the time in the company's clock, the Spanish with its article", () => {
  it.each([
    ["09:00", "en", "9:00 AM"],
    ["09:00", "es", "las 9:00 am"],
    ["13:05", "es", "la 1:05 pm"],
  ] as const)("%s in %s", (hm, lang, said) => {
    expect(clockSince(local(hm), TZ, lang)).toBe(said);
  });
});
