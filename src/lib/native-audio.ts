import { isNativeShell } from "@/lib/native-shell";

/**
 * NORT WITH THE SCREEN OFF — the page's door to NortAudioPlugin.swift, which records each turn
 * NATIVELY (plan C, 2026-10-14: with the screen dark the page and its spoken replies run, WebKit's
 * own mic does not). The plugin holds the audio session for the conversation, finds the end of each
 * turn by the page's own silence rule, and hands the bytes over as a `turn` event; the page does
 * everything else — transcribe, the model, fetching the reply's voice — with its own session cookie.
 * THE REPLY'S VOICE PLAYS NATIVELY TOO (2026-10-15, the 19:26 round): WebKit will not reliably begin
 * a clip while the page is hidden (play() resolved, no sound), so tts.ts hands each clip's bytes to
 * the plugin (`play`), which plays them in the app process and says `played` when they end. Off the
 * shell, or in a shell built before the plugin, nothing here exists and voice-stream records with
 * getUserMedia as before; a shell with the recorder but no player (build 6) plays on the element.
 */
export type NativeTurn = {
  why: "pause" | "cap" | "no-speech" | "manual";
  /** Base64 AAC (audio/mp4). Absent when nothing is worth sending: no speech, or an empty manual end. */
  audio?: string;
  mime?: string;
  bytes: number;
  seconds: number;
  peak: number;
  floor: number;
  gate: number;
  spoke: boolean;
  turn: number;
};
export type NativeLevel = { rms: number; spoke: boolean; elapsedMs: number };
/** The engine came back after an interruption (a reply's playback, a call, a route change). */
export type NativeResumed = { resumed: boolean; hadTurn: boolean; listening: boolean; why: string };
export type NativeMicEvents = {
  onTurn: (t: NativeTurn) => void;
  onLevel: (l: NativeLevel) => void;
  onResumed: (r: NativeResumed) => void;
};

type Snapshot = Record<string, unknown>;
type Handle = { remove: () => void | Promise<void> };
type Plugin = {
  start(): Promise<Snapshot>;
  listen(): Promise<{ listening?: boolean; pending?: boolean }>;
  endTurn(): Promise<void>;
  cancel(): Promise<void>;
  mute(o: { on: boolean }): Promise<void>;
  wake?(o: { fast: boolean }): Promise<void>;
  play?(o: { audio: string; mime: string; id: number }): Promise<{ playing?: boolean; id?: number; seconds?: number }>;
  stopPlayback?(): Promise<void>;
  stop(o: { ship: boolean }): Promise<Snapshot>;
  state(): Promise<Snapshot>;
  addListener(ev: string, cb: (d: Record<string, unknown> | undefined) => void): Promise<Handle>;
};

function plugin(): Plugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const p = (window as unknown as { Capacitor?: { Plugins?: { NortAudio?: Partial<Plugin> } } }).Capacitor?.Plugins?.NortAudio;
  // The spike's plugin (keepAlive only) is not a recorder: a shell built before this one records on the web path.
  return p && typeof p.start === "function" && typeof p.listen === "function" && typeof p.stop === "function" ? (p as Plugin) : null;
}

