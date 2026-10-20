import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIVE SMALL FIXES CARRIED FROM THE v1120 AUDIT (cn-v1123), the voice and the Bell. One describe per
 * finding, named by its title. Every case drives the code (a fake NortAudio plugin in a fake shell, a
 * fake hook runtime for the Bell); none touches a database.
 */

// ── shared mocks ─────────────────────────────────────────────────────────────────────────────
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
// Every suite below except the trace's own wants the trace quiet; that one loads the real file with importActual.
vi.mock("@/lib/nort/trace", () => ({ trace: vi.fn(), flushTrace: vi.fn() }));

// ── the Bell's hook runtime (one render, effects run by hand) ───────────────────────────────
const rt = vi.hoisted(() => ({
  slots: [] as { v?: unknown; current?: unknown }[],
  i: 0,
  effects: [] as (() => unknown)[],
  polls: [] as { resolve: (r: unknown) => void; reject: (e: unknown) => void }[],
}));
vi.mock("react", async () => {
  const real = await vi.importActual<typeof import("react")>("react");
  const slot = () => {
    const k = rt.i++;
    if (!rt.slots[k]) rt.slots[k] = {};
    return rt.slots[k];
  };
  return {
    ...real,
    default: real,
    useState: (init: unknown) => {
      const s = slot();
      if (!("v" in s)) s.v = typeof init === "function" ? (init as () => unknown)() : init;
      return [s.v, (n: unknown) => { s.v = typeof n === "function" ? (n as (p: unknown) => unknown)(s.v) : n; }];
    },
    useRef: (init: unknown) => {
      const s = slot();
      if (!("current" in s)) s.current = init;
      return s;
    },
    useCallback: (f: unknown) => f,
    useEffect: (f: () => unknown) => void rt.effects.push(f),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ ToastProvider: ({ children }: { children: unknown }) => children, useToast: () => vi.fn() }));
vi.mock("@/app/(app)/notification-actions", () => ({
  getMyBell: vi.fn(() => new Promise((resolve, reject) => void rt.polls.push({ resolve, reject }))),
  markNotificationsRead: vi.fn(async () => ({ ok: true })),
}));

