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
  arm(o: { entryId: string; lat: number; lng: number; radiusM: number; label: string; notify: boolean }): Promise<{ ok: boolean; authorization: string; monitorable?: boolean }>;
  disarm(): Promise<{ ok: boolean }>;
  readPendingExit(o: { clear?: boolean }): Promise<{ pending: unknown }>;
  status(): Promise<{ authorization: string; armed: unknown; monitorable?: boolean }>;
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

/** WHETHER THE FENCE CAN DO ITS JOB with the screen off: "ready" only for Always on a device that
 *  monitors regions. Anything else used to be discarded by the page, so a tech on While Using or
 *  Denied was never told the fence was inert (audit v1120, class 6). Null off the shell. */
export type FenceReadiness = "ready" | "whenInUse" | "denied" | "unavailable";
export function readinessOf(r: { ok?: boolean; authorization?: string; monitorable?: boolean } | null | undefined): FenceReadiness | null {
  if (!r || typeof r !== "object") return null;
  if (r.ok === false || r.monitorable === false) return "unavailable";
  if (r.authorization === "always") return "ready";
  if (r.authorization === "denied" || r.authorization === "restricted") return "denied";
  if (r.authorization === "whenInUse") return "whenInUse";
  return null; // not yet answered: the Always prompt is up — nothing to say until it is read again
}

/** `notify`: the lock-screen "Still on the clock?" alert — techs only, as the server's push is. */
export async function armFence(o: { entryId: string; lat: number; lng: number; radiusM: number; label: string; notify: boolean }): Promise<FenceReadiness | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return readinessOf(await p.arm(o));
  } catch (e) {
    try { console.warn("[geofence] arm", e); } catch {}
    return null;
  }
}

/** The readiness as it stands now (after the Always prompt settles, on each foreground). */
export async function fenceReadiness(): Promise<FenceReadiness | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return readinessOf(await p.status());
  } catch {
    return null;
  }
}

/**
 * THE SHELL'S OWN ANSWER (2026-10-20). Inside the app the WebView's Permissions API reports "prompt"
 * for the site's geolocation even after location was allowed, and the web rule (geo.ts: never read
 * off-gesture in "prompt", because the installed PWA silently denies such a prompt and it can persist)
 * then kept a voice punch's fence from ever asking for the fix that adopts its site — five minutes of
 * screen-on, no fix asked, no anchor, no arm. The shell holds the phone's location permission itself,
 * the one the native fence reads, so there a silent read is safe whenever the app may use location at
 * all. null off the shell, or while the phone has not answered yet (the caller falls back to the web
 * rule); false when the phone said no or regions are unavailable.
 */
export async function shellMayReadLocation(): Promise<boolean | null> {
  if (!plugin()) return null;
  const r = await fenceReadiness();
  if (r === null) return null;
  return r === "ready" || r === "whenInUse";
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