/** True when this shell can record natively. */
export function nativeMicAvailable(): boolean {
  return !!plugin();
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseTurn(d: Record<string, unknown> | undefined): NativeTurn {
  const why = String(d?.why ?? "");
  return {
    why: why === "pause" || why === "cap" || why === "no-speech" || why === "manual" ? why : "manual",
    audio: typeof d?.audio === "string" && d.audio ? d.audio : undefined,
    mime: typeof d?.mime === "string" ? d.mime : undefined,
    bytes: num(d?.bytes),
    seconds: num(d?.seconds),
    peak: num(d?.peak),
    floor: num(d?.floor),
    gate: num(d?.gate),
    spoke: !!d?.spoke,
    turn: num(d?.turn),
  };
}

let handles: Handle[] = [];
let ticks = 0;
async function releaseListeners() {
  const hs = handles;
  handles = [];
  for (const h of hs) {
    try {
      await h.remove();
    } catch {
      /* a listener the bridge already dropped */
    }
  }
}

// ── Native playback ──────────────────────────────────────────────────────────────────────────
/** `refused`: the plugin would not start it (the caller may fall back); `failed`: it started and
 *  broke (a decode fault, a lost route) — never spoken again, and a cached clip is dropped. */
export type NativePlayOutcome = "ended" | "stopped" | "failed" | "refused";
/** True while a native conversation is live on a shell whose plugin can play: tts.ts routes every
 *  clip through the plugin then. Set by startNativeMic, cleared by stopNativeMic. */
let playback = false;
export function nativePlaybackOn(): boolean {
  return playback;
}
let playSeq = 0;
/** The clips handed over and not yet ended, by id: `played` settles them; a stop settles them all. */
const waiting = new Map<number, (o: NativePlayOutcome) => void>();
function settlePlay(id: number, o: NativePlayOutcome) {
  const f = waiting.get(id);
  if (f) f(o);
}
function settleAll(o: NativePlayOutcome) {
  for (const f of [...waiting.values()]) f(o);
}
const PLAY_SLACK_MS = 2500;
const PLAY_UNKNOWN_MS = 30000;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(bin);
}

/** Play one clip in the app process. `started` resolves true when the sound has begun (false: it
 *  was stopped before it was handed over; rejects when the plugin would not play it — the caller
 *  may fall back); `done` always settles: `played` from the plugin, a stop here, a refusal, or — a
 *  `played` lost under a process change, or a bridge reply that never comes — the clip's own
 *  length plus slack, so a reply can never hang on a clip. */
export function playNative(blob: Blob): { started: Promise<boolean>; done: Promise<NativePlayOutcome> } {
  const p = plugin();
  const id = ++playSeq;
  let settle: (o: NativePlayOutcome) => void = () => {};
  const done = new Promise<NativePlayOutcome>((res) => {
    settle = res;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (o: NativePlayOutcome) => {
    if (!waiting.delete(id)) return; // settled once
    if (timer) clearTimeout(timer);
    settle(o);
  };
  waiting.set(id, finish);
  const armDeadman = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => finish("ended"), ms);
  };
  const started = (async () => {
    if (!p?.play) throw Object.assign(new Error("no native player"), { code: "missing" });
    const audio = await blobToBase64(blob);
    if (!waiting.has(id)) return false; // stopped while encoding: never hand a dead clip over
    armDeadman(PLAY_UNKNOWN_MS + PLAY_SLACK_MS); // the bridge's own reply may be the thing that is lost
    const r = await p.play({ audio, mime: blob.type || "audio/mpeg", id });
    if (!waiting.has(id)) return true; // ended or stopped before the bridge answered
    const seconds = num(r?.seconds);
    armDeadman((seconds > 0 ? seconds * 1000 : PLAY_UNKNOWN_MS) + PLAY_SLACK_MS);
    return true;
  })();
  started.catch(() => finish("refused"));
  return { started, done };
}

/** Cut the voice: Stop, a barge-in, a new turn. Every clip handed over settles as stopped. */
export async function stopPlaybackNative(): Promise<void> {
  settleAll("stopped");
  try {
    await plugin()?.stopPlayback?.();
  } catch {
    /* the plugin is gone: nothing was playing */
  }
}

/** Open the conversation: the mic permission (iOS asks once), the session, the engine. Rejects with
 *  an error whose `code` is "denied" when the mic is off for North in Settings. */
