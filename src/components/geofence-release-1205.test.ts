import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * THE SITE FENCE'S WORK IS NEVER CUT BY A RELEASE RELOAD (cn-v1205, skeptic #101's finding 2: a tech's
 * pay). The phone forgets an exit the moment the page reads it, so from that read until the person
 * answers the sheet, the exit lives only in this page. The monitor registers one check with the
 * release rule (holdReloadWhile) that answers true over exactly that stretch; the rule is pure and
 * tested here, and the wiring is pinned on the source.
 */
vi.mock("@/app/(app)/timeclock/actions", () => ({ adoptGeofenceAnchor: vi.fn(), geoClockOut: vi.fn(), notifyGeofenceExit: vi.fn() }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));

import { fenceHoldsReload } from "@/components/geofence-monitor";

const g = readFileSync(path.resolve(__dirname, "geofence-monitor.tsx"), "utf8");
const idle = { taking: 0, kept: null, exitOnSheet: false, phase: "idle" as const };

describe("fenceHoldsReload: what the fence holds that only this page has", () => {
  it("nothing out, nothing kept, nothing on the sheet, the sheet down: a reload loses nothing", () => {
    expect(fenceHoldsReload(idle)).toBe(false);
  });

  it("a read of the phone's exit still out holds", () => {
    expect(fenceHoldsReload({ ...idle, taking: 1 })).toBe(true);
  });

  it("an exit kept for the next free sheet holds", () => {
    expect(fenceHoldsReload({ ...idle, kept: { entryId: "e", exitedAt: "x" } })).toBe(true);
  });

  it("an exit on the sheet holds, even before the sheet has drawn", () => {
    expect(fenceHoldsReload({ ...idle, exitOnSheet: true })).toBe(true);
  });

  it("the sheet up in any state holds: the wake prompt, the picker, a close in flight, its done line", () => {
    for (const phase of ["prompt", "picking", "saving", "confirmed"] as const) expect(fenceHoldsReload({ ...idle, phase }), phase).toBe(true);
  });
});

describe("the monitor's wiring", () => {
  it("every read of the phone's exit is counted before it starts, and uncounted after the sheet has it", () => {
    expect(g.split("takePendingExit(").length - 1).toBe(1); // one call, inside takeFromPhone
    const helper = g.slice(g.indexOf("const takeFromPhone = () => {"), g.indexOf("takeFromPhone();"));
    const count = helper.indexOf("takingExitRef.current += 1;");
    const read = helper.indexOf("void takePendingExit(");
    expect(count).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(count);
    // Uncounted only after takeExit has run, so the exit on the sheet takes over without a gap.
    expect(helper.indexOf(".finally(() => { takingExitRef.current -= 1; })")).toBeGreaterThan(helper.indexOf("if (e) takeExit(e);"));
    // The mount and the return both read through it.
    expect(g.split("takeFromPhone();").length - 1).toBe(2);
  });

  it("an exit placed on the sheet is marked, and the mark goes when the sheet goes down or a new trip starts", () => {
    expect(g).toMatch(/handledExitRef\.current = key;\n\s+exitOnSheetRef\.current = true;/);
    expect(g).toMatch(/if \(phase === "idle"\) \{\n\s+exitOnSheetRef\.current = false;[^\n]*\n\s+takeKeptRef\.current\(\);/);
    expect(g).toMatch(/keptExitRef\.current = null;[^\n]*\n\s+exitOnSheetRef\.current = false;/);
  });

  it("the check is registered once for the monitor's life, from refs, and taken back on unmount", () => {
    expect(g).toContain('import { holdReloadWhile } from "@/lib/release-on-return";');
    expect(g.split("holdReloadWhile(").length - 1).toBe(1);
    const at = g.indexOf("holdReloadWhile(");
    const call = g.slice(g.lastIndexOf("useEffect(", at), at + 400);
    expect(call).toMatch(/useEffect\(\s*\(\) =>\s*holdReloadWhile\(/);
    for (const ref of ["takingExitRef.current", "keptExitRef.current", "exitOnSheetRef.current", "phaseRef.current"]) expect(call).toContain(ref);
    expect(call).toContain("[],");
  });
});
