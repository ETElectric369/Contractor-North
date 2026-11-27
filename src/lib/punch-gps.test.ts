import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ONE READ FOR EVERY PUNCH DOOR (cn-v1201). punchGps(capMs) says why a punch has no position, never
 * rejects, starts its read synchronously (THE iOS RULE), and remembers the last punch's miss in module
 * memory for the fence's trace. The read is a stand-in; positions are plainly fake.
 */
const geo = vi.hoisted(() => ({ read: null as null | ((o?: PositionOptions) => Promise<unknown>) }));
const getPunchPosition = vi.fn((o?: PositionOptions) => geo.read!(o));
vi.mock("@/lib/geo", () => ({ getPunchPosition: (o?: PositionOptions) => getPunchPosition(o) }));

import { PHONE_ANCHOR_MAX_M } from "@/app/(app)/timeclock/adopt-window";

const ok = (accuracy: number, fixAgeMs?: number) => ({
  status: "ok",
  coords: { lat: 0.5, lng: 1.5 },
  accuracy,
  ts: 1,
  ...(fixAgeMs === undefined ? {} : { fixAgeMs }),
});

let m: typeof import("./punch-gps");
beforeEach(async () => {
  vi.resetModules();
  getPunchPosition.mockClear();
  geo.read = async () => ok(20, 1_000);
  m = await import("./punch-gps");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("punchGps: every outcome", () => {
  it("a good fix inside the cap is the punch's position, with no miss", async () => {
    await expect(m.punchGps(2500)).resolves.toEqual({ gps: { lat: 0.5, lng: 1.5, accuracy: 20 }, miss: null });
  });
  it("asks with the punch's one option set, and starts the read synchronously", () => {
    void m.punchGps(2500);
    expect(getPunchPosition).toHaveBeenCalledTimes(1);
    expect(getPunchPosition).toHaveBeenCalledWith({ enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });
  it("at the anchor limit is kept; one metre past it is 'rough'", async () => {
    geo.read = async () => ok(PHONE_ANCHOR_MAX_M);
    expect((await m.punchGps(2500)).miss).toBeNull();
    geo.read = async () => ok(PHONE_ANCHOR_MAX_M + 1);
    await expect(m.punchGps(2500)).resolves.toEqual({ gps: null, miss: "rough" });
    expect(PHONE_ANCHOR_MAX_M).toBe(150);
  });
  it("a fix older than 30 s is 'stale'; exactly 30 s and no age at all are kept", async () => {
    geo.read = async () => ok(20, 30_001);
    await expect(m.punchGps(2500)).resolves.toEqual({ gps: null, miss: "stale" });
    geo.read = async () => ok(20, 30_000);
    expect((await m.punchGps(2500)).miss).toBeNull();
    geo.read = async () => ok(20);
    expect((await m.punchGps(2500)).miss).toBeNull();
  });
  it("denied, timeout, unavailable and insecure are said by name", async () => {
    for (const status of ["denied", "timeout", "unavailable", "insecure"]) {
      geo.read = async () => ({ status });
      await expect(m.punchGps(2500)).resolves.toEqual({ gps: null, miss: status });
    }
  });
  it("the cap runs out first: 'cap', and the late answer changes nothing that was returned", async () => {
    let answer: (v: unknown) => void = () => {};
    geo.read = () => new Promise((res) => (answer = res));
    const p = m.punchGps(2500);
    await vi.advanceTimersByTimeAsync(2499);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true); // at the cap, not a moment later
    const out = await p;
    expect(out).toEqual({ gps: null, miss: "cap" });
    answer(ok(20, 0));
    await vi.advanceTimersByTimeAsync(10);
    expect(out).toEqual({ gps: null, miss: "cap" });
    expect(m.lastPunchMiss(Date.now())).toBe("cap");
  });
  it("never rejects: a read that rejects or throws is 'unavailable'", async () => {
    geo.read = async () => {
      throw new Error("boom");
    };
    await expect(m.punchGps(2500)).resolves.toEqual({ gps: null, miss: "unavailable" });
    geo.read = () => {
      throw new Error("sync boom");
    };
    await expect(m.punchGps(2500)).resolves.toEqual({ gps: null, miss: "unavailable" });
  });
  it("remembers the last punch's miss, and a punch that got a position clears it", async () => {
    expect(m.lastPunchMiss(Date.now())).toBeNull();
    geo.read = async () => ({ status: "timeout" });
    await m.punchGps(2500);
    expect(m.lastPunchMiss(Date.now())).toBe("timeout");
    geo.read = async () => ok(20, 0);
    await m.punchGps(2500);
    expect(m.lastPunchMiss(Date.now())).toBeNull();
  });
  it("the remembered miss belongs to this clock-in only: null when recorded more than 60 s before the window opened", async () => {
    vi.setSystemTime(new Date("2026-11-26T16:00:00Z"));
    geo.read = async () => ({ status: "timeout" });
    await m.punchGps(2500);
    const at = Date.now();
    expect(m.PUNCH_MISS_MATCH_MS).toBe(60_000);
    expect(m.lastPunchMiss(at)).toBe("timeout"); // the window opened as the punch was made
    expect(m.lastPunchMiss(at + 60_000)).toBe("timeout"); // the server's row a minute later still matches
    expect(m.lastPunchMiss(at + 60_001)).toBeNull(); // a later clock-in: an older punch's miss
    expect(m.lastPunchMiss(at - 3_600_000)).toBe("timeout"); // recorded after the window opened
  });
  it("fixWord is the one reading the fence's adoption uses too", () => {
    expect(m.fixWord(ok(20, 0) as never)).toBe("ok");
    expect(m.fixWord(ok(151) as never)).toBe("rough");
    expect(m.fixWord(ok(0) as never)).toBe("ok"); // zero stays within the limit, as before
    // CoreLocation marks an invalid fix with a negative accuracy: never a position for a punch.
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(m.fixWord(ok(bad) as never)).toBe("rough");
    }
    expect(m.fixWord(ok(20, 31_000) as never)).toBe("stale");
    expect(m.fixWord({ status: "denied" })).toBe("denied");
  });
  it("an invalid accuracy is never the punch's position", async () => {
    geo.read = async () => ok(-1, 0);
    await expect(m.punchGps(2500)).resolves.toEqual({ gps: null, miss: "rough" });
  });
  it("writes nothing to storage", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null, removeItem: vi.fn() });
    geo.read = async () => ({ status: "timeout" });
    await m.punchGps(2500);
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("the one punch-location window event (cn-v1201)", () => {
  it("carries detail.outcome; the reader knows only added, closed and off", () => {
    const w = new EventTarget();
    vi.stubGlobal("window", w);
    const seen: (string | null)[] = [];
    const on = (e: Event) => seen.push(m.punchLocationOutcome(e));
    window.addEventListener(m.PUNCH_LOCATION_EVENT, on);
    m.firePunchLocation("added");
    m.firePunchLocation("closed");
    m.firePunchLocation("off");
    window.dispatchEvent(new CustomEvent(m.PUNCH_LOCATION_EVENT, { detail: { outcome: "other" } }));
    window.dispatchEvent(new Event(m.PUNCH_LOCATION_EVENT));
    window.removeEventListener(m.PUNCH_LOCATION_EVENT, on);
    expect(seen).toEqual(["added", "closed", "off", null, null]);
    vi.unstubAllGlobals();
  });
  it("punchNoteAfter: added only over a note; closed removes a still-looking note; off turns it into location off", () => {
    const f = m.punchNoteAfter;
    // added: the late stamp landed
    expect(f("waiting", "added")).toBe("added");
    expect(f("denied", "added")).toBe("added");
    expect(f(null, "added")).toBeNull(); // no note up: nothing appears
    // closed: the window closed with no position
    expect(f("waiting", "closed")).toBeNull(); // the fence's own line says the rest
    expect(f("denied", "closed")).toBe("denied"); // a location-off note stays
    expect(f(null, "closed")).toBeNull();
    // off: the gate refused a read with no anchor
    expect(f("waiting", "off")).toBe("denied");
    expect(f("denied", "off")).toBe("denied");
    expect(f(null, "off")).toBeNull();
    // anything else leaves it be
    expect(f("waiting", null)).toBe("waiting");
  });
  it("never throws where there is no window", () => {
    expect(() => m.firePunchLocation("added")).not.toThrow();
  });
});
