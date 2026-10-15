import { isNativeShell } from "@/lib/native-shell";

/**
 * NORT WITH THE SCREEN OFF — the page's door to NortAudioPlugin.swift, which records each turn
 * NATIVELY (plan C, 2026-10-14: with the screen dark the page and its spoken replies run, WebKit's
 * own mic does not). The plugin holds the audio session for the conversation, finds the end of each
 * turn by the page's own silence rule, and hands the bytes over as a `turn` event; the page does
 * everything else — transcribe, the model, the reply's voice — with its own session cookie. Off the
 * shell, or in a shell built before the plugin, nothing here exists and voice-stream records with
 * getUserMedia as before.
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
    // THE HEARTBEAT (every 5 s): echoed to the console so the bridge log over the cable says whether
    // the page ran, and a turn recorded, while the screen was dark — the only way to read a locked
    // phone. The first native night (2026-10-15) could not say, because nothing listened for it.
    p.addListener("tick", (d) => {
      try {
        console.log(`[nort-audio] tick background=${!!d?.background} listening=${!!d?.listening} running=${!!d?.running} muted=${!!d?.muted} turns=${num(d?.turns)} revived=${num(d?.revived)} seconds=${num(d?.seconds)}`);
      } catch {
        /* a console that is gone */
      }
    }),
  ]);
  try {
    return await p.start();
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

/** End the conversation. `ship` sends the live turn first (the mic tapped off by hand); the red
 *  Stop drops it. The listeners go after the final `turn` has been delivered. */
export async function stopNativeMic(ship: boolean): Promise<void> {
  const p = plugin();
  const mine = handles; // this conversation's: a Talk tapped during the stop must keep its own
  handles = [];
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
