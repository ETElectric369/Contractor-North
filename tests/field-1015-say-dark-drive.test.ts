import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE ONE-LINE SAY PATH, DRIVEN (the confirm question of 2026-10-15 22:50). A fake NortAudio plugin
 * with a player, a fake /api/tts that fails as the real one did, and the page hidden: the question
 * is asked for twice; a second answer plays in the app; two failures in the dark end the turn with no
 * browser voice; the same two failures in the light fall to the browser voice as before.
 */
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
const traced: string[] = [];
vi.mock("@/lib/nort/trace", () => ({ trace: (stage: string, detail?: string) => void traced.push(detail ? `${stage} ${detail}` : stage) }));

function fakePlugin(opts: { refuses?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(d: Record<string, unknown>) => void>>();
  return {
    calls,
    emit(ev: string, d: Record<string, unknown>) {
      listeners.get(ev)?.forEach((l) => l(d));
    },
    async start() { calls.push("start"); return { on: true }; },
    async listen() { calls.push("listen"); return { listening: true }; },
    async cancel() { calls.push("cancel"); },
    async mute() { calls.push("mute"); },
    async wake() { calls.push("wake"); },
    async stop() { calls.push("stop"); return { on: false }; },
    async state() { return {}; },
    async play(o: { id: number }) {
      calls.push(`play:${o.id}`);
      if (opts.refuses) throw new Error("the player would not start");
      return { playing: true, id: o.id, seconds: 1 };
    },
    async stopPlayback() { calls.push("stopPlayback"); },
    async addListener(ev: string, cb: (d: Record<string, unknown>) => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return { remove: () => void listeners.get(ev)!.delete(cb) };
    },
  };
}

const audioOk = () => new Response(new Uint8Array(2000), { status: 200, headers: { "content-type": "audio/mpeg" } });
const failed = () => new Response("TTS failed", { status: 502 });

let speak: ReturnType<typeof vi.fn>;
async function load(answers: (() => Response)[], hidden: boolean, opts: { refuses?: boolean } = {}) {
  traced.length = 0;
  vi.resetModules();
  const plugin = fakePlugin(opts);
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.Capacitor = { Plugins: { NortAudio: plugin } };
  speak = vi.fn((u: { onend?: () => void }) => u.onend?.());
  win.speechSynthesis = { cancel: vi.fn(), speak, getVoices: () => [] };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone) CNShell/4 (iOS)" });
  vi.stubGlobal("document", { visibilityState: hidden ? "hidden" : "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; onend?: () => void; onerror?: () => void; constructor(t: string) { this.text = t; } });
  const queue = [...answers];
  vi.stubGlobal("fetch", vi.fn(async () => (queue.shift() ?? audioOk)()));
  const v = await import("@/lib/voice-stream");
  const tts = await import("@/lib/tts");
  const na = await import("@/lib/native-audio");
  v.startListening();
  await io();
  expect(na.nativePlaybackOn()).toBe(true);
  // Timers go fake only now: the load above waits on real ones. Real I/O (a Response body, the bytes
  // encoding for the bridge) is flushed with io(); the retry's wait is advanced by hand.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { plugin, tts };
}
/** Let real I/O settle (setImmediate is never faked). */
const io = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** The retry's wait, then the second answer's I/O. */
const retry = async (ms: number) => { await io(); await vi.advanceTimersByTimeAsync(ms + 50); await io(); };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("speakSmart, the confirm question's path", () => {
  it("a clip lost once is asked for again and plays in the app", async () => {
    const { plugin, tts } = await load([failed, audioOk], true);
    let ended: boolean | null = null;
    tts.speakSmart("Move this appointment to Monday at 9?", (heard) => { ended = heard; });
    await retry(tts.CLIP_RETRY_MS);
    expect(traced).toContain("clip retry tts 502");
    expect(plugin.calls.filter((c) => c.startsWith("play:"))).toHaveLength(1);
    expect(traced.some((l) => l.startsWith("say clip "))).toBe(true);
    expect(ended).toBeNull();
    plugin.emit("played", { id: 1, outcome: "ended" });
    await io();
    expect(ended).toBe(true); // heard
    expect(traced).toContain("say done ended");
    expect(speak).not.toHaveBeenCalled();
  });

  it("two failures in the dark end the turn with no browser voice, and the trace says why", async () => {
    const { plugin, tts } = await load([failed, failed], true);
    let ended: boolean | null = null;
    tts.speakSmart("Say yes or no.", (heard) => { ended = heard; });
    await retry(tts.CLIP_RETRY_MS);
    expect(ended).toBe(false); // ended, and NOT heard: the caller must not listen for an answer
    expect(traced).toContain("say failed tts 502");
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });

  it("two failures in the light fall to the browser voice, as before", async () => {
    const { tts } = await load([failed, failed], false);
    let ended = false;
    tts.speakSmart("Say yes or no.", () => { ended = true; });
    await retry(tts.CLIP_RETRY_MS);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(ended).toBe(true);
  });

  it("a page that is not audio is never a clip", async () => {
    const page = () => new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
    const { plugin, tts } = await load([page, page], true);
    tts.speakSmart("Hello.", () => {});
    await retry(tts.CLIP_RETRY_MS);
    expect(traced).toContain("say failed tts not audio");
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
  });
});

describe("a cut, a refusal, and a player that will not start", () => {
  it("a Stop during the retry's wait: no second request, no late clip, no onEnd (a Stop re-arms by its own hand)", async () => {
    const { plugin, tts } = await load([failed, audioOk], true);
    let ended = 0;
    tts.speakSmart("Move it?", () => { ended++; });
    await io();
    expect(traced).toContain("clip retry tts 502");
    tts.stopSpeaking();
    await vi.advanceTimersByTimeAsync(tts.CLIP_RETRY_MS + 50);
    await io();
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(false);
    expect(ended).toBe(0);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes("/api/tts"))).toHaveLength(1);
  });

  it("a refusal (401) is not asked again", async () => {
    const denied = () => new Response("nope", { status: 401 });
    const { tts } = await load([denied, audioOk], true);
    let ended: boolean | null = null;
    tts.speakSmart("Move it?", (heard) => { ended = heard; });
    await retry(tts.CLIP_RETRY_MS);
    expect(ended).toBe(false);
    expect(traced).toContain("say failed tts 401");
    expect(traced).not.toContain("clip retry tts 401");
  });

  it("a clip the player refuses in the dark ends the turn unheard, with no browser voice", async () => {
    const { tts } = await load([audioOk], true, { refuses: true });
    let ended: boolean | null = null;
    tts.speakSmart("Move it?", (heard) => { ended = heard; });
    await io();
    expect(traced).toContain("say done refused");
    expect(ended).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });
});

describe("the reply queue in the dark", () => {
  it("a sentence whose clip fails twice is skipped with a trace line, the next sentence plays", async () => {
    // Both sentences are synthesized at once: two first tries fail, then the first sentence's second
    // try fails and the second sentence's succeeds.
    const { plugin, tts } = await load([failed, failed, failed, audioOk], true);
    let drained = false;
    const q = new tts.SpeakQueue(() => { drained = true; });
    q.push("First sentence.");
    q.push("Second sentence.");
    q.done();
    await retry(tts.CLIP_RETRY_MS);
    expect(traced).toContain("clip skipped dark");
    expect(plugin.calls.filter((c) => c.startsWith("play:"))).toHaveLength(1);
    expect(speak).not.toHaveBeenCalled();
    plugin.emit("played", { id: 1, outcome: "ended" });
    await io();
    expect(drained).toBe(true);
  });
});
