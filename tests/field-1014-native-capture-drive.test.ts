import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NATIVE CAPTURE, DRIVEN. The voice module against a fake NortAudio plugin inside a fake shell:
 * the paths skeptic #7 (2026-10-14) showed the source pins could not guard — a reply with nothing
 * to say re-arming the mic muted, two taps while the permission prompt is up, a turn still in
 * flight after the red Stop, the stop-by-hand turn shipping, and a Talk tapped during a Stop.
 */
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));

type Listener = (d: Record<string, unknown>) => void;
function fakePlugin(opts: { startSettles?: "now" | "later"; player?: boolean; playRefuses?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  let settleStart: (() => void) | null = null;
  const plugin = {
    calls,
    settleStart: () => settleStart?.(),
    listeners: (ev: string) => listeners.get(ev)?.size ?? 0,
    emit(ev: string, d: Record<string, unknown>) {
      listeners.get(ev)?.forEach((l) => l(d));
    },
    async start() {
      calls.push("start");
      if (opts.startSettles === "later") await new Promise<void>((r) => (settleStart = r));
      return { on: true };
    },
    async listen() {
      calls.push("listen");
      return { listening: true };
    },
    async cancel() {
      calls.push("cancel");
    },
    async mute(o: { on: boolean }) {
      calls.push(`mute:${o.on}`);
    },
    async wake(o: { fast: boolean }) {
      calls.push(`wake:${o.fast}`);
    },
    async stop(o: { ship: boolean }) {
      calls.push(`stop:${o.ship}`);
      return { on: false };
    },
    async state() {
      return {};
    },
    // The player (build 7+): only when asked for, so a build-6 shell is driven too.
    ...(opts.player
      ? {
          async play(o: { audio: string; mime: string; id: number }) {
            calls.push(`play:${o.id}:${o.mime}:${o.audio.length > 0}`);
            if (opts.playRefuses) throw new Error("the player would not start");
            return { playing: true, id: o.id, seconds: 1 };
          },
          async stopPlayback() {
            calls.push("stopPlayback");
          },
        }
      : {}),
    async addListener(ev: string, cb: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return { remove: () => void listeners.get(ev)!.delete(cb) };
    },
  };
  return plugin;
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const audio = btoa("x".repeat(1300)); // past shipTurn's 1200-byte floor
const turn = (why: string, withAudio = true) => ({ why, audio: withAudio ? audio : undefined, mime: "audio/mp4", bytes: withAudio ? 1300 : 0, seconds: 3, peak: 0.1, floor: 0.004, gate: 0.015, spoke: true, turn: 1 });

let fetchMock: ReturnType<typeof vi.fn>;
let plugin: ReturnType<typeof fakePlugin>;
async function load(p = fakePlugin()) {
  plugin = p;
  vi.resetModules();
  const win = new EventTarget() as EventTarget & { Capacitor?: unknown };
  win.Capacitor = { Plugins: { NortAudio: plugin } };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone) CNShell/4 (iOS)" });
  // /api/tts answers with audio (the clip guard of 2026-10-15 takes nothing else); the rest with the transcript.
  fetchMock = vi.fn(async (url: unknown) =>
    String(url).includes("/api/tts")
      ? new Response(new Uint8Array(2000), { status: 200, headers: { "content-type": "audio/mpeg" } })
      : new Response(JSON.stringify({ text: "hello there" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return await import("@/lib/voice-stream");
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the native source, driven", () => {
  it("starts natively, records a turn, ships it, and a reply with nothing to say re-arms UNMUTED", async () => {
    const v = await load();
    const heard: string[] = [];
    v.setResultHandler((t) => heard.push(t));
    expect(v.startListening()).toBe(true);
    await flush();
    expect(plugin.calls).toEqual(["start", "wake:false", "listen"]);
    expect(v.isListening()).toBe(true);
    plugin.emit("turn", turn("pause"));
    await flush();
    expect(plugin.calls.at(-1)).toBe("wake:true"); // in flight: the page needs waking between stages
    window.dispatchEvent(new Event("cn:nort-play")); // the reply plays: back to the slow tick
    await flush();
    expect(plugin.calls.at(-1)).toBe("wake:false");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(heard).toEqual(["hello there"]);
    expect(v.isListening()).toBe(false);
    // The reply: the panel mutes before it speaks. Nothing to speak → it re-arms through startListening only.
    v.setMuted(true);
    await flush();
    expect(plugin.calls.at(-1)).toBe("mute:true");
    v.startListening();
    await flush();
    expect(plugin.calls.slice(-3)).toEqual(["mute:false", "wake:false", "listen"]); // skeptic #7 HIGH: the native mute was never cleared
    v.stopListening({ discard: true });
    await flush();
  });

  it("two taps while the permission prompt is up are one start; the shared plugin is never torn down", async () => {
    const v = await load(fakePlugin({ startSettles: "later" }));
    v.startListening();
    await flush();
    v.startListening(); // the second tap, the prompt still up
    await flush();
    plugin.settleStart();
    await flush();
    expect(plugin.calls).toEqual(["start", "wake:false", "listen"]);
    expect(plugin.calls).not.toContain("stop:false");
    expect(v.isListening()).toBe(true);
    v.stopListening({ discard: true });
    await flush();
  });

  it("the red Stop drops the turn, and a turn still in flight afterwards goes nowhere", async () => {
    const v = await load();
    const heard: string[] = [];
    v.setResultHandler((t) => heard.push(t));
    v.startListening();
    await flush();
    v.stopListening({ discard: true });
    await flush();
    expect(plugin.calls.at(-1)).toBe("stop:false");
    plugin.emit("turn", turn("pause")); // was already closing when Stop landed
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it("the mic tapped off by hand ships what it had", async () => {
    const v = await load();
    const heard: string[] = [];
    v.setResultHandler((t) => heard.push(t));
    v.startListening();
    await flush();
    // The plugin finishes the live turn INSIDE stop (before it resolves): the event lands first.
    const stop = plugin.stop;
    plugin.stop = async (o) => {
      plugin.emit("turn", turn("manual"));
      return stop(o);
    };
    v.stopListening();
    await flush();
    expect(plugin.calls.at(-1)).toBe("stop:true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(heard).toEqual(["hello there"]);
  });

  it("Talk tapped during a Stop keeps the new conversation's ears", async () => {
    const v = await load();
    v.startListening();
    await flush();
    v.stopListening({ discard: true });
    v.startListening(); // before the stop's bridge round trip settles
    await flush();
    expect(plugin.listeners("turn")).toBe(1);
    expect(v.isListening()).toBe(true);
    const heard: string[] = [];
    v.setResultHandler((t) => heard.push(t));
    plugin.emit("turn", turn("pause"));
    await flush();
    expect(heard).toEqual(["hello there"]);
    v.stopListening({ discard: true });
    await flush();
  });

  it("the reply's clips play in the app process: handed over, ended by `played`, cut by Stop, gone at the end", async () => {
    const v = await load(fakePlugin({ player: true }));
    const na = await import("@/lib/native-audio");
    const tts = await import("@/lib/tts");
    expect(na.nativePlaybackOn()).toBe(false); // nothing plays natively off a conversation
    v.startListening();
    await flush();
    expect(na.nativePlaybackOn()).toBe(true);
    const mp3 = () => new Blob([new Uint8Array(2000)], { type: "audio/mpeg" });
    // One clip (the greeting's door): started when the plugin has it, done when the plugin says so.
    const clip = tts.playClip(mp3(), "hello");
    await flush();
    expect(plugin.calls.at(-1)).toBe("play:1:audio/mpeg:true");
    await clip.playing;
    plugin.emit("played", { id: 1, outcome: "ended" });
    expect(await clip.done).toBe("ended");
    // Cut by hand: the plugin is told, the clip settles as stopped without waiting for the event.
    const cut = tts.playClip(mp3(), "hello again");
    await flush();
    expect(plugin.calls.at(-1)).toBe("play:2:audio/mpeg:true");
    cut.stop();
    expect(await cut.done).toBe("stopped");
    await flush();
    expect(plugin.calls.at(-1)).toBe("stopPlayback");
    // The streamed reply (the queue): each sentence's bytes go over in order; onDone after the last `played`.
    let drained = false;
    const q = new tts.SpeakQueue(() => { drained = true; });
    q.push("Hello there.");
    q.done();
    await flush(10);
    expect(plugin.calls.at(-1)).toBe("play:3:audio/mpeg:true");
    expect(drained).toBe(false);
    plugin.emit("played", { id: 3, outcome: "ended" });
    await flush();
    expect(drained).toBe(true);
    // The topbar Stop: stopSpeaking reaches the plugin too.
    tts.stopSpeaking();
    await flush();
    expect(plugin.calls.at(-1)).toBe("stopPlayback");
    // A clip up when the conversation ends settles without a `played`.
    const late = tts.playClip(mp3(), "late");
    await flush();
    v.stopListening({ discard: true });
    expect(await late.done).toBe("stopped");
    await flush();
    expect(na.nativePlaybackOn()).toBe(false);
  });

  it("a Stop in the middle of a native sentence ends the queue once; a stale `played` changes nothing", async () => {
    const v = await load(fakePlugin({ player: true }));
    const tts = await import("@/lib/tts");
    v.startListening();
    await flush();
    let drained = 0;
    const q = new tts.SpeakQueue(() => { drained++; });
    q.push("First sentence.");
    q.push("Second sentence.");
    await flush(10);
    expect(plugin.calls.filter((c) => c.startsWith("play:")).length).toBe(1); // in order: the second waits
    q.stop(); // the barge-in / Stop: the clip is cut, the second never goes over
    await flush();
    expect(plugin.calls.at(-1)).toBe("stopPlayback");
    expect(drained).toBe(1);
    plugin.emit("played", { id: 1, outcome: "stopped" }); // the plugin's own word for the cut clip, late
    plugin.emit("played", { id: 99, outcome: "ended" }); // an id nobody is waiting on
    await flush(10);
    expect(plugin.calls.filter((c) => c.startsWith("play:")).length).toBe(1);
    expect(drained).toBe(1);
    v.stopListening({ discard: true });
    await flush();
  });

  it("a clip the plugin refuses gets the one fallback voice; one that breaks after starting is reported, never spoken twice", async () => {
    const v = await load(fakePlugin({ player: true, playRefuses: true }));
    const tts = await import("@/lib/tts");
    v.startListening();
    await flush();
    // No speechSynthesis in this window: the fallback voice ends at once, and that is the clip's end.
    const refused = tts.playClip(new Blob([new Uint8Array(2000)], { type: "audio/mpeg" }), "hello");
    expect(await refused.done).toBe("ended");
    await flush();
    v.stopListening({ discard: true });
    await flush();
    const v2 = await load(fakePlugin({ player: true }));
    const tts2 = await import("@/lib/tts");
    v2.startListening();
    await flush();
    const broke = tts2.playClip(new Blob([new Uint8Array(2000)], { type: "audio/mpeg" }), "hello");
    await flush();
    plugin.emit("played", { id: 1, outcome: "failed" });
    expect(await broke.done).toBe("failed"); // greeting-player drops a cached clip on this, as on the element
    v2.stopListening({ discard: true });
    await flush();
  });

  it("a lost `played` cannot hang the reply: the clip's own length plus slack ends it", async () => {
    const v = await load(fakePlugin({ player: true }));
    const tts = await import("@/lib/tts");
    v.startListening();
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const io = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
    try {
      const clip = tts.playClip(new Blob([new Uint8Array(2000)], { type: "audio/mpeg" }), "hello");
      let settled: string | null = null;
      void clip.done.then((o) => { settled = o; });
      await io(); // the bytes encode and go over (real I/O), the bridge answers "1 s"
      expect(plugin.calls.at(-1)).toBe("play:1:audio/mpeg:true");
      await vi.advanceTimersByTimeAsync(3400); // 1 s + 2.5 s slack: not yet
      await io();
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      await io();
      expect(settled).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
    v.stopListening({ discard: true });
    await flush();
  });

  it("a shell whose plugin has no player (build 6) keeps the element for the reply", async () => {
    const v = await load();
    const na = await import("@/lib/native-audio");
    v.startListening();
    await flush();
    expect(na.nativePlaybackOn()).toBe(false);
    v.stopListening({ discard: true });
    await flush();
  });

  it("a no-speech turn uploads nothing and retries; the web path is untouched off the shell", async () => {
    const v = await load();
    v.startListening();
    await flush();
    plugin.emit("turn", turn("no-speech", false));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(plugin.calls.filter((c) => c === "listen").length).toBe(2); // the silent retry re-armed
    v.stopListening({ discard: true });
    await flush();
  });
});
