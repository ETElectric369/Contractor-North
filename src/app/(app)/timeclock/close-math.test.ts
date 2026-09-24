import { describe, it, expect } from "vitest";
import {
  clampCloseAtMs,
  autoClockoutPromptState,
  withAutoConfirmedCrumb,
  AUTO_CONFIRMED_CRUMB,
  needsStatedStop,
  stopCrumb,
  withStopCrumb,
} from "./close-math";
import { lastSwitchMs, switchBreadcrumb } from "./switch-breadcrumb";

const H = 3_600_000;

describe("clampCloseAtMs: a close lands inside the shift and never in the future", () => {
  it("leaves an honest backdated close alone", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    const at = clockIn + 8.5 * H;
    const now = clockIn + 9 * H;
    expect(clampCloseAtMs(at, clockIn, now)).toBe(at);
  });

  it("floors a close at a minute after clock-in (never negative hours)", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    expect(clampCloseAtMs(clockIn - 5 * H, clockIn, clockIn + H)).toBe(clockIn + 60_000);
  });

  it("never writes a close in the future", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    const now = clockIn + 2 * H;
    expect(clampCloseAtMs(now + 10 * H, clockIn, now)).toBe(now + 60_000);
  });

  it("survives an unknown clock-in without inventing a floor", () => {
    const now = Date.parse("2026-07-20T20:00:00Z");
    const at = now - H;
    expect(clampCloseAtMs(at, NaN, now)).toBe(at);
  });
});

describe("autoClockoutPromptState: ask until somebody answers", () => {
  it("asks on an auto-closed shift nobody has answered for", () => {
    expect(autoClockoutPromptState({ notes: null }).show).toBe(true);
    expect(autoClockoutPromptState({ notes: "pulled wire in the attic" }).show).toBe(true);
  });

  it("stays quiet once the answer is on the shift", () => {
    expect(autoClockoutPromptState({ notes: withAutoConfirmedCrumb("pulled wire") }).show).toBe(false);
  });

  it("adds the crumb once, keeping the tech's own note", () => {
    const once = withAutoConfirmedCrumb("pulled wire");
    expect(once).toBe(`pulled wire\n${AUTO_CONFIRMED_CRUMB}`);
    expect(withAutoConfirmedCrumb(once)).toBe(once);
    expect(withAutoConfirmedCrumb("")).toBe(AUTO_CONFIRMED_CRUMB);
  });
});

describe("switch breadcrumb — when the geofence anchor was deliberately cleared", () => {
  it("round-trips the timestamp it wrote", () => {
    const iso = "2026-07-20T18:05:00.000Z";
    expect(lastSwitchMs(switchBreadcrumb("J-102 · Northwoods", iso))).toBe(Date.parse(iso));
  });

  it("returns the LAST switch when a shift has several", () => {
    const notes = [
      "Pulled wire in the crawlspace",
      switchBreadcrumb("J-101 · Alpine", "2026-07-20T16:00:00.000Z"),
      switchBreadcrumb("J-102 · Northwoods", "2026-07-20T20:30:00.000Z"),
    ].join("\n");
    expect(lastSwitchMs(notes)).toBe(Date.parse("2026-07-20T20:30:00.000Z"));
  });

  it("is null for notes with no switch", () => {
    expect(lastSwitchMs("Finished the panel swap")).toBeNull();
    expect(lastSwitchMs(null)).toBeNull();
    expect(lastSwitchMs("")).toBeNull();
  });

  it("ignores a lookalike the tech typed by hand", () => {
    expect(lastSwitchMs("[switched to the other job at lunch]")).toBeNull();
  });
});

