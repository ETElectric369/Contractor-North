import { isNativeShell } from "@/lib/native-shell";

/**
 * NORT WITH THE SCREEN OFF — the page's door to NortAudioPlugin.swift (field feedback 10-13,
 * item 4). While a conversation is live the shell holds a real audio session, which is the one
 * thing that keeps the app running after the screen locks. On the web, or a shell built before
 * the plugin, every call is a no-op that resolves to null: the voice loop never waits on it.
 */
type Snapshot = { on: boolean; playing?: boolean; revived?: number; category?: string; mode?: string; seconds?: number; background?: boolean };
type Plugin = {
  keepAlive(o: { on: boolean }): Promise<Snapshot>;
  state(): Promise<Snapshot>;
  addListener(ev: "tick", cb: (s: Snapshot) => void): Promise<{ remove: () => void }>;
};

function plugin(): Plugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const p = (window as unknown as { Capacitor?: { Plugins?: { NortAudio?: Plugin } } }).Capacitor?.Plugins?.NortAudio;
  return p && typeof p.keepAlive === "function" ? p : null;
}

/** Hold (or release) the native session. Never throws; null off the shell. */
export async function keepAlive(on: boolean): Promise<Snapshot | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return await p.keepAlive({ on });
  } catch (e) {
    // The page's loop carries on without the keep-alive; the console says why (bridge log).
    try { console.warn("[nort-audio] keepAlive", on, e); } catch {}
    return null;
  }
}

/**
 * THE SPIKE'S HEARTBEAT: every native tick is echoed from JavaScript, so the bridge log over the
 * cable shows whether the page ran while the screen was dark — the question the plan asks. Off the
 * shell nothing is registered. Returns the stop function.
 */
export async function logHeartbeat(): Promise<() => void> {
  const p = plugin();
  if (!p) return () => {};
  try {
    const h = await p.addListener("tick", (s) => {
      try { console.log(`[nort-audio] tick js-alive background=${s.background} playing=${s.playing} revived=${s.revived} seconds=${s.seconds} category=${s.category}`); } catch {}
    });
    return () => h.remove();
  } catch {
    return () => {};
  }
}
