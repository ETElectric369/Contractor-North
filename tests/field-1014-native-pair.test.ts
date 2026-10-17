/**
 * THE SCREEN-OFF PAIR (field feedback 10-13, item 4): Nort keeps talking after the lock, and the
 * job's fence wakes the phone when a tech drives off. The native half is Swift (NortAudioPlugin,
 * GeofencePlugin); these pins hold the two halves to each other — the plist modes, the plugin
 * registrations, the page's doors — and test the pure parts of the page's side.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePendingExit, EXIT_EVENT } from "@/lib/native-geofence";

const read = (p: string) => readFileSync(p, "utf8");

describe("the plist and the shell", () => {
  const plist = read("ios/App/App/Info.plist");
  it("declares the two background modes and the Always-location words, honest and bounded", () => {
    expect(plist).toContain("<key>UIBackgroundModes</key>");
    expect(plist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>\s*<string>location<\/string>\s*<\/array>/);
    expect(plist).toContain("<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>");
    const words = plist.split("NSLocationAlwaysAndWhenInUseUsageDescription")[1].split("</string>")[0];
    for (const must of ["clocked in", "circle around the job site", "does not track where you go", "stops the moment you clock out"]) expect(words).toContain(must);
    // The When-In-Use words stay: Tap to Pay and the clock-in stamp still ask for them.
    expect(plist).toContain("<key>NSLocationWhenInUseUsageDescription</key>");
  });
  it("registers both plugins on the bridge, and the fence's delegate stands before the bridge does", () => {
    const vc = read("ios/App/App/NorthBridgeViewController.swift");
    expect(vc).toContain("bridge?.registerPluginInstance(NortAudioPlugin())");
    expect(vc).toContain("bridge?.registerPluginInstance(GeofencePlugin())");
    expect(read("ios/App/App/AppDelegate.swift")).toContain("GeofenceCore.shared.start()");
    const geo = read("ios/App/App/GeofencePlugin.swift");
    expect(geo).toContain('public let jsName = "Geofence"');
    for (const m of ["arm", "disarm", "readPendingExit", "status"]) expect(geo).toContain(`CAPPluginMethod(name: "${m}"`);
    // A tripwire, not a track: exits only, nothing written to the clock, no network.
    expect(geo).toContain("region.notifyOnEntry = false");
    expect(geo).toContain("region.notifyOnExit = true");
    expect(geo).not.toMatch(/URLSession|URLRequest/);
    const audio = read("ios/App/App/NortAudioPlugin.swift");
    expect(audio).toContain('public let jsName = "NortAudio"');
    // The recorder (plan C): the session is the plugin's for the conversation, mixable so the page's
    // playback is never cut; the mic is a real input tap. The silent player of the spike is gone.
    expect(audio).toContain("try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers])");
    expect(audio).toContain("input.installTap(onBus: 0, bufferSize: 1024, format: format)");
    expect(audio).not.toContain("scheduleBuffer(");
    expect(audio).not.toMatch(/URLSession|URLRequest/);
  });
});

describe("the page's doors", () => {
  it("the voice loop records natively in the shell and the spike's keep-alive is gone (the 10-14 spike: WebKit's capture does not run dark)", () => {
    const v = read("src/lib/voice-stream.ts");
    expect(v).toContain("if (isNativeShell() && nativeMicAvailable()) {\n    startNative();\n    return true;");
    expect(v).not.toContain("NATIVE_KEEP_ALIVE");
    expect(v).not.toContain("holdNativeSession");
    expect(read("src/lib/native-audio.ts")).not.toContain("keepAlive({");
  });
  it("the fence arms iOS's circle when the anchor is known, disarms when the monitor goes, and an observed exit opens the same sheet with the time filled in", () => {
    const g = read("src/components/geofence-monitor.tsx");
    expect(g).toContain("void armFence({ entryId, lat: anchorLat, lng: anchorLng, radiusM, label: jobLabel, notify }).then(dark);"); // readiness read back (audit v1120)
    expect(g).toContain("useEffect(() => () => { void disarmFence(); }, []);");
    expect(g).toContain('openPrompt("wake");\n      const ms = Date.parse(e.exitedAt);');
    expect(g).toContain('setPhase("picking");');
    // Never over a snooze, never for another entry, never while a sheet is already up.
    expect(g).toContain("if (phaseRef.current !== \"idle\" || Date.now() < snoozedUntil(entryId)) return;");
    expect(g).toContain("e.entryId !== entryId) return;");
  });
  it("parsePendingExit keeps only a real exit: an entry id and a parseable time; the label defaults", () => {
    expect(parsePendingExit({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "the Bayberry job" })).toEqual({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "the Bayberry job" });
    expect(parsePendingExit({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "" })).toEqual({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "the job site" });
    for (const bad of [null, "x", {}, { entryId: "", exitedAt: "2026-10-14T23:10:00Z" }, { entryId: "t1", exitedAt: "yesterday" }, { entryId: "t1" }]) expect(parsePendingExit(bad)).toBeNull();
    expect(EXIT_EVENT).toBe("cn:geofence-exit");
  });
});