export async function startNativeMic(ev: NativeMicEvents): Promise<Snapshot> {
  const p = plugin();
  if (!p) throw Object.assign(new Error("no native recorder"), { code: "missing" });
  await releaseListeners();
  handles = await Promise.all([
    p.addListener("turn", (d) => ev.onTurn(parseTurn(d))),
    p.addListener("level", (d) => ev.onLevel({ rms: num(d?.rms), spoke: !!d?.spoke, elapsedMs: num(d?.elapsedMs) })),
    p.addListener("interrupted", (d) =>
      ev.onResumed({ resumed: !!d?.resumed, hadTurn: !!d?.hadTurn, listening: !!d?.listening, why: String(d?.why ?? "") }),
    ),
    // THE HEARTBEAT IS LOAD-BEARING (the 01:25 trace, 2026-10-15). iOS suspends WebKit's page
    // process while the screen is dark unless its own audio is playing; the plugin's tick is a
    // native call into the page, and it is what runs the loop between a turn's stages — but only
    // when a listener exists here, because Capacitor delivers nothing to a page with none. cn-v1099
    // had no listener and the reply waited for the unlock; cn-v1100 listened and the whole loop ran
    // dark. Never remove this. The plugin ticks fast (0.5 s) while the screen is dark, so the console
    // echo is thinned there; the bridge log over the cable still says the page ran.
    p.addListener("tick", (d) => {
      ticks++;
      if (d?.background && ticks % 10 !== 0) return;
      try {
        console.log(`[nort-audio] tick background=${!!d?.background} listening=${!!d?.listening} running=${!!d?.running} muted=${!!d?.muted} turns=${num(d?.turns)} revived=${num(d?.revived)} seconds=${num(d?.seconds)}`);
      } catch {
        /* a console that is gone */
      }
    }),
    // The reply's clips: the plugin says how each one ended.
    p.addListener("played", (d) => {
      const o = String(d?.outcome ?? "");
      settlePlay(num(d?.id), o === "ended" || o === "stopped" ? o : "failed");
    }),
  ]);
  try {
    const snap = await p.start();
    playback = typeof p.play === "function" && typeof p.stopPlayback === "function";
    return snap;
  } catch (e) {
    await releaseListeners();
    throw e;
  }
}

/** Begin a turn. Resolves false when the engine is down (a reply still holds the session): the
 *  plugin starts the turn itself the moment it is back. */
export async function listenNative(): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  const r = await p.listen();
  return r?.listening !== false;
}

/** Drop the turn: nothing of it goes anywhere. */
export async function cancelTurnNative(): Promise<void> {
  try {
    await plugin()?.cancel();
  } catch {
    /* nothing to drop */
  }
}

/** Nort is speaking: the end-of-turn rule pauses; the recording keeps the app alive. */
export async function muteNative(on: boolean): Promise<void> {
  try {
    await plugin()?.mute({ on });
  } catch {
    /* the plugin is gone: nothing to mute */
  }
}

/** The page is working on a turn and needs waking between its stages while the screen is dark
 *  (the fast heartbeat): true from the turn's end, false once the reply plays or a turn listens.
 *  A plugin built before the door (no `wake`) ticks as it always did. */
export async function wakeNative(fast: boolean): Promise<void> {
  try {
    await plugin()?.wake?.({ fast });
  } catch {
    /* the plugin is gone: nothing to wake */
  }
}

/** End the conversation. `ship` sends the live turn first (the mic tapped off by hand); the red
 *  Stop drops it. The listeners go after the final `turn` has been delivered. */
export async function stopNativeMic(ship: boolean): Promise<void> {
  const p = plugin();
  const mine = handles; // this conversation's: a Talk tapped during the stop must keep its own
  handles = [];
  playback = false;
  settleAll("stopped"); // the plugin's teardown cuts the voice; the page's clips must not wait for it
  try {
    await p?.stop({ ship });
  } catch {
    /* already stopped */
  }
  for (const h of mine) {
    try {
      await h.remove();
    } catch {
      /* a listener the bridge already dropped */
    }
  }
}

/** The turn's audio as a Blob for /api/transcribe, or null when it carries none. */
export function turnBlob(t: NativeTurn): Blob | null {
  if (!t.audio) return null;
  try {
    const bin = atob(t.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: t.mime || "audio/mp4" });
  } catch {
    return null;
  }
}
