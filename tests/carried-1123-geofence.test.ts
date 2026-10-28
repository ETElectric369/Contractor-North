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
const { exitHandoff, shouldPushExit, GeofenceIdleLine } = await import("@/components/geofence-monitor");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

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

/**
 * LOCATION NOT ASKED YET IS SAID (cn-v1137; Bug Watch: Time Clock says nothing while permission is
 * still "prompt"). The gate refuses an off-gesture read in "prompt" (the iOS rule) and the fence used
 * to go quietly dark on a console.warn. Now the idle line says so and offers Turn On Location, whose
 * tap is the gesture the rule needs; the words are a pure component, rendered here without a phone.
 */
describe("Turn On Location: the fence says it is waiting, and the tap is the gesture", () => {
  const idle = (over: Partial<Parameters<typeof GeofenceIdleLine>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(GeofenceIdleLine, {
        watchOff: false,
        waitingGrant: false,
        fenceDark: null,
        anchorLost: false,
        anchorKnown: true,
        jobLabel: "85 Larkspur",
        onTurnOn: () => {},
        ...over,
      }),
    );

  it("in 'prompt' the line names the job and the one button, Title Case", () => {
    const html = idle({ waitingGrant: true });
    expect(html).toContain("Location isn’t on yet for North, so I can’t notice when you leave 85 Larkspur.");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*Turn On Location<\/button>/);
    expect(html).not.toContain("Location is off for this app");
    // A tap that did nothing is never a tap that said nothing.
    expect(idle({ waitingGrant: true, grantNote: "The phone didn’t answer with a location in time. Try again." })).toContain("Try again.");
    expect(idle({ waitingGrant: true, grantBusy: true })).toMatch(/<button[^>]*disabled=""/);
  });

  it("a denial takes over the line; granted and nothing else wrong is no line at all", () => {
    const denied = idle({ waitingGrant: true, watchOff: true });
    expect(denied).toContain("Location is off for this app");
    expect(denied).not.toContain("Turn On Location");
    expect(idle()).toBe("");
    // The ask comes before the screen-off readiness words and before a lost anchor.
    expect(idle({ waitingGrant: true, fenceDark: "whenInUse", anchorLost: true, anchorKnown: false })).toContain("Turn On Location");
    expect(idle({ fenceDark: "denied" })).toContain("Location Services, North, Always");
    expect(idle({ anchorLost: true, anchorKnown: false })).toContain("I couldn’t get a location at 85 Larkspur");
  });

  it("arm() sets the waiting state from the one unasked rule (denied is never it), and the monitor draws the idle line", () => {
    expect(g).toContain("async function locationUnasked(): Promise<boolean> {\n  if ((await shellMayReadLocation()) !== null) return false;\n  return (await geoPermission()) === \"prompt\";\n}");
    expect(g).toContain("const unasked = await locationUnasked();\n        if (!disposed) setWaitingGrant(unasked);");
    expect(g).toContain("setWaitingGrant(false);\n      stop();\n      stop = watchPosition(onFix, onErr, opts);");
    expect(g).toContain("<GeofenceIdleLine");
    expect(g).toContain("onTurnOn={turnOnLocation}");
  });

  it("the tap reads inside the gesture (getPosition is navigator.geolocation.getCurrentPosition), then arms the watch and runs the wake check; a denial hands over to the denied banner", () => {
    const tap = g.slice(g.indexOf("const turnOnLocation = () => {"), g.indexOf("};", g.indexOf("const turnOnLocation = () => {")) + 2);
    expect(tap).toContain("void getPosition({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }).then((r) => {");
    expect(tap).toContain('if (r.status === "ok") {\n        setWaitingGrant(false);\n        lastWakeCheckRef.current = 0;\n        armRef.current();\n        checkRef.current();');
    expect(tap).toContain('if (r.status === "denied") {\n        setWaitingGrant(false);\n        setWatchOff(true);');
    // The arm the tap reaches is the live effect's own, and it is let go when the effect is.
    expect(g).toContain("armRef.current = () => void arm();\n    void arm();");
    expect(g).toContain("disposed = true;\n      armRef.current = () => {};");
    // The clock-in words on Time Clock are untouched.
    const panel = readFileSync(path.join(ROOT, "src/app/(app)/timeclock/timeclock-panel.tsx"), "utf8");
    expect(panel).toContain('if (!gps) setGpsNote("Clocked in — location wasn\'t ready, so this punch isn\'t GPS-stamped.");');
  });
});
