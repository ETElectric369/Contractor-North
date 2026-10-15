import { isNativeShell } from "@/lib/native-shell";

/**
 * THE JOB'S FENCE WITH THE SCREEN OFF — the page's door to GeofencePlugin.swift (field feedback
 * 10-13, item 4; Chris's 351e2be4). The page keeps owning the fence (components/geofence-monitor):
 * this only arms iOS's region monitor around the same anchor, disarms it at clock-out, and reads
 * back the one thing iOS remembers for us — that the person left, and when — so the sheet opens
 * with that time filled in. Off the shell (or a shell built before the plugin) every call resolves
 * to null and the page behaves exactly as before.
 */
export type PendingExit = { entryId: string; label: string; exitedAt: string };

type Plugin = {
  arm(o: { entryId: string; lat: number; lng: number; radiusM: number; label: string }): Promise<{ ok: boolean; authorization: string }>;
  disarm(): Promise<{ ok: boolean }>;
  readPendingExit(o: { clear?: boolean }): Promise<{ pending: unknown }>;
  status(): Promise<{ authorization: string; armed: unknown }>;
  addListener(ev: "exit", cb: (p: unknown) => void): Promise<{ remove: () => void }>;
};

export const EXIT_EVENT = "cn:geofence-exit";

function plugin(): Plugin | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const p = (window as unknown as { Capacitor?: { Plugins?: { Geofence?: Plugin } } }).Capacitor?.Plugins?.Geofence;
  return p && typeof p.arm === "function" ? p : null;
}

/** A pending exit as the plugin hands it, or null for anything that isn't one (pure, tested). */
export function parsePendingExit(raw: unknown): PendingExit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const entryId = typeof o.entryId === "string" ? o.entryId.trim() : "";
  const exitedAt = typeof o.exitedAt === "string" ? o.exitedAt.trim() : "";
  if (!entryId || !exitedAt || !Number.isFinite(Date.parse(exitedAt))) return null;
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 80) : "the job site";
  return { entryId, label, exitedAt };
}

export async function armFence(o: { entryId: string; lat: number; lng: number; radiusM: number; label: string }): Promise<string | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const r = await p.arm(o);
    return r?.authorization ?? null;
  } catch (e) {
    try { console.warn("[geofence] arm", e); } catch {}
    return null;
  }
}

export async function disarmFence(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try { await p.disarm(); } catch {}
}

/** The exit iOS observed while the app was asleep, if any — cleared once read. */
export async function takePendingExit(): Promise<PendingExit | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const r = await p.readPendingExit({ clear: true });
    return parsePendingExit(r?.pending);
  } catch {
    return null;
  }
}

/** Hear an exit while the app is awake. Returns the stop function. */
export async function onFenceExit(cb: (p: PendingExit) => void): Promise<() => void> {
  const p = plugin();
  if (!p) return () => {};
  try {
    const h = await p.addListener("exit", (raw) => {
      const e = parsePendingExit(raw);
      if (e) cb(e);
    });
    return () => h.remove();
  } catch {
    return () => {};
  }
}
