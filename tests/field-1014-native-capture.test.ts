import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NORT WITH THE SCREEN OFF — NATIVE CAPTURE (field feedback 10-13, item 4; plan C of 2026-10-14).
 * The spike proved the page and its spoken replies run with the screen dark and WebKit's own mic
 * does not, so NortAudioPlugin records each turn natively and hands the bytes to the page. These
 * pins hold the two halves to each other: the same end-of-turn rule in Swift and TypeScript, the
 * page's doors, the session discipline, and no network from native, ever.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const swift = read("ios/App/App/NortAudioPlugin.swift");
const page = read("src/lib/voice-stream.ts");
const door = read("src/lib/native-audio.ts");

function tsConst(name: string): number {
  const m = page.match(new RegExp(`const ${name} = ([0-9.]+);`));
  if (!m) throw new Error(`voice-stream.ts has no ${name}`);
  return Number(m[1]);
}
function swiftLet(name: string): number {
  const m = swift.match(new RegExp(`private let ${name}(?:: Float)? = ([0-9.]+)`));
  if (!m) throw new Error(`NortAudioPlugin.swift has no ${name}`);
  return Number(m[1]);
}

describe("one end-of-turn rule, two languages", () => {
  it.each([
    ["SPEAK_MIN_GATE", "speakMinGate"],
    ["QUIET_MIN_GATE", "quietMinGate"],
    ["FLOOR_CAP", "floorCap"],
    ["FLOOR_LEARN_MS", "floorLearnMs"],
    ["PAUSE_MS", "pauseMs"],
    ["TURN_CAP_MS", "turnCapMs"],
    ["NO_SPEECH_CAP_MS", "noSpeechCapMs"],
  ])("%s equals %s", (ts, sw) => {
    expect(swiftLet(sw)).toBe(tsConst(ts));
  });
  it("the gates are the same arithmetic", () => {
    for (const f of ["floor * 2.2 + 0.006", "floor * 1.5 + 0.003"]) {
      expect(page).toContain(f);
      expect(swift).toContain(f.replace("floor", "t.floor"));
    }
    // The page smooths 0.3 per ~60 Hz frame; the tap's buffers vary, so Swift smooths by time constant.
    expect(swiftLet("smoothSeconds")).toBeCloseTo(0.055, 3);
    expect(swiftLet("floorClimbPerSecond")).toBeCloseTo(0.003 * 60, 3);
  });
});

describe("the plugin (Swift)", () => {
  it("offers the page's doors and events, and nothing else", () => {
    for (const m of ["start", "listen", "endTurn", "cancel", "mute", "stop", "state"]) expect(swift).toContain(`CAPPluginMethod(name: "${m}"`);
    for (const ev of ['"turn"', '"level"', '"interrupted"', '"tick"']) expect(swift).toContain(`notifyListeners(${ev}`);
    expect(swift).not.toMatch(/URLSession|URLRequest|NSURLConnection/);
  });
  it("claims a mixable play-and-record session for the conversation and hands it back at stop", () => {
    expect(swift).toContain("try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers])");
    // teardown: what shareTheSpeaker declared at launch (NorthBridgeViewController).
    expect(swift).toContain("try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])");
    expect(read("ios/App/App/NorthBridgeViewController.swift")).toContain("setCategory(.playback, mode: .default, options: [.mixWithOthers])");
    expect(swift).toContain("try? session.setActive(false, options: [.notifyOthersOnDeactivation])");
  });
  it("never starts an engine on a changed input format (an NSException): it rebuilds", () => {
    const revive = swift.slice(swift.indexOf("private func revive("), swift.indexOf("private func rebuild("));
    expect(revive.indexOf("engine.inputNode.outputFormat(forBus: 0) != format")).toBeGreaterThan(0);
    expect(revive.indexOf("engine.inputNode.outputFormat(forBus: 0) != format")).toBeLessThan(revive.indexOf("try engine.start()"));
    expect(swift).toContain("guard format.sampleRate > 0, format.channelCount > 0 else { throw Fault.noInput }");
    for (const n of ["AVAudioSession.interruptionNotification", "AVAudioSession.mediaServicesWereResetNotification", ".AVAudioEngineConfigurationChange"]) expect(swift).toContain(n);
  });
  it("a turn is one AAC file; silence is not uploaded; the base64 is never printed", () => {
    expect(swift).toContain("AVFormatIDKey: kAudioFormatMPEG4AAC");
    expect(swift).toContain('if why != "no-speech", t.frames > 0, let bytes = try? Data(contentsOf: t.url), !bytes.isEmpty {');
    expect(swift).toContain('data["audio"] = bytes.base64EncodedString()');
    expect(swift).toContain("try? FileManager.default.removeItem(at: t.url)");
    const prints = swift.split("\n").filter((l) => l.includes("print("));
    for (const l of prints) expect(l).not.toMatch(/base64|data\["audio"\]/);
  });
  it("an interruption drops the live turn and the resume tells the page; listen while down is pending", () => {
    expect(swift).toContain("if live {\n            dropTurn()\n            hadTurn = true\n        }");
    expect(swift).toContain('notifyListeners("interrupted", data: ["resumed": true, "hadTurn": hadTurn, "listening": listening, "why": why])');
    expect(swift).toContain('self.pendingListen = true\n                call.resolve(["listening": false, "pending": true])');
    expect(swift).toContain("if turn != nil { return } // listening is listening");
  });
  it("the tap thread never reads UIKit: the foreground flag is a copy kept on main", () => {
    const consume = swift.slice(swift.indexOf("private func consume("), swift.indexOf("private static func rms("));
    expect(consume).not.toContain("UIApplication");
    expect(consume).toContain("if foreground, now.timeIntervalSince(levelAt) * 1000 > levelEveryMs {");
    expect(swift).toContain("UIApplication.didBecomeActiveNotification");
  });
});