const io = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── a fake NortAudio plugin inside a fake shell (the neighbouring drive tests' harness) ──────
type Listener = (d: Record<string, unknown>) => void;
function fakePlugin() {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  return {
    calls,
    emit(ev: string, d: Record<string, unknown>) {
      listeners.get(ev)?.forEach((l) => l(d));
    },
    async start() { calls.push("start"); return { on: true }; },
    async listen() { calls.push("listen"); return { listening: true }; },
    async cancel() { calls.push("cancel"); },
    async mute(o: { on: boolean }) { calls.push(`mute:${o.on}`); },
    async wake(o: { fast: boolean }) { calls.push(`wake:${o.fast}`); },
    async stop(o: { ship: boolean }): Promise<{ on: boolean }> { calls.push(`stop:${o.ship}`); return { on: false }; },
    async state() { return {}; },
    async play(o: { id: number }) { calls.push(`play:${o.id}`); return { playing: true, id: o.id, seconds: 1 }; },
    async stopPlayback() { calls.push("stopPlayback"); },
    async addListener(ev: string, cb: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return { remove: () => void listeners.get(ev)!.delete(cb) };
    },
  };
}
const audioOk = () => new Response(new Uint8Array(2000), { status: 200, headers: { "content-type": "audio/mpeg" } });
const turn = (why: string) => ({ why, audio: btoa("x".repeat(1300)), mime: "audio/mp4", bytes: 1300, seconds: 3, peak: 0.1, floor: 0.004, gate: 0.015, spoke: true, turn: 1 });

async function shell(hidden: boolean) {
  vi.resetModules();
  const plugin = fakePlugin();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.Capacitor = { Plugins: { NortAudio: plugin } };
  win.speechSynthesis = { cancel: vi.fn(), speak: vi.fn((u: { onend?: () => void }) => u.onend?.()), getVoices: () => [] };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone) CNShell/4 (iOS)" });
  vi.stubGlobal("document", { visibilityState: hidden ? "hidden" : "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; onend?: () => void; onerror?: () => void; constructor(t: string) { this.text = t; } });
  const fetchMock = vi.fn(async (url: unknown) =>
    String(url).includes("/api/tts") ? audioOk() : new Response(JSON.stringify({ text: "hello there" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const v = await import("@/lib/voice-stream");
  const tts = await import("@/lib/tts");
  const na = await import("@/lib/native-audio");
  return { plugin, v, tts, na, fetchMock, win };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("A native clip that broke after starting is not heard: the dark is told so, and the screen on hears the browser voice instead", () => {
  async function ask(hidden: boolean, outcome: string) {
    const { plugin, v, tts, na, win } = await shell(hidden);
    v.startListening();
    await flush();
    expect(na.nativePlaybackOn()).toBe(true);
    const ended: boolean[] = [];
    tts.speakSmart("Move this appointment to Monday at 9?", (heard) => ended.push(heard));
    await io();
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(true); // the clip reached the player
    expect(ended).toEqual([]); // still playing
    plugin.emit("played", { id: 1, outcome });
    await io();
    v.stopListening({ discard: true });
    await flush();
    const spoke = (win.speechSynthesis as { speak: { mock: { calls: unknown[][] } } }).speak.mock.calls.map((c) => (c[0] as { text: string }).text);
    return { ended, spoke };
  }

  it("a clip that failed mid-play is NOT heard (the screen locked)", async () => {
    const r = await ask(true, "failed");
    expect(r.ended).toEqual([false]);
    expect(r.spoke).toEqual([]); // the browser voice is silent in the dark: it is not tried
  });
  it("an unknown outcome from the player is not heard either", async () => {
    expect((await ask(true, "interrupted")).ended).toEqual([false]);
  });
  it("a clip that played to its end is heard", async () => {
    expect((await ask(true, "ended")).ended).toEqual([true]);
  });
  it("the screen on: a broken clip is said again by the browser voice, and heard when that ends - the card is never left waiting in silence", async () => {
    const r = await ask(false, "failed");
    expect(r.spoke).toEqual(["Move this appointment to Monday at 9?"]);
    expect(r.ended).toEqual([true]);
  });
  it("the screen on, an unknown outcome is the same broken clip", async () => {
    const r = await ask(false, "interrupted");
    expect(r.spoke).toHaveLength(1);
    expect(r.ended).toEqual([true]);
  });
  it("a cut says nothing (a Stop re-arms by its own hand), screen on or off", async () => {
    expect(await ask(true, "stopped")).toEqual({ ended: [], spoke: [] });
    expect(await ask(false, "stopped")).toEqual({ ended: [], spoke: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("Greeting counts as heard when the fallback voice reports it was not (dark, no clip)", () => {
  async function greet(heard: boolean) {
    vi.resetModules();
    vi.doMock("@/lib/tts", () => ({
      fetchClip: vi.fn(async () => null), // the clip fetch failed: no clip, so the fallback voice runs
      playClip: vi.fn(),
      speakSmart: vi.fn((_t: string, onEnd?: (h: boolean) => void) => onEnd?.(heard)),
      startBargeInMonitor: vi.fn(() => () => {}),
      stopSpeaking: vi.fn(),
    }));
    const { playGreeting } = await import("@/lib/nort/greeting-player");
    return playGreeting("Morning, Erik. I've got one update on things you reported, want it now?", () => null);
  }
  afterEach(() => vi.doUnmock("@/lib/tts"));

  it("nothing could be heard: the greeting is skipped, never marked asked", async () => {
    expect(await greet(false)).toBe("skipped");
  });
  it("the fallback voice was heard: the greeting is heard", async () => {
    expect(await greet(true)).toBe("heard");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("speakSmart says when a sound began, once, and says nothing while the clip is still on its way", () => {
  it("a native clip: onStart when the plugin has it playing, before the end, never twice", async () => {
    const { plugin, v, tts } = await shell(false);
    v.startListening();
    await flush();
    const log: string[] = [];
    tts.speakSmart("Move this appointment to Monday at 9?", () => log.push("end"), () => log.push("start"));
    await io();
    expect(plugin.calls.some((c) => c.startsWith("play:"))).toBe(true);
    expect(log).toEqual(["start"]);
    plugin.emit("played", { id: 1, outcome: "ended" });
    await io();
    expect(log).toEqual(["start", "end"]);
    v.stopListening({ discard: true });
    await flush();
  });

  it("a clip fetch that has not answered has started nothing", async () => {
    const { v, tts, fetchMock } = await shell(false);
    fetchMock.mockImplementation((() => new Promise(() => {})) as never);
    v.startListening();
    await flush();
    const log: string[] = [];
    tts.speakSmart("Move this appointment to Monday at 9?", () => log.push("end"), () => log.push("start"));
    await io();
    expect(log).toEqual([]);
    tts.stopSpeaking();
    v.stopListening({ discard: true });
    await flush();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("A greeting whose voice never began is skipped at the cap, not reported cut (and counted as asked)", () => {
  type Speak = (t: string, onEnd?: (h: boolean) => void, onStart?: () => void) => void;
  async function greetWith(speak: Speak) {
    vi.resetModules();
    vi.useFakeTimers();
    vi.doMock("@/lib/tts", () => ({
      fetchClip: vi.fn(async () => null), // no clip: speakSmart's own voice runs
      playClip: vi.fn(),
      speakSmart: vi.fn(speak),
      startBargeInMonitor: vi.fn(() => () => {}),
      stopSpeaking: vi.fn(),
    }));
    const { playGreeting } = await import("@/lib/nort/greeting-player");
    const out = playGreeting("Morning, Erik. I've got one update on things you reported, want it now?", () => null);
    await vi.advanceTimersByTimeAsync(9_000); // past the 8 s cap
    return out;
  }
  afterEach(() => vi.doUnmock("@/lib/tts"));

  it("a fetch that hangs past the cap never said a sound began: skipped, so the question is asked again", async () => {
    expect(await greetWith(() => {})).toBe("skipped");
  });
  it("a voice that began and was still going at the cap was audible: cut, which counts as heard", async () => {
    expect(await greetWith((_t, _end, start) => start?.())).toBe("cut");
  });
  it("a voice that began and finished is heard", async () => {
    expect(await greetWith((_t, end, start) => { start?.(); end?.(true); })).toBe("heard");
  });
  it("the player waits for the start: it no longer marks itself audible before speakSmart says so", () => {
    const p = readFileSync(path.join(process.cwd(), "src/lib/nort/greeting-player.ts"), "utf8");
    expect(p).toContain('speakSmart(t, (heard) => settle(heard ? "heard" : "skipped"), armBarge);');
    expect(p).not.toMatch(/cutSound = stopSpeaking;\s*armBarge\(\);/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("A late wake(true) after stop leaks the fast tick into the next conversation", () => {
  it("the mic tapped off by hand ships its turn, and no wake(true) goes to the plugin that is going down", async () => {
    const { plugin, v } = await shell(true);
    const heard: string[] = [];
    v.setResultHandler((t) => heard.push(t));
    v.startListening();
    await flush();
    // The plugin finishes the live turn INSIDE stop: the final turn lands after the page has let go.
    const stop = plugin.stop;
    plugin.stop = async (o) => {
      plugin.emit("turn", turn("manual"));
      return stop(o);
    };
    v.stopListening();
    await flush();
    expect(heard).toEqual(["hello there"]); // the turn still ships
    expect(plugin.calls).toContain("stop:true");
    expect(plugin.calls).not.toContain("wake:true");
  });

  it("the red Stop's turn, already closing when it landed, wakes nothing either", async () => {
    const { plugin, v, fetchMock } = await shell(true);
    v.startListening();
    await flush();
    const stop = plugin.stop;
    plugin.stop = async (o) => {
      const r = await stop(o);
      plugin.emit("turn", turn("pause")); // lands after the plugin's teardown, before the listeners go
      return r;
    };
    v.stopListening({ discard: true });
    await flush();
    expect(plugin.calls).toContain("stop:false");
    expect(plugin.calls).not.toContain("wake:true");
    expect(fetchMock).not.toHaveBeenCalled(); // and the dropped turn still goes nowhere
  });

  it("a live conversation still wakes the page between a turn's stages", async () => {
    const { plugin, v } = await shell(true);
    v.setResultHandler(() => {});
    v.startListening();
    await flush();
    plugin.emit("turn", turn("pause"));
    await flush();
    expect(plugin.calls).toContain("wake:true");
    v.stopListening({ discard: true });
    await flush();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("A later page-load's turn N overwrites an earlier unread 'trace turn N' row", () => {
  type Sent = { title: string; why: string };
  async function pageLoad(sent: Sent[], at: number) {
    vi.resetModules();
    vi.setSystemTime(at);
    vi.doMock("@/lib/native-shell", () => ({ isNativeShell: () => true }));
    vi.doMock("@/app/report-client-error", () => ({
      reportClientError: vi.fn(async (_where: string, title: string, extra?: { why?: string }) => { sent.push({ title, why: String(extra?.why) }); }),
    }));
    vi.stubGlobal("document", { visibilityState: "hidden", addEventListener() {} });
    return await vi.importActual<typeof import("@/lib/nort/trace")>("@/lib/nort/trace");
  }
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => {
    vi.doUnmock("@/lib/native-shell");
    vi.doUnmock("@/app/report-client-error");
  });

  it("a second page load's turn 1 has a title of its own", async () => {
    const sent: Sent[] = [];
    for (const at of [1_000_000, 2_000_000]) {
      const t = await pageLoad(sent, at);
      t.trace("turn", "pause 1300b 3s"); // turn 1 of this load
      t.trace("clip wait"); // ran with the screen dark
      t.flushTrace("screen back");
    }
    expect(sent).toHaveLength(2);
    expect(sent[0].title).toMatch(/^trace turn 1 /); // the title Erik greps for still leads
    expect(sent[1].title).toMatch(/^trace turn 1 /);
    expect(sent[1].title).not.toBe(sent[0].title);
  });

  it("one turn flushed twice (the screen back, then the next turn) is two rows, not one replaced", async () => {
    const sent: Sent[] = [];
    const t = await pageLoad(sent, 3_000_000);
    t.trace("turn", "pause 1300b 3s");
    t.trace("clip wait");
    t.flushTrace("screen back"); // unlocked mid-turn
    t.trace("clip done", "ended"); // hidden again: the reply continues
    t.trace("turn", "pause 1300b 4s"); // the next turn flushes the rest of turn 1 first
    expect(sent.map((s) => s.why)).toEqual(["screen back", "next turn"]);
    expect(sent[0].title).toMatch(/^trace turn 1 /);
    expect(sent[1].title).toMatch(/^trace turn 1 /); // the counter moves after the flush: both are turn 1
    expect(sent[1].title).not.toBe(sent[0].title);
  });

  it("a turn that ran in the light is still not news", async () => {
    const sent: Sent[] = [];
    const t = await pageLoad(sent, 4_000_000);
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {} });
    t.trace("turn", "pause 1300b 3s");
    t.trace("clip wait");
    t.flushTrace("screen back");
    expect(sent).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("A slow Bell poll can overwrite the fresh empty hand-over count and re-light the ring", () => {
  const three = { reports: 3, dailyReports: [] as { from: string }[] };
  const none = () => ({ reports: 0, dailyReports: [] as { from: string }[] });
  const answer = (holding: unknown, unread: number) => ({ items: [], unread, more: false, failed: false, holding });

  async function mount() {
    vi.resetModules();
    rt.slots = [];
    rt.i = 0;
    rt.effects = [];
    rt.polls = [];
    const win = new EventTarget() as EventTarget & Record<string, unknown>;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("setInterval", vi.fn(() => 0));
    vi.stubGlobal("clearInterval", vi.fn());
    const store = await import("@/lib/nort-holding");
    store.setNortHolding(three); // the last poll said: three unheard updates
    const { NotificationBell } = await import("@/components/app-shell/notification-bell");
    const el = NotificationBell() as unknown as { props: { children: { type: () => unknown } } };
    el.props.children.type(); // BellInner, rendered once with the fake hooks
    for (const f of rt.effects) f(); // mount: poll #1 leaves
    // The Bell's unread count is the 2nd state slot (items, unread, more, failed, open).
    const unread = () => rt.slots[1].v;
    return { store, win, unread };
  }

  it("a poll that left before the hand-over does not put the heard updates back", async () => {
    const { store } = await mount();
    expect(rt.polls).toHaveLength(1); // leaves at T0, sees three
    store.setNortHolding(none()); // T2: the chat sets the hold from the turn's own count
    rt.polls[0].resolve(answer(three, 3)); // T3: the slow poll lands with the older count
    await io();
    expect(store.getNortHolding().reports).toBe(0); // the ring stays out
  });

  it("an older poll answered after a newer one is dropped whole (the count too)", async () => {
    const { win, store, unread } = await mount();
    win.dispatchEvent(new Event("cn:bell-refresh")); // the chat's refresh after the hand-over: poll #2
    expect(rt.polls).toHaveLength(2);
    rt.polls[1].resolve(answer(none(), 0)); // the fresh one lands first
    await io();
    expect(store.getNortHolding().reports).toBe(0);
    expect(unread()).toBe(0);
    rt.polls[0].resolve(answer(three, 3)); // the slow first poll lands last
    await io();
    expect(store.getNortHolding().reports).toBe(0);
    expect(unread()).toBe(0);
  });

  it("a stale poll that FAILS after a newer one answered does not flag the Bell failed; the newest one failing still does", async () => {
    const { win } = await mount();
    const failed = () => rt.slots[3].v; // the 4th state slot: items, unread, more, failed
    win.dispatchEvent(new Event("cn:bell-refresh")); // poll #2 leaves after poll #1
    rt.polls[1].resolve(answer(none(), 0)); // the newer one lands
    await io();
    rt.polls[0].reject(new Error("no signal")); // the older one dies late: old news
    await io();
    expect(failed()).toBe(false);
    win.dispatchEvent(new Event("cn:bell-refresh")); // poll #3, the newest
    rt.polls[2].reject(new Error("no signal"));
    await io();
    expect(failed()).toBe(true);
  });

  it("a poll nothing has moved past still lands as before", async () => {
    const { store, unread } = await mount();
    rt.polls[0].resolve(answer({ reports: 1, dailyReports: [] }, 2));
    await io();
    expect(store.getNortHolding().reports).toBe(1);
    expect(unread()).toBe(2);
  });
});
