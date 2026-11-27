import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE PUNCH'S LOCATION TRACE, ON THE FENCE'S SIDE (cn-v1201, the fixer's list after skeptic #98).
 *
 * firstGeoTrace keeps the trace to ONE row per trip and moment: in memory for this page's life, and
 * in localStorage across the reloads iOS makes on most reopens. The tally behind the row counts the
 * gate's refusals (noRead) and starts fresh on a new trip; a phone whose location is off still
 * leaves its no-position row once the window has closed; and the punch miss it reports is this
 * clock-in's. The trip keys here are plainly fake.
 */
vi.mock("@/app/(app)/timeclock/actions", () => ({ adoptGeofenceAnchor: vi.fn(), geoClockOut: vi.fn(), notifyGeofenceExit: vi.fn() }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));

const g = readFileSync(path.resolve(__dirname, "geofence-monitor.tsx"), "utf8");

/** A fresh module, so the in-memory marks start empty (one page life per load). */
async function freshMonitor() {
  vi.resetModules();
  return (await import("@/components/geofence-monitor")).firstGeoTrace;
}
function memoryStorage(seed: Record<string, string> = {}) {
  const kept = new Map(Object.entries(seed));
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), kept };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("firstGeoTrace: one row per trip and moment", () => {
  it("the first ask is true; a second ask in the same page life is false, even when storage forgets", async () => {
    // Storage that never keeps anything: only the page's memory can say no.
    vi.stubGlobal("localStorage", { getItem: () => "[]", setItem: () => {} });
    const first = await freshMonitor();
    expect(first("trip-a", "no-position")).toBe(true);
    expect(first("trip-a", "no-position")).toBe(false);
  });
  it("a mark already in localStorage (a reload after the row went) answers false", async () => {
    const store = memoryStorage();
    vi.stubGlobal("localStorage", store);
    expect((await freshMonitor())("trip-a", "no-position")).toBe(true);
    // The page reloads: memory is new, the phone kept the mark.
    expect((await freshMonitor())("trip-a", "no-position")).toBe(false);
    vi.stubGlobal("localStorage", memoryStorage({ "cn-geofence-trace-sent": JSON.stringify(["trip-b#stamped-late"]) }));
    expect((await freshMonitor())("trip-b", "stamped-late")).toBe(false);
  });
  it("a different trip or a different outcome is its own row", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const first = await freshMonitor();
    expect(first("trip-a", "no-position")).toBe(true);
    expect(first("trip-a", "stamped-late")).toBe(true);
    expect(first("trip-b", "no-position")).toBe(true);
    expect(first("trip-b", "stamped-late")).toBe(true);
    expect(first("trip-a", "no-position")).toBe(false);
  });
  it("a broken localStorage still gives one row per page life", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    });
    const first = await freshMonitor();
    expect(first("trip-a", "no-position")).toBe(true);
    expect(first("trip-a", "no-position")).toBe(false);
  });
});

describe("the tally, the gate and the tap behind the row", () => {
  const check = g.slice(g.indexOf("const check = async () => {"), g.indexOf("checkRef.current = () => void check();"));
  it("a check the gate refused with no anchor is counted as noRead, and nowhere else", () => {
    expect(check).toMatch(
      /if \(!may\) \{\s*if \(lastWakeCheckRef\.current === now\) lastWakeCheckRef\.current = 0;\s*if \(typeof anchorLat !== "number" \|\| typeof anchorLng !== "number"\) \{\s*tallyCheck\(tallyRef\.current\.tally, "noRead"\);\s*gateRefused\(\);\s*\}\s*return;\s*\}/,
    );
    expect(g.split('"noRead"').length - 1).toBe(1);
  });
  it("the tally starts fresh on a new trip", () => {
    expect(g).toContain("const tallyRef = useRef<{ key: string; tally: PunchTally }>({ key: tripKey, tally: newPunchTally() });");
    expect(g).toContain("if (tallyRef.current.key !== tripKey) tallyRef.current = { key: tripKey, tally: newPunchTally() };");
  });
  it("a phone whose location is off still leaves its no-position row once the window has closed, without the fence's line", () => {
    const gate = g.slice(g.indexOf("const gateRefused = () => {"), g.indexOf("const leaveTrace = "));
    expect(gate).toContain('firePunchLocation("off");');
    expect(gate).toContain('if (fromMs && Date.now() - fromMs > windowMs) leaveTrace("no-position");');
    expect(gate).not.toContain("setAnchorLost");
    expect(gate).not.toContain("windowClosed(");
    // The tick's closed branch: through the gate, the window's line when it may read, the row when not.
    expect(g).toMatch(/void mayReadLocation\(\)\.then\(\(may\) => \{\s*if \(cancelled \|\| doneRef\.current\) return;\s*if \(may\) windowClosed\(\);\s*else gateRefused\(\);/);
  });
  it("the row's tap is this clock-in's: the miss is asked for from the window's opening", () => {
    const leave = g.slice(g.indexOf("const leaveTrace = "), g.indexOf("let serverClosed = false;"));
    expect(leave).toContain("const { fromMs } = adoptWindow();");
    expect(leave).toContain("const tap = lastPunchMiss(fromMs);");
  });
});
