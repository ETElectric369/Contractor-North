import { describe, it, expect } from "vitest";
import { resolveOfflinePunchTime, MAX_OFFLINE_PUNCH_AGE_MS } from "./punch-time";

const NOW = Date.parse("2026-07-27T18:00:00.000Z");
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();
const h = (n: number) => n * 3_600_000;

/**
 * THE HARM this guards, in both directions. Record the delivery time and a tech loses the hours he
 * worked. Record any claimed time without bounds and the timeclock becomes self-service. Neither
 * is acceptable, and no code can tell the two apart from the payload alone — so the rule is bound
 * it, label it, and hand anything older to the office.
 */
describe("an offline punch keeps the time it was made", () => {
  it("a 7am punch delivered at 11am records 7am, not 11am", () => {
    const r = resolveOfflinePunchTime(agoIso(h(4)), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.iso).toBe(agoIso(h(4)));
      expect(r.offline).toBe(true);
    }
  });

  it("a punch that went through essentially live isn't labelled offline", () => {
    // Travelling through the queue is not the same as having been offline.
    const r = resolveOfflinePunchTime(agoIso(5_000), NOW);
    expect(r.ok && r.offline).toBe(false);
  });

  it("no claimed time at all means now — the ordinary online punch", () => {
    const r = resolveOfflinePunchTime(null, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.iso).toBe(new Date(NOW).toISOString());
      expect(r.offline).toBe(false);
    }
  });

  it("a full shift's wait is still accepted", () => {
    expect(resolveOfflinePunchTime(agoIso(h(11)), NOW).ok).toBe(true);
  });
});

describe("it refuses rather than guessing", () => {
  it("a punch older than the bound is REFUSED and names the fix", () => {
    const r = resolveOfflinePunchTime(agoIso(MAX_OFFLINE_PUNCH_AGE_MS + h(1)), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/office/i);
      // Refusing must not silently clamp — a clamped time IS a wrong time in payroll.
      expect(r.reason).not.toMatch(/recorded|saved/i);
    }
  });

  it("a punch from the future is refused — bad clock or tampered payload", () => {
    const r = resolveOfflinePunchTime(new Date(NOW + h(2)).toISOString(), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/future/i);
  });

  it("a couple of minutes of device-clock skew is tolerated, not refused", () => {
    expect(resolveOfflinePunchTime(new Date(NOW + 60_000).toISOString(), NOW).ok).toBe(true);
  });

  it("junk is refused, never coerced to now", () => {
    // Coercing to now would quietly turn a broken payload into a plausible-looking shift.
    expect(resolveOfflinePunchTime("not a date", NOW).ok).toBe(false);
  });

  it("the boundary itself is accepted", () => {
    expect(resolveOfflinePunchTime(agoIso(MAX_OFFLINE_PUNCH_AGE_MS - 1000), NOW).ok).toBe(true);
  });
});
