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
    expect(g).toContain("void armFence(fenceArmOptions({ entryId, lat: anchorLat, lng: anchorLng, radiusM, label: jobLabel, notify }, t)).then(dark);"); // readiness read back (audit v1120); the words ride along (cn-v1138)
    expect(g).toContain("useEffect(() => () => { void disarmFence(); }, []);");
    expect(g).toContain('if (how === "open") openPrompt("wake", notify);\n      const ms = Date.parse(e.exitedAt);'); // carried 1123: the shell already rang, so the server does not
    expect(g).toContain('setPhase("picking");');
    // Never over a snooze, never for another entry or trip. A sheet already up no longer discards the exit: exitHandoff
    // fills or keeps it (carried 1123, #24 — tests/carried-1123-geofence.test.ts).
    expect(g).toContain("snoozed: Date.now() < snoozedUntil(entryId),");
    expect(g).toContain("ours: e.entryId === entryId && tripKey === tripKeyRef.current,");
  });
  it("parsePendingExit keeps only a real exit: an entry id and a parseable time; the label defaults", () => {
    expect(parsePendingExit({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "the Bayberry job" })).toEqual({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "the Bayberry job" });
    expect(parsePendingExit({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "" })).toEqual({ entryId: "t1", exitedAt: "2026-10-14T23:10:00Z", label: "the job site" });
    for (const bad of [null, "x", {}, { entryId: "", exitedAt: "2026-10-14T23:10:00Z" }, { entryId: "t1", exitedAt: "yesterday" }, { entryId: "t1" }]) expect(parsePendingExit(bad)).toBeNull();
    expect(EXIT_EVENT).toBe("cn:geofence-exit");
  });
});

describe("one position, read by the phone", () => {
  it("a read that times out stops the pending requestLocation, so a late fix is never the next reader's", () => {
    const geo = read("ios/App/App/GeofencePlugin.swift");
    const timer = geo.split("readTimer = Timer.scheduledTimer")[1].split("manager.requestLocation()")[0];
    expect(timer).toContain("self.manager.stopUpdatingLocation()");
    expect(timer.indexOf("stopUpdatingLocation")).toBeLessThan(timer.indexOf('finishRead(nil, "timeout")'));
    // finishRead clears the waiting resolvers (the pending reader is answered once, then gone).
    expect(geo.split("private func finishRead")[1].split("}")[0]).toContain("readers = []");
  });
});

