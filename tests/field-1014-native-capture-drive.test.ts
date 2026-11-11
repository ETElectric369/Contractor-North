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

  it("three no-speech turns: the closing line is SAID once, muted first, the session ends only after it, and no turn follows", async () => {
    const v = await load(fakePlugin({ player: true }));
    v.startListening("en-US");
    await flush();
    for (let i = 0; i < 3; i++) {
      plugin.emit("turn", turn("no-speech", false));
      await flush(10);
    }
    const listens = plugin.calls.filter((c) => c === "listen").length;
    expect(listens).toBe(3); // the first turn + two silent retries: no fourth
    const ttsCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/tts"));
    expect(ttsCalls().length).toBe(1); // the line is requested exactly once
    expect(String(ttsCalls()[0][1]?.body)).toContain("closing the mic");
    const mute = plugin.calls.lastIndexOf("mute:true");
    const play = plugin.calls.findIndex((c) => c.startsWith("play:"));
    expect(mute).toBeGreaterThan(-1);
    expect(play).toBeGreaterThan(mute); // muted before the line plays
    expect(plugin.calls).not.toContain("stop:false"); // the session is still up while the line plays
    expect(v.isListening()).toBe(false);
    plugin.emit("played", { id: 1, outcome: "ended" }); // the line ended: the session ends as it always did
    await flush(10);
    expect(plugin.calls).toContain("stop:false");
    expect(plugin.calls.filter((c) => c === "listen").length).toBe(3); // no re-arm, no loop
    expect(ttsCalls().length).toBe(1);
  });

  /**
   * TALK TAPPED OVER THE CLOSING LINE (skeptic #60, 2026-11-10). startListening cleared the marker
   * and nothing else: the clip went on playing (or was still on its way) while the new turn re-armed
   * UNMUTED, so Nort recorded his own "I'm closing the mic" as the person's words. The line is cut
   * FIRST now, whoever takes over: the Talk, a Stop, or the safety timer.
   */
  const threeSilentTurns = async (pause: () => Promise<void> = () => flush(10)) => {
    for (let i = 0; i < 3; i++) {
      plugin.emit("turn", turn("no-speech", false));
      await pause();
    }
  };
  const ttsRequests = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/tts"));
  const mp3 = () => new Response(new Uint8Array(2000), { status: 200, headers: { "content-type": "audio/mpeg" } });
  /** /api/tts never answers until the test says so: the closing clip is "still on its way". */
  const hangTts = () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).includes("/api/tts") ? new Promise<Response>((res) => (answer = res)) : new Response(JSON.stringify({ text: "hello there" }), { status: 200 }),
    );
    return () => answer(mp3());
  };
  /** The page's own audio element, counted: nothing may reach it once the line was cut. */
  const countElementPlays = () => {
    const plays: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        src = "";
        currentTime = 0;
        onended: (() => void) | null = null;
        play() {
          plays.push(this.src);
          return Promise.resolve();
        }
        pause() {}
        load() {}
        removeAttribute() {}
      },
    );
    return plays;
  };
  const io = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };

  it("Talk tapped while the closing clip PLAYS: the clip is cut before the new turn listens, and the conversation is live", async () => {
    const v = await load(fakePlugin({ player: true }));
    const heard: string[] = [];
    v.setResultHandler((t) => heard.push(t));
    v.startListening("en-US");
    await flush();
    await threeSilentTurns();
    const play = plugin.calls.findIndex((c) => c.startsWith("play:"));
    expect(play).toBeGreaterThan(-1); // the closing clip is playing
    expect(plugin.calls).not.toContain("stopPlayback");
    expect(plugin.calls.filter((c) => c === "listen").length).toBe(3);
    v.startListening("en-US"); // the Talk tap, over the line
    await flush(10);
    // Never a `listen` while the clip plays: the cut is the first thing the tap does, the unmute and
    // the turn follow it.
    expect(plugin.calls.slice(play + 1)).toEqual(["stopPlayback", "mute:false", "wake:false", "listen"]);
    expect(v.isListening()).toBe(true);
    // The plugin's own late word for the cut clip ends nothing: the old close never lands.
    plugin.emit("played", { id: 1, outcome: "stopped" });
    await flush(10);
    expect(plugin.calls).not.toContain("stop:false");
    expect(ttsRequests().length).toBe(1); // and the line is not said again
    // The turn that follows is the PERSON'S.
    plugin.emit("turn", turn("pause"));
    await flush(10);
    expect(heard).toEqual(["hello there"]);
    v.stopListening({ discard: true });
    await flush();
  });

  it("Talk tapped while the closing clip is still ON ITS WAY: it never plays, and the stale timer ends nothing", async () => {
    const v = await load(fakePlugin({ player: true }));
    const answerTts = hangTts();
    const elementPlays = countElementPlays();
    v.startListening("en-US");
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await threeSilentTurns(io);
      expect(ttsRequests().length).toBe(1); // asked for, not here yet
      expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
      v.startListening("en-US"); // the Talk tap, the clip still being fetched
      await io();
      expect(plugin.calls.slice(-4)).toEqual(["stopPlayback", "mute:false", "wake:false", "listen"]);
      answerTts(); // the clip lands, late
      await io();
      expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false); // never into the open mic
      expect(elementPlays).toEqual([]);
      // Past the closing line's 15 s: its timer went with the cut, so the new conversation stays up.
      await vi.advanceTimersByTimeAsync(16000);
      await io();
      expect(plugin.calls).not.toContain("stop:false");
      expect(v.isListening()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    v.stopListening({ discard: true });
    await flush();
  });

  it("the 15-second safety timer wins: the line is cut, THEN the session ends, and the clip cannot play late", async () => {
    const v = await load(fakePlugin({ player: true }));
    const answerTts = hangTts();
    const elementPlays = countElementPlays();
    v.startListening("en-US");
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await threeSilentTurns(io);
      expect(ttsRequests().length).toBe(1);
      await vi.advanceTimersByTimeAsync(14900);
      await io();
      expect(plugin.calls).not.toContain("stop:false"); // still waiting on the line
      await vi.advanceTimersByTimeAsync(200);
      await io();
      const cut = plugin.calls.indexOf("stopPlayback");
      expect(cut).toBeGreaterThan(-1);
      expect(plugin.calls.indexOf("stop:false")).toBeGreaterThan(cut); // cut first, closed after
      expect(v.isListening()).toBe(false);
      answerTts(); // the clip lands after the session is over
      await io();
      expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
      expect(elementPlays).toEqual([]); // not on the page's element either: nothing talks into the next Talk
      expect(plugin.calls.filter((c) => c === "listen").length).toBe(3); // no re-arm
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ONLY A VOICE SESSION IS SPOKEN TO. Typing leaves voice mode while the mic keeps running; a mic
   * that then spends its no-speech budget closes QUIETLY, with the status line, exactly as it did
   * before the closing line was spoken. The panel answers the question when the mic asks it.
   */
  it("not a voice session (the person went on by typing): the mic closes at once, the status line says so, nothing is spoken", async () => {
    const v = await load(fakePlugin({ player: true }));
    const { TRY_AGAIN_LINE } = await import("@/lib/voice-failure");
    const lines: string[] = [];
    v.onStatus((s) => lines.push(s));
    let voiceMode = true;
    v.setVoiceSessionCheck(() => voiceMode);
    v.startListening("en-US");
    await flush();
    voiceMode = false; // a typed turn: voice mode is left, the mic is not
    await threeSilentTurns();
    expect(ttsRequests().length).toBe(0);
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
    expect(plugin.calls).not.toContain("mute:true"); // nothing to mute for: nothing is said
    expect(plugin.calls.at(-1)).toBe("stop:false"); // closed in the same breath, not after a line
    expect(plugin.calls.filter((c) => c === "listen").length).toBe(3);
    expect(v.isListening()).toBe(false);
    expect(lines.at(-1)).toBe(`Didn't hear anything. Try speaking a bit louder. ${TRY_AGAIN_LINE}`);
  });

  it("the panel is asked when the mic gives up, not when it started: back in voice mode, the line is said", async () => {
    const v = await load(fakePlugin({ player: true }));
    let voiceMode = false;
    v.setVoiceSessionCheck(() => voiceMode);
    v.startListening("en-US");
    await flush();
    voiceMode = true; // Talk, with the panel open: voice mode again
    await threeSilentTurns();
    expect(ttsRequests().length).toBe(1);
    expect(String(ttsRequests()[0][1]?.body)).toContain("closing the mic");
    expect(plugin.calls).not.toContain("stop:false"); // the session waits for the line
    plugin.emit("played", { id: 1, outcome: "ended" });
    await flush(10);
    expect(plugin.calls).toContain("stop:false");
    // A panel that is gone answers nothing, and the mic a Talk opened is a voice session.
    v.setVoiceSessionCheck(null);
  });

  it("a Stop is not a give-up: nothing is spoken", async () => {
    const v = await load(fakePlugin({ player: true }));
    v.startListening();
    await flush();
    plugin.emit("turn", turn("no-speech", false));
    await flush();
    v.stopListening({ discard: true });
    await flush(10);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/tts")).length).toBe(0);
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
  });
});
