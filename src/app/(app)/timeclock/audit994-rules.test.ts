import { describe, it, expect } from "vitest";
import { durationSpan, lunchFits, placeLunch, type LunchPart } from "./close-math";
import { pickerInstant, pickerParts } from "./clock-start-picker";
import { fallbackArmed } from "@/components/geofence-fallback";
import { summarizeMileage } from "@/lib/mileage-math";
import { splitPreview } from "@/lib/split-preview";

/**
 * AUDIT v994, THE TIME CLOCK WAVE: the pure rules, pinned.
 *
 *   SW3/SW6  where a lunch lands after a Switch Job (placeLunch), never on a paid part;
 *   SI6      "Brian worked 8 hours today" logged before the day is over (durationSpan);
 *   SI7      when the geofence sheet will close a shift on its own (fallbackArmed);
 *   TZ1      the stop picker reads and writes the ORG's clock (pickerParts / pickerInstant);
 *   SW5      a split shift's miles count on the day the shift began (summarizeMileage);
 *   SW9      the split footer says "same" only when the parts will be PAID what the shift was.
 */
const TZ = "America/Los_Angeles";
// 2001-01-01, a day nobody worked. 7:00 AM Pacific = 15:00Z.
const T = (h: number, m = 0) => new Date(Date.UTC(2001, 0, 1, 15 + h, m)).toISOString();