describe("the accuracy is asked per read, and the Settings door (2026-11-16)", () => {
  const geo = read("ios/App/App/GeofencePlugin.swift");
  it("no accuracy is set at init: the manager is set up as it was", () => {
    const init = geo.split("private override init() {")[1].split("\n    }\n")[0];
    expect(init).not.toContain("desiredAccuracy");
    expect(geo.split("desiredAccuracy =").length - 1).toBe(1); // set in one place only: where a read starts
  });
  // Code shape only (the skeptic, 2026-11-16): comments are stripped before anything is pinned.
  const code = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n\s*\n/g, "\n");
  it("currentPosition has three branches in order (nothing out: start at its sharpness; sharp behind coarse: held; else join) and never stops or asks itself", () => {
    const fn = code(geo.split("func currentPosition(highAccuracy: Bool = true, _ done: @escaping (CLLocation?, String?) -> Void) {")[1].split("private func startRead")[0]);
    expect(fn).toContain(
      "if readers.isEmpty {\n            readers.append(done)\n            return startRead(sharp: highAccuracy)\n        }\n" +
        "        if highAccuracy && !readIsSharp {\n            sharpWaiting.append(done)\n            return\n        }\n" +
        "        readers.append(done)\n    }",
    );
    expect(fn.indexOf('case .denied, .restricted: return done(nil, "denied")')).toBeLessThan(fn.indexOf("if readers.isEmpty {"));
    expect(fn).not.toContain("stopUpdatingLocation");
    expect(fn).not.toContain("requestLocation");
    expect(fn).not.toContain("desiredAccuracy"); // only startRead sets it
    expect(geo).toContain("private var sharpWaiting: [(CLLocation?, String?) -> Void] = []");
  });
  it("finishRead answers the read's callers first, then hands the held sharp callers their own Best read on the next main-queue turn", () => {
    const fin = code(geo.split("private func finishRead(_ location: CLLocation?, _ error: String?) {")[1].split("\n    }\n")[0]);
    const order = [
      "readTimer = nil",
      "readIsSharp = false",
      "let waiting = readers",
      "readers = []",
      "for r in waiting { r(location, error) }",
      "guard !sharpWaiting.isEmpty else { return }",
      "readers = sharpWaiting",
      "sharpWaiting = []",
      "readIsSharp = true",
      "DispatchQueue.main.async { [weak self] in",
      "guard let self = self, !self.readers.isEmpty else { return }",
      "self.startRead(sharp: true)",
    ];
    const at = order.map((o) => fin.indexOf(o));
    for (const [i, n] of at.entries()) expect(n, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The start is inside the async block, not in the callback that is finishing.
    expect(fin.split("startRead(").length - 1).toBe(1);
    // In the hand-over gap no timer runs, so a late fix or failure answers nobody.
    expect(code(geo)).toContain("guard !readers.isEmpty, readTimer != nil, let last = locations.last else { return }");
    expect(code(geo)).toContain("guard !readers.isEmpty, readTimer != nil else { return }\n        let code = (error as? CLError)?.code");
  });
  it("startRead sets the sharpness and the accuracy, replaces the timer, then asks; finishRead resets the sharpness first", () => {
    const start = code(geo.split("private func startRead(sharp: Bool) {")[1].split("private func finishRead")[0]);
    const order = ["readIsSharp = sharp", "manager.desiredAccuracy = sharp ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters", "readTimer?.invalidate()", "readTimer = Timer.scheduledTimer(withTimeInterval: GeofenceCore.readTimeout, repeats: false)", "manager.requestLocation()"];
    const at = order.map((o) => start.indexOf(o));
    for (const [i, n] of at.entries()) expect(n, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(geo).toContain("private var readIsSharp = false");
    const fin = code(geo.split("private func finishRead(_ location: CLLocation?, _ error: String?) {")[1].split("\n    }\n")[0]);
    expect(fin).toContain("readTimer = nil\n        readIsSharp = false\n        let waiting = readers\n        readers = []");
    // One place sets the accuracy, one place asks CoreLocation for a fix.
    expect(code(geo).split("desiredAccuracy =").length - 1).toBe(1);
    expect(code(geo).split("manager.requestLocation()").length - 1).toBe(1);
    // The one stop is the timeout's.
    expect(code(geo).split("stopUpdatingLocation()").length - 1).toBe(1);
  });
  it("the plugin: only an explicit false is coarse; absent (an older page) or true is Best", () => {
    const call = code(geo.split("@objc func currentPosition(_ call: CAPPluginCall) {")[1].split("@objc func")[0]);
    expect(call).toContain('let highAccuracy = call.getBool("highAccuracy") ?? true');
    expect(call).toContain("GeofenceCore.shared.currentPosition(highAccuracy: highAccuracy) { location, error in");
  });
  it("openSettings is in the method list and opens the app's Settings page on the main queue", () => {
    expect(geo).toContain('CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),');
    const body = geo.split("@objc func openSettings(_ call: CAPPluginCall) {")[1].split("@objc func status")[0];
    expect(body.trim().startsWith("DispatchQueue.main.async {")).toBe(true);
    expect(body).toContain("URL(string: UIApplication.openSettingsURLString)");
    expect(body).toContain("UIApplication.shared.open(url, options: [:]) { opened in");
    expect(body).toContain('if opened { call.resolve(["ok": true]) } else { call.reject("unavailable", "unavailable") }');
    // It touches nothing else: no authorization, no region, no read.
    expect(body).not.toMatch(/request(Always|WhenInUse)Authorization|startMonitoring|stopMonitoring|requestLocation|GeofenceCore/);
    expect(geo).toContain("import UIKit");
    expect(geo).not.toMatch(/URLSession|URLRequest/);
  });
  it("the read's timeout path is as it was: ten seconds, stop the request, answer every reader \"timeout\"", () => {
    expect(geo).toContain("static let readTimeout: TimeInterval = 10");
    const timer = geo.split("readTimer = Timer.scheduledTimer(withTimeInterval: GeofenceCore.readTimeout, repeats: false) { [weak self] _ in")[1].split("manager.requestLocation()")[0];
    expect(timer).toContain("self.manager.stopUpdatingLocation()");
    expect(timer).toContain('self.finishRead(nil, "timeout")');
    expect(geo).toContain("if code == .locationUnknown { return }");
    expect(geo).toContain('case .notDetermined: return done(nil, "not-determined")');
    expect(geo).toContain('case .denied, .restricted: return done(nil, "denied")');
  });
});