describe("needsStatedStop: a forgotten clock is not closed at now by one tap", () => {
  const now = Date.parse("2001-01-02T04:00:00Z");
  const base = { nowMs: now, picked: false, unattended: false };

  it("asks on a now-ish close of a 10.5-hour shift nobody picked a time for", () => {
    expect(needsStatedStop({ ...base, clockInMs: now - 10.5 * H, closeMs: now + 30_000 })).toBe(true);
  });
  it("a picked time passes", () => {
    expect(needsStatedStop({ ...base, picked: true, clockInMs: now - 10.5 * H, closeMs: now })).toBe(false);
  });
  it("an unattended geofence close passes (it is observed and already flagged)", () => {
    expect(needsStatedStop({ ...base, unattended: true, clockInMs: now - 10.5 * H, closeMs: now })).toBe(false);
  });
  it("a close three hours ago on an 11-hour shift is an observed time, not a default", () => {
    expect(needsStatedStop({ ...base, clockInMs: now - 11 * H, closeMs: now - 3 * H })).toBe(false);
  });
  it("a now-ish close of a 9-hour shift is an ordinary clock-out", () => {
    expect(needsStatedStop({ ...base, clockInMs: now - 9 * H, closeMs: now })).toBe(false);
  });
});

describe("stopCrumb: the card says who set the stop time", () => {
  const tz = "America/Los_Angeles";
  // Jan 1 2001, 1:37 PM Pacific; stopped by the office Jan 2, 11:56 PM.
  const since = "2001-01-01T21:37:00Z";
  const at = "2001-01-03T07:56:00Z";

  it("office wording", () => {
    expect(stopCrumb({ byName: "Erik Taylor", atIso: at, runningSinceIso: since, newStartIso: null, tz, how: "office" })).toBe(
      "[clock stopped by Erik Taylor on Jan 2, 11:56 PM; it had been running since Jan 1, 1:37 PM]",
    );
  });

  it("names a moved start", () => {
    const moved = "2001-01-01T20:00:00Z"; // 12:00 PM
    expect(stopCrumb({ byName: "Erik Taylor", atIso: at, runningSinceIso: since, newStartIso: moved, tz, how: "office" })).toBe(
      "[clock stopped by Erik Taylor on Jan 2, 11:56 PM; it had been running since Jan 1, 1:37 PM; start moved from 1:37 PM to 12:00 PM]",
    );
    // An unmoved start says nothing extra.
    expect(
      stopCrumb({ byName: "Erik Taylor", atIso: at, runningSinceIso: since, newStartIso: since, tz, how: "office" }),
    ).not.toMatch(/start moved/);
  });

  it("names both days when the start moved to another day", () => {
    const dayBefore = "2000-12-31T07:00:00Z"; // Dec 30, 11:00 PM Pacific
    expect(stopCrumb({ byName: "Erik Taylor", atIso: at, runningSinceIso: since, newStartIso: dayBefore, tz, how: "office" })).toMatch(
      /; start moved from Jan 1, 1:37 PM to Dec 30, 11:00 PM\]$/,
    );
  });

  it("self wording", () => {
    expect(
      stopCrumb({ byName: "Brian Taylor", atIso: "2001-01-02T15:02:00Z", runningSinceIso: since, newStartIso: null, tz, how: "self" }),
    ).toBe("[stop time picked by Brian Taylor on Jan 2, 7:02 AM, after the shift]");
  });

  it("never uses an em-dash", () => {
    for (const how of ["office", "self"] as const) {
      expect(
        stopCrumb({ byName: "A", atIso: at, runningSinceIso: since, newStartIso: "2001-01-01T20:00:00Z", tz, how }),
      ).not.toMatch(/—/);
    }
  });

  it("is appended once, on its own line", () => {
    const crumb = "[clock stopped by Erik Taylor on Jan 2, 11:56 PM; it had been running since Jan 1, 1:37 PM]";
    const once = withStopCrumb("pulled wire", crumb);
    expect(once).toBe(`pulled wire\n${crumb}`);
    expect(withStopCrumb(once, crumb)).toBe(once);
    expect(withStopCrumb(null, crumb)).toBe(crumb);
  });
});