describe("the page's door (native-audio.ts)", () => {
  it("exists only for a shell that can record; the spike's keepAlive shell falls back to the web path", () => {
    expect(door).toContain('typeof p.start === "function" && typeof p.listen === "function" && typeof p.stop === "function"');
    for (const f of ["nativeMicAvailable", "startNativeMic", "listenNative", "cancelTurnNative", "muteNative", "stopNativeMic", "turnBlob"]) expect(door).toContain(`export ${f === "nativeMicAvailable" || f === "turnBlob" ? "function" : "async function"} ${f}(`);
    expect(door).toContain('return new Blob([bytes], { type: t.mime || "audio/mp4" });');
    // The heartbeat reaches the console: the bridge log says whether a turn ran with the screen dark.
    expect(door).toContain('p.addListener("tick", (d) => {');
    // The trace reaches the ops sink on its own when the screen comes back (a reopened app detaches the cable).
    const tr = read("src/lib/nort/trace.ts");
    expect(tr).toContain('if (document.visibilityState === "visible") flushTrace("screen back");');
    expect(tr).toContain("if (!wasHidden || !isNativeShell()) return;");
    expect(tr).toContain('void reportClientError("nort-voice", `trace turn ${turnNo}`, { why, at: clock(), lines: mine.join("\\n") })');
    expect(read("src/lib/voice-stream.ts")).toContain('if (nativeOn) flushTrace("stop");');
    expect(door).toContain("console.log(`[nort-audio] tick background=${!!d?.background} listening=${!!d?.listening}");
    // The final manual turn is delivered before the listeners go, and only THIS conversation's go.
    expect(door).toMatch(/const mine = handles;[\s\S]*await p\?\.stop\(\{ ship \}\);[\s\S]*for \(const h of mine\)/);
  });
});

describe("the mic source switch (voice-stream.ts)", () => {
  it("is decided once per conversation at the fresh start, in the shell only", () => {
    expect(page).toContain("let nativeOn = false;");
    expect(page).toContain("if (isNativeShell() && nativeMicAvailable()) {\n    startNative();\n    return true;\n  }");
    // A live native conversation records the next answer without a gesture, under the greeting rule.
    expect(page).toMatch(/if \(nativeOn \|\| nativeStarting\) \{\s*greeting = null;[^}]*if \(greetingActive \|\| nativeStarting\) return true;[^}]*void muteNative\(false\);[^}]*nextTurn\(\);/);
    expect(page).toContain("if (nativeMicAvailable()) return true;");
  });
  it("WebKit never captures beside the plugin: the page's session is playback for the whole conversation", () => {
    const start = page.slice(page.indexOf("function startNative()"), page.indexOf("function beginNativeTurn()"));
    expect(start).toContain('setAudioSessionType("playback");');
    expect(start).toContain('mimeType = "audio/mp4 (native)";');
    expect(start).not.toContain("getUserMedia");
    expect(page).toContain("if (nativeOn) {\n    // The native recorder runs through the reply");
    expect(page).toContain("void muteNative(b);\n    return;");
  });
  it("turns begin, end and ship through the one shared path", () => {
    expect(page).toMatch(/function nextTurn\(\) \{\s*if \(nativeOn\) \{\s*beginNativeTurn\(\);\s*return;/);
    expect(page).toMatch(/function beginTurn\(\) \{\s*if \(nativeOn\) \{\s*beginNativeTurn\(\);\s*return;/);
    expect(page).toContain("if (active) return; // listening is listening");
    expect(page).toContain("await shipTurn(blob, ext);");
    expect(page).toContain('void shipTurn(blob, "m4a");');
    expect(page).toContain("async function shipTurn(blob: Blob, ext: string) {\n  const mine = session;");
    // No-speech turns never upload; a cap says what the web says; a manual end with nothing says nothing.
    const onTurn = page.slice(page.indexOf("function onNativeTurn("), page.indexOf("function onNativeResumed("));
    expect(onTurn).toContain('retryOrGiveUp("Didn\'t hear anything. Try speaking a bit louder.", "no-speech-cap", facts);');
    expect(onTurn).toContain('if (t.why === "manual") return;');
    expect(onTurn).toContain('if (t.why === "cap") status("Sending what I heard. The mic never caught a pause…");');
  });
  it("stop by hand ships the turn, the red Stop drops it, and the greeting plays once over either source", () => {
    expect(page).toContain("void stopNativeMic(!opts?.discard);");
    expect(page.match(/status\("Mic ready\. Go ahead\."\);/g)?.length).toBe(1); // micReady: one greeting discipline
    expect(page).toContain("function micReady() {");
    expect(page).toContain("micReady();\n    })"); // the web path lands there
    expect(page).toContain("nativeOn = true;\n      micReady();"); // and the native one
    // The hang watch is one function for both mics.
    expect(page.match(/hangWatch\(attempt, "(web|native)"\)/g)?.length).toBe(2);
  });
  it("a cut turn is re-armed at the resume unless Nort is speaking", () => {
    const resumed = page.slice(page.indexOf("function onNativeResumed("), page.indexOf("// ── End-of-speech detection"));
    expect(resumed).toContain("active = r.listening;");
    expect(resumed).toContain("if (!r.listening && !muted && !greetingActive) beginNativeTurn();");
    expect(resumed).toContain('report("capture-interrupted"');
  });
  it("the shell's manifest still asks for the mic and the background audio mode", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toContain("<key>NSMicrophoneUsageDescription</key>");
    expect(plist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>/);
  });
});
