import { describe, it, expect } from "vitest";
import { clampCloseAtMs, autoClockoutPromptState, withAutoConfirmedCrumb, AUTO_CONFIRMED_CRUMB } from "./close-math";
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