describe("placeLunch: the lunch has to fit the part it lands on (SW3, SW6)", () => {
  // Brian: 7:00-14:30 on Job A, switched, the geofence closed Job B at 14:50.
  const prior: LunchPart = { id: "a", clock_in: T(0), clock_out: T(7, 30), lunch_minutes: 0, paid_at: null };
  const here = { clock_in: T(7, 30), clock_out: T(7, 50) };

  it("a 30-minute lunch on the 20-minute last part goes on the part before, and says so", () => {
    const r = placeLunch({ hereLunch: 30, here, prior, refuse: true });
    expect(r).toEqual({
      ok: true,
      here: 0,
      prior: { id: "a", lunch: 30 },
      warning: "The 30-minute lunch is longer than this part of your shift, so it went on the part before the switch.",
    });
  });

  it("a lunch put on the part before goes there, raise-only", () => {
    const r = placeLunch({ hereLunch: 0, priorLunch: 30, priorId: "a", here, prior: { ...prior, lunch_minutes: 45 }, refuse: true });
    expect(r).toMatchObject({ ok: true, here: 0, prior: { id: "a", lunch: 45 } });
  });

  it("a PAID part before the switch never takes the lunch (SW6)", () => {
    const paid = { ...prior, paid_at: "2001-01-05T00:00:00Z" };
    // Asked for the paid part: it lands on this part (which has room) and the answer says why.
    const long = { clock_in: T(7, 30), clock_out: T(10) };
    expect(placeLunch({ hereLunch: 0, priorLunch: 30, priorId: "a", here: long, prior: paid, refuse: true })).toEqual({
      ok: true,
      here: 30,
      prior: null,
      warning: "The part before the switch is already paid, so the lunch went on this part of your shift.",
    });
    // Too long for this part and the part before is paid: refused in words.
    const r = placeLunch({ hereLunch: 30, here, prior: paid, refuse: true });
    expect(r).toEqual({
      ok: false,
      error:
        "A 30-minute lunch is longer than the 20 minutes on this part of your shift. The part before the switch is already paid, so it can't go there. Untick the lunch, or ask the office to fix it on Timecards.",
    });
  });

  it("a lunch that fits neither part is refused; unattended, it stays on this part as before", () => {
    const tiny: LunchPart = { ...prior, clock_out: T(0, 20) };
    const tinyHere = { clock_in: T(0, 20), clock_out: T(0, 40) };
    expect(placeLunch({ hereLunch: 30, here: tinyHere, prior: tiny, refuse: true }).ok).toBe(false);
    expect(placeLunch({ hereLunch: 30, here: tinyHere, prior: tiny, refuse: false })).toEqual({ ok: true, here: 30, prior: null });
  });

  it("no part before the switch: the refusal says 'this shift'", () => {
    const r = placeLunch({ hereLunch: 30, here, prior: null, refuse: true });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("on this shift.") });
  });

  it("a lunch that fits here stays here and nothing else is touched", () => {
    expect(placeLunch({ hereLunch: 30, here: { clock_in: T(0), clock_out: T(8) }, prior, refuse: true })).toEqual({
      ok: true,
      here: 30,
      prior: null,
    });
  });

  it("the lunch asked for a part that is not the touching one lands here", () => {
    const r = placeLunch({ hereLunch: 0, priorLunch: 30, priorId: "somebody-else", here: { clock_in: T(0), clock_out: T(8) }, prior, refuse: true });
    expect(r).toMatchObject({ ok: true, here: 30, prior: null, warning: expect.stringMatching(/didn't fit on the part before/) });
  });

  it("lunchFits keeps a minute of work", () => {
    expect(lunchFits(T(0), T(0, 31), 30)).toBe(true);
    expect(lunchFits(T(0), T(0, 30), 30)).toBe(false);
    expect(lunchFits(T(0), null, 0)).toBe(false);
  });
});

describe("durationSpan: 'Brian worked 8 hours today' before today is over (SI6)", () => {
  it("an earlier day is centred on midday, as always", () => {
    const r = durationSpan({ workDate: "2001-01-01", hours: 8, lunchMin: 0, tz: TZ, nowMs: Date.parse("2001-01-03T00:00:00Z") });
    expect(r).toEqual({ ok: true, clockIn: "2001-01-01T16:00:00.000Z", clockOut: "2001-01-02T00:00:00.000Z" });
  });

  it("today at 3 PM: the span ends now, and says so", () => {
    // 3:00 PM Pacific = 23:00Z.
    const r = durationSpan({ workDate: "2001-01-01", hours: 8, lunchMin: 0, tz: TZ, nowMs: Date.parse("2001-01-01T23:00:30Z") });
    expect(r).toEqual({
      ok: true,
      clockIn: "2001-01-01T15:00:00.000Z",
      clockOut: "2001-01-01T23:00:00.000Z",
      warning: "Today isn't over yet, so the hours are logged ending now: 7:00 AM to 3:00 PM. Change the times on Timecards if that's not right.",
    });
  });

  it("today, and the hours don't fit since midnight: refused in words that match the form", () => {
    const r = durationSpan({ workDate: "2001-01-01", hours: 10, lunchMin: 30, tz: TZ, nowMs: Date.parse("2001-01-01T15:00:00Z") });
    expect(r).toEqual({
      ok: false,
      error:
        "Today isn't over yet, and 10 hours plus the lunch don't fit between midnight and now. Give the hours after the work is done, or give the start and stop times.",
    });
  });

  it("a later day is refused outright", () => {
    const r = durationSpan({ workDate: "2001-01-02", hours: 8, lunchMin: 0, tz: TZ, nowMs: Date.parse("2001-01-01T20:00:00Z") });
    expect(r).toEqual({ ok: false, error: "That day hasn't happened yet. Log the hours once they're worked." });
  });
});

describe("fallbackArmed: the geofence sheet never closes a shift it didn't say it would (SI7)", () => {
  const base = { phase: "prompt" as const, longPrompt: false, picked: false, source: "live" as const, lastInsideMs: 1, streamGap: false };
  it("an unanswered live prompt is armed", () => expect(fallbackArmed(base)).toBe(true));
  it("a long-shift sheet opens on the picker; untouched, it is the same unanswered prompt", () => {
    expect(fallbackArmed({ ...base, phase: "picking", longPrompt: true })).toBe(true);
  });
  it("a picked time, an ordinary picker, a wake prompt, a gap or no sighting: not armed", () => {
    expect(fallbackArmed({ ...base, phase: "picking", longPrompt: true, picked: true })).toBe(false);
    expect(fallbackArmed({ ...base, phase: "picking" })).toBe(false);
    expect(fallbackArmed({ ...base, source: "wake" })).toBe(false);
    expect(fallbackArmed({ ...base, streamGap: true })).toBe(false);
    expect(fallbackArmed({ ...base, lastInsideMs: 0 })).toBe(false);
    expect(fallbackArmed({ ...base, phase: "saving" })).toBe(false);
  });
});

describe("the stop picker is the org's clock, whatever the phone says (TZ1)", () => {
  it("seeds the fields from the instant in the org's zone", () => {
    // 7:00 AM Pacific is 8:00 AM Mountain: a Pacific org shows 07:00 on any phone.
    expect(pickerParts("2001-01-01T15:00:00.000Z", TZ)).toEqual({ date: "2001-01-01", time: "07:00" });
    expect(pickerParts("2001-01-01T15:00:00.000Z", "America/Denver")).toEqual({ date: "2001-01-01", time: "08:00" });
  });
  it("a typed 3:30 PM is 3:30 PM Pacific, never an hour off", () => {
    expect(pickerInstant("2001-01-01", "15:30", TZ)).toBe("2001-01-01T23:30:00.000Z");
    expect(pickerInstant("2001-01-01", "", TZ)).toBeNull();
  });
});

describe("summarizeMileage: a split shift's miles count on the day it began (SW5)", () => {
  it("an 8 PM-2 AM callback split at midnight with its miles on the 12 AM piece: one baseline, one day", () => {
    const head = { id: "h", clock_in: "2001-01-02T04:00:00Z", miles: 0, split_from: null }; // 8 PM Jan 1 Pacific
    const piece = { id: "p", clock_in: "2001-01-02T08:00:00Z", miles: 80, split_from: "h" }; // 12 AM Jan 2
    const next = { id: "n", clock_in: "2001-01-02T16:00:00Z", miles: 40, split_from: null }; // 8 AM Jan 2
    // Baseline 30/day: 80 on Jan 1 (50 business) + 40 on Jan 2 (10) = 60.
    expect(summarizeMileage([head, piece, next], 30, TZ).business).toBe(60);
    // Without the family (the old behaviour) the 80 merged into Jan 2: 120 - 30 = 90.
    expect(summarizeMileage([{ clock_in: piece.clock_in, miles: 80 }, next], 30, TZ).business).toBe(90);
  });
  it("entries with no family are their own shift, as before", () => {
    expect(summarizeMileage([{ clock_in: "2001-01-01T16:00:00Z", miles: 50 }], 30, TZ)).toEqual({
      recorded: 50,
      daysDriven: 1,
      commute: 30,
      business: 20,
    });
  });
});

describe("splitPreview: 'same as the shift' only when the parts will be PAID the same (SW9)", () => {
  it("08:00:20-13:00:50 cut at 10:00 pays 1.99 + 3.01 = 5.00, and says the shift's 5.01 is not 'same'", () => {
    const entry = { clock_in: "2001-01-01T16:00:20Z", clock_out: "2001-01-01T21:00:50Z", status: "closed", lunch_minutes: 0 };
    const p = splitPreview(entry, "2001-01-01T18:00:00.000Z", null, { tz: TZ });
    expect(p.ok).toBe(true);
    expect(p.shiftHours).toBe(5.01);
    expect(p.paidHours).toBe(5);
    expect(p.roundingDrift).toBe(-0.01);
    expect(p.sameAsShift).toBe(false);
  });
  it("a whole-minute split that adds up is 'same'", () => {
    const entry = { clock_in: "2001-01-01T16:00:00Z", clock_out: "2001-01-02T00:00:00Z", status: "closed", lunch_minutes: 0 };
    const p = splitPreview(entry, "2001-01-01T20:00:00.000Z", null, { tz: TZ });
    expect(p.paidHours).toBe(8);
    expect(p.roundingDrift).toBe(0);
    expect(p.sameAsShift).toBe(true);
  });
});
