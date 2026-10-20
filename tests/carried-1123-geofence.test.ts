import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): two findings in the site fence's sheet.
 * The monitor is a client component whose effects need a phone; its decisions are pure functions
 * exported beside it, tested here, and the wiring that calls them is pinned.
 */
vi.mock("@/app/(app)/timeclock/actions", () => ({ adoptGeofenceAnchor: vi.fn(), geoClockOut: vi.fn(), notifyGeofenceExit: vi.fn() }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/" }));
const { exitHandoff, shouldPushExit } = await import("@/components/geofence-monitor");

const ROOT = path.resolve(__dirname, "..");
const g = readFileSync(path.join(ROOT, "src/components/geofence-monitor.tsx"), "utf8");

/** A live exit with nothing in the way: the sheet is down. */
const base = { done: false, ours: true, snoozed: false, handled: false, cancelled: false, phase: "idle", armed: false } as const;

describe("The pending exit is cleared on read, then dropped when the sheet is busy or the effect was cancelled", () => {
  it("a sheet that is down opens with the observed time", () => {
    expect(exitHandoff(base)).toBe("open");
  });

  it("a sheet already up, asking and promising nothing, takes the time into its picker instead of losing it", () => {
    // The wake check's GPS prompt won the race with the native read: the old code returned here and the time was gone.
    expect(exitHandoff({ ...base, phase: "prompt" })).toBe("fill");
  });

  it("a busy sheet keeps the exit for the next free one — never dropped", () => {
    // A live prompt promising its own observed close, a picker in use, a close in flight, the confirmation.
    expect(exitHandoff({ ...base, phase: "prompt", armed: true })).toBe("keep");
    for (const phase of ["picking", "saving", "confirmed"] as const) expect(exitHandoff({ ...base, phase })).toBe("keep");
  });

  it("an effect torn down between the read and its .then keeps the exit for the effect that replaced it", () => {
    for (const phase of ["idle", "prompt", "picking", "saving"] as const) expect(exitHandoff({ ...base, cancelled: true, phase })).toBe("keep");
  });

  it("only a moot exit is let go: the shift is over, another shift's, snoozed, or already on the sheet", () => {
    expect(exitHandoff({ ...base, done: true })).toBe("drop");
    expect(exitHandoff({ ...base, ours: false })).toBe("drop");
    expect(exitHandoff({ ...base, snoozed: true })).toBe("drop");
    expect(exitHandoff({ ...base, handled: true })).toBe("drop");
    // Moot beats busy and beats cancelled: nothing is held for a shift that is over or a person who said Still Working.
    expect(exitHandoff({ ...base, snoozed: true, cancelled: true, phase: "prompt" })).toBe("drop");
    expect(exitHandoff({ ...base, ours: false, cancelled: true })).toBe("drop");
  });

  it("an exit he came back from is moot: seen at the site AFTER it, it is not replayed when the sheet that kept it closes", () => {
    const exited = Date.parse("2026-10-20T15:00:00Z");
    const back = exited + 4 * 60_000;
    // The sheet was up and busy (kept); he came back inside, the live prompt closed, and the sheet is free again.
    expect(exitHandoff({ ...base, phase: "prompt", armed: true, exitedAtMs: exited, insideAtMs: exited - 60_000 })).toBe("keep"); // not back yet: still kept
    expect(exitHandoff({ ...base, exitedAtMs: exited, insideAtMs: back })).toBe("drop");
    // Moot beats busy and beats cancelled, like the others.
    expect(exitHandoff({ ...base, phase: "picking", exitedAtMs: exited, insideAtMs: back })).toBe("drop");
    expect(exitHandoff({ ...base, cancelled: true, exitedAtMs: exited, insideAtMs: back })).toBe("drop");
    // An inside reading from BEFORE the exit, never confirmed at the site, or an exit time nobody could read: not moot.
    expect(exitHandoff({ ...base, exitedAtMs: exited, insideAtMs: exited - 1 })).toBe("open");
    expect(exitHandoff({ ...base, exitedAtMs: exited, insideAtMs: 0 })).toBe("open");
    expect(exitHandoff({ ...base, exitedAtMs: Number.NaN, insideAtMs: back })).toBe("open");
  });

  it("the page tells exitHandoff when the exit was observed and the last time a fix confirmed him on site (only after a confirmed look)", () => {
    expect(g).toContain("exitedAtMs: Date.parse(e.exitedAt),\n        insideAtMs: seenInsideRef.current ? lastInsideMsRef.current : 0,");
  });

  it("the page holds the kept exit in a ref, takes it up when the effect starts and when the sheet frees, and lets it go on a new trip", () => {
    expect(g).toContain("const keptExitRef = useRef<PendingExit | null>(null);");
    expect(g).toContain("const takeKeptRef = useRef<() => void>(() => {});");
    // keep: stored, and a torn-down effect hands it to the live one
    expect(g).toContain("keptExitRef.current = e;\n        if (cancelled) takeKeptRef.current(); // the effect that replaced this one takes it up");
    // the live effect takes up what the last one could not place, and stops being the taker when it goes
    expect(g).toContain("takeKeptRef.current = () => { const k = keptExitRef.current; if (k) takeExit(k); };\n    takeKeptRef.current();");
    expect(g).toContain("      cancelled = true;\n      takeKeptRef.current = () => {};");
    // a sheet that closes frees the place
    expect(g).toContain('if (phase === "idle") takeKeptRef.current();\n  }, [phase]);');
    // another trip's exit means nothing at this site
    expect(g).toContain("keptExitRef.current = null; // an exit from the last trip's site means nothing at this one");
    // the old early return that deleted the exit is gone
    expect(g).not.toContain('if (phaseRef.current !== "idle" || Date.now() < snoozedUntil(entryId)) return;');
    expect(g).not.toContain("if (cancelled || doneRef.current || e.entryId !== entryId) return;");
  });

  it("the exit is judged against the trip as it is NOW, not the trip the closure was born in", () => {
    expect(g).toContain("ours: e.entryId === entryId && tripKey === tripKeyRef.current,");
    expect(g).toContain("snoozed: Date.now() < snoozedUntil(entryId),");
    expect(g).toContain("handled: handledExitRef.current === key,");
  });

  it("a listener that arrives after its effect was torn down is removed, not left listening", () => {
    expect(g).toContain("void onFenceExit(takeExit).then((s) => { if (cancelled) s(); else stop = s; });");
    expect(g).not.toContain("void onFenceExit(takeExit).then((s) => { stop = s; });");
  });

  it("the picker opens on the time that will be saved, so the filled-in exit is what he sees", () => {
    expect(g).toContain("initialIso={pickedIso ?? (longShift ? clockInIso : undefined)}");
  });
});

describe("One site exit rings the phone twice: the native local notification, then the server push fired when the sheet opens", () => {
  it("the first sheet of an entry asks the server to ring; the same entry does not ask again", () => {
    expect(shouldPushExit({ sentFor: null, entryId: "e1", alreadyRang: false })).toBe(true);
    expect(shouldPushExit({ sentFor: "e1", entryId: "e1", alreadyRang: false })).toBe(false);
    expect(shouldPushExit({ sentFor: "e1", entryId: "e2", alreadyRang: false })).toBe(true); // a new shift
  });

  it("an exit the shell already rang for never asks the server to ring it again", () => {
    expect(shouldPushExit({ sentFor: null, entryId: "e1", alreadyRang: true })).toBe(false);
    expect(shouldPushExit({ sentFor: "e0", entryId: "e1", alreadyRang: true })).toBe(false);
  });

  it("openPrompt takes what already rang, marks the entry told either way, and sends only when told to", () => {
    expect(g).toContain('function openPrompt(source: "live" | "wake", alreadyRang = false) {');
    expect(g).toContain("const push = shouldPushExit({ sentFor: exitPushSentRef.current, entryId: pushCtx.entryId, alreadyRang });\n    exitPushSentRef.current = pushCtx.entryId;\n    if (push) notifyGeofenceExit(pushCtx.jobLabel).catch(() => {});");
    // the one and only server call sits behind that decision
    expect(g.split("notifyGeofenceExit(").length - 1).toBe(1);
  });

  it("an exit iOS saw opens the sheet saying the shell's alert (armed with notify) already rang; the GPS doors do not claim it", () => {
    expect(g).toContain('if (how === "open") openPrompt("wake", notify);');
    expect(g.split('openPrompt("wake", notify)').length - 1).toBe(1);
    // the wake check's own GPS fix and the live watch are not the shell's alert: they claim nothing
    expect(g.split('openPrompt("wake");').length - 1).toBe(1);
    expect(g.split('openPrompt("live");').length - 1).toBe(1);
    // `notify` is what the shell was armed with in this very effect run
    expect(g).toContain("void armFence({ entryId, lat: anchorLat, lng: anchorLng, radiusM, label: jobLabel, notify }).then(dark);");
  });
});
