import { describe, it, expect } from "vitest";
import { clampCloseAtMs, tailAllocationHours, autoClockoutPromptState } from "./close-math";
import { lastSwitchMs, switchBreadcrumb } from "./switch-breadcrumb";

const H = 3_600_000;

describe("clampCloseAtMs — a close may never erase recorded work", () => {
  // THE CRITICAL CASE. Tech clocks in on Job A at 07:00, switches to Job B at 11:00
  // (4h recorded), works B until 16:00. The geofence anchor was left on site A, so the
  // live watch's unanswered-prompt fallback asks to close at 10:58 — the last time GPS
  // saw him at site A. Payroll would have paid 3.97h of an 8.5h day.
  it("floors a stale geofence auto-close at the end of the last recorded segment", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z"); // 07:00 local
    const staleAt = clockIn + 3.97 * H; // "last seen at site A"
    const now = clockIn + 9 * H;
    const out = clampCloseAtMs(staleAt, clockIn, 4, now);
    expect(out).toBe(clockIn + 4 * H);
    expect((out - clockIn) / H).toBeGreaterThanOrEqual(4);
  });

  it("leaves an honest backdated close alone", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    const at = clockIn + 8.5 * H;
    const now = clockIn + 9 * H;
    expect(clampCloseAtMs(at, clockIn, 4, now)).toBe(at);
  });

  it("keeps the pre-existing floor when nothing is recorded yet", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    // Requested BEFORE clock-in — never negative hours.
    expect(clampCloseAtMs(clockIn - 5 * H, clockIn, 0, clockIn + H)).toBe(clockIn + 60_000);
  });

  it("never writes a close in the future", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    const now = clockIn + 2 * H;
    expect(clampCloseAtMs(now + 10 * H, clockIn, 0, now)).toBe(now + 60_000);
  });

  it("survives an unknown clock-in without inventing a floor", () => {
    const at = Date.parse("2026-07-20T22:00:00Z");
    expect(clampCloseAtMs(at, 0, 0, at + H)).toBe(at);
  });

  it("floors over multiple chained switches (recorded hours accumulate)", () => {
    const clockIn = Date.parse("2026-07-20T14:00:00Z");
    const now = clockIn + 10 * H;
    // A → B at +3h, B → C at +6.5h ⇒ 6.5h recorded.
    expect(clampCloseAtMs(clockIn + 2 * H, clockIn, 6.5, now)).toBe(clockIn + 6.5 * H);
  });
});

describe("tailAllocationHours — the segment after the last switch", () => {
  // 8.5h worked, 4h recorded on Job A ⇒ 4.5h must bill to Job B. Before the backstop
  // those 4.5h billed to NO job (billing treats "has rows" as fully allocated).
  it("returns the un-recorded remainder", () => {
    expect(tailAllocationHours(8.5, 4)).toBe(4.5);
  });

  it("is 0 when the entry is already fully allocated", () => {
    expect(tailAllocationHours(8, 8)).toBe(0);
  });

  it("never goes negative when the recorded rows over-fill the shift", () => {
    // Can happen when lunch is deducted after the switches were recorded.
    expect(tailAllocationHours(7.5, 8)).toBe(0);
  });

  it("ignores rounding dust rather than writing a junk row", () => {
    expect(tailAllocationHours(8.004, 8)).toBe(0);
  });

  it("rounds to cents of an hour", () => {
    expect(tailAllocationHours(8.333333, 4)).toBe(4.33);
  });

  it("treats a shift with no recorded segments as nothing to backfill by itself", () => {
    // The caller only invokes this when rows exist; belt-and-braces on the math.
    expect(tailAllocationHours(8, 0)).toBe(8);
  });
});

describe("autoClockoutPromptState — surface the finish-timecard prompt (incl. the meal it skipped)", () => {
  // THE REGRESSION. A >5h shift that switched jobs: switchJob recorded the outgoing
  // segment and the close's tail backstop filled the rest, so every hour is allocated —
  // but the geofence close deducted NO lunch. The old under-allocation-only gate hid the
  // prompt, so the shift paid GROSS with no meal. It must now surface, lunch-only.
  it("surfaces a lunch-only prompt for a fully-allocated >5h switched shift with no meal", () => {
    const s = autoClockoutPromptState({ grossHours: 8.5, lunchMinutes: 0, allocatedHours: 8.5 });
    expect(s.show).toBe(true);
    expect(s.mealOnly).toBe(true);
  });

  it("keeps the normal (full breakdown) prompt when hours are still unallocated", () => {
    const s = autoClockoutPromptState({ grossHours: 8, lunchMinutes: 0, allocatedHours: 0 });
    expect(s.show).toBe(true);
    expect(s.mealOnly).toBe(false); // there's a remainder to log, not just the meal
  });

  it("does NOT surface once a fully-allocated shift already has its meal", () => {
    const s = autoClockoutPromptState({ grossHours: 8.5, lunchMinutes: 30, allocatedHours: 8 });
    expect(s.show).toBe(false);
    expect(s.mealOnly).toBe(false);
  });

  it("no meal is owed on a short (≤5h) shift, so a fully-allocated one stays quiet", () => {
    const s = autoClockoutPromptState({ grossHours: 4.5, lunchMinutes: 0, allocatedHours: 4.5 });
    expect(s.show).toBe(false);
  });

  it("still surfaces the remainder on a short shift that isn't fully allocated", () => {
    const s = autoClockoutPromptState({ grossHours: 4.5, lunchMinutes: 0, allocatedHours: 1 });
    expect(s.show).toBe(true);
    expect(s.mealOnly).toBe(false);
  });

  it("ignores rounding dust — a cent-level remainder on a meal'd shift stays quiet", () => {
    const s = autoClockoutPromptState({ grossHours: 8.5, lunchMinutes: 30, allocatedHours: 7.98 });
    expect(s.show).toBe(false);
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
