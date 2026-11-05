/**
 * THE single source of truth for device geolocation.
 *
 * Before this, three components (weather-widget, timeclock-panel, geofence-monitor) each hand-rolled
 * navigator.geolocation with DIVERGENT options and collapsed every failure mode (permission denied /
 * timeout / position-unavailable / insecure-context) into a bare `null` or an empty error handler — so
 * a real failure was indistinguishable from "no location," the UI silently fell back to the shop's city,
 * and a fix in one place never reached the others. This returns a DISCRIMINATED result so callers can
 * tell the cases apart and surface them instead of masking them.
 *
 * THE iOS RULE — NEVER call getPosition()/watchPosition() outside a user gesture unless geoPermission()
 * returns "granted". An iOS home-screen PWA doesn't just ignore an off-gesture permission request — it
 * can silently DENY it and PERSIST that denial, poisoning every later real prompt (the "weather stuck on
 * the shop's city forever" bug). The honest flow: the FIRST request ever rides a real tap (clock-in,
 * "Use my location"); every successful fix memoizes the grant (geo:granted) + caches the fix (gps:last),
 * so from then on mount-time callers can gate on geoPermission() === "granted" and read silently — even
 * on browsers whose Permissions API can't answer (older iOS).
 *
 * ONE POSITION SOURCE, INSIDE THE APP TOO (2026-11-04, "the weather is stuck on home"; "it still asked
 * after Always Allow"). Inside the shell the WebView keeps its own per-site permission on top of the
 * phone's, keeps answering "prompt" after location was allowed, and can raise its OWN alert. So in a
 * shell whose GeofencePlugin offers `currentPosition`, getPosition() reads the phone through CoreLocation
 * (GeofencePlugin.swift — it never asks for permission itself) and geoPermission() answers from the
 * phone's authorization, never from the WebView. An older shell (no such method) and Safari keep the
 * WebView path, with the cn-v1124 shell gate (shellMayReadLocation) in front of a silent read.
 * mayReadLocation() is THE gate every off-gesture reader asks; onResume() is the one wake signal.
 */

import { isNativeShell } from "@/lib/native-shell";

export type GeoCoords = { lat: number; lng: number };

export type GeoResult =
  | { status: "ok"; coords: GeoCoords; accuracy: number; ts: number }
  | { status: "denied" }
  | { status: "timeout" }
  | { status: "unavailable" }
  | { status: "insecure" };

const DEFAULTS: PositionOptions = {
  // Real GPS, no stale browser cache — we want WHERE THE DEVICE IS NOW, not a coarse cell/IP guess
  // from an hour ago (that was the "shows the shop's city" bug). Callers can override.
  enableHighAccuracy: true,
  timeout: 12_000,
  maximumAge: 0,
};

// One successful REAL fix proves the permission is granted — memoized so geoPermission() can answer
// "granted" where the Permissions API can't (older iOS). Set ONLY here, on an actual fix; cleared the
// moment any request comes back denied (revoked in Settings), so it can never green-light a doomed read.
const GRANTED_KEY = "geo:granted";
// Every caller's successful fix also refreshes the shared last-fix cache (weather reads it via
// lastFix()), so a geofence or punch fix keeps the weather on YOUR location with zero extra reads.
const LAST_FIX_KEY = "gps:last";

/** How long the shared last fix stands in for "where the phone is now": ten minutes, and never across
 *  a resume (the phone may have driven off while the app slept). */
export const LAST_FIX_MAX_MS = 10 * 60 * 1000;

let lastFixWriteMs = 0;
// A fix taken before the last resume no longer says where the phone is NOW (see lastFix).
let staleBeforeMs = 0;
function recordFix(c: GeoCoords, accuracy = 0) {
  try {
    localStorage.setItem(GRANTED_KEY, "1");
  } catch {
    /* private mode etc. — the memo just won't persist */
  }
  const now = Date.now();
  if (now - lastFixWriteMs < 60_000) return; // a live watch streams fixes — don't hammer storage
  lastFixWriteMs = now;
  try {
    localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, accuracy, at: now }));
  } catch {
    /* ignore */
  }
}

/** The app came back: a fix from before now is no longer "now" (onResume calls this first). */
export function invalidateLastFix(): void {
  staleBeforeMs = Date.now();
  lastFixWriteMs = 0; // the next fix writes at once, throttle or not
}

// ── The shell's door (GeofencePlugin.swift: window.Capacitor.Plugins.Geofence) ─────────────────────
type NativeGeo = {
  arm: unknown;
  status(): Promise<{ authorization?: string; monitorable?: boolean; ok?: boolean } | null>;
  currentPosition?(o?: { timeout?: number }): Promise<{ latitude?: number; longitude?: number; accuracy?: number; timestamp?: number }>;
};
type Cap = {
  Plugins?: { Geofence?: NativeGeo; App?: { addListener?(ev: string, cb: (s: { isActive?: boolean }) => void): Promise<unknown> } };
  PluginHeaders?: { name?: string; methods?: { name?: string }[] }[];
};
function cap(): Cap | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { Capacitor?: Cap }).Capacitor;
}
function shellPlugin(): NativeGeo | null {
  if (typeof window === "undefined" || !isNativeShell()) return null;
  const p = cap()?.Plugins?.Geofence;
  return p && typeof p.arm === "function" ? p : null;
}
/** Capacitor's plugin object is a proxy that hands back a function for ANY name, so a method is
 *  detected the honest way: the headers the native side published at launch. */
function nativeDeclares(plugin: string, method: string): boolean {
  const h = cap()?.PluginHeaders;
  if (!Array.isArray(h)) return false;
  return !!h.find((x) => x?.name === plugin)?.methods?.some((m) => m?.name === method);
}

/** True inside a shell whose plugin reads the phone's position itself (CoreLocation). */
export function hasNativeRead(): boolean {
  return !!shellPlugin() && nativeDeclares("Geofence", "currentPosition");
}

/**
 * THE SHELL'S OWN ANSWER (2026-10-20; moved here from native-geofence.ts, which re-exports it). Inside
 * the app the WebView's Permissions API reports "prompt" even after location was allowed; the shell
 * holds the phone's permission itself, so there a silent read is safe whenever the app may use
 * location at all. null off the shell, or while the phone has not answered yet (the caller falls back
 * to the web rule); false when the phone said no or regions are unavailable.
 */
export async function shellMayReadLocation(): Promise<boolean | null> {
  const p = shellPlugin();
  if (!p) return null;
  let r: Awaited<ReturnType<NativeGeo["status"]>>;
  try {
    r = await p.status();
  } catch {
    return null;
  }
  if (!r || typeof r !== "object") return null;
  if (r.ok === false || r.monitorable === false) return false;
  if (r.authorization === "always" || r.authorization === "whenInUse") return true;
  if (r.authorization === "denied" || r.authorization === "restricted") return false;
  return null;
}

/**
 * THE GATE: may anything read the phone's position WITHOUT a tap (the cn-v327 law, "Chilcoot dies")?
 * In a shell that reads natively, the phone's authorization; in an older shell, the cn-v1124 shell
 * answer, else the web rule; in Safari, a live (or memoized) grant. Never true in "prompt".
 */
export async function mayReadLocation(): Promise<boolean> {
  if (hasNativeRead()) return (await geoPermission()) === "granted";
  return (await shellMayReadLocation()) ?? ((await geoPermission()) === "granted");
}

// ── Resume: the one wake signal ───────────────────────────────────────────────────────────────────
const resumeSubs = new Set<() => void>();
let resumeWired = false;
let lastResumeMs = -Infinity;
function fireResume() {
  const now = Date.now();
  if (now - lastResumeMs < 1000) return; // visibilitychange and appStateChange arrive together
  lastResumeMs = now;
  invalidateLastFix();
  for (const fn of [...resumeSubs]) {
    try {
      fn();
    } catch {
      /* one subscriber's throw must not starve the rest */
    }
  }
}
function wireResume() {
  if (resumeWired || typeof document === "undefined") return;
  resumeWired = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fireResume();
  });
  const app = cap()?.Plugins?.App;
  if (isNativeShell() && nativeDeclares("App", "addListener") && typeof app?.addListener === "function") {
    void Promise.resolve(app.addListener("appStateChange", (s) => s?.isActive && fireResume())).catch(() => {});
  }
}

/**
 * Hear the app come back to the screen (the page turning visible, or Capacitor's appStateChange
 * active in the shell). The shared last fix is invalidated before any subscriber runs, so a
 * subscriber that asks lastFix() gets null and reads again. Returns the stop function.
 */
export function onResume(fn: () => void): () => void {
  wireResume();
  resumeSubs.add(fn);
  return () => {
    resumeSubs.delete(fn);
  };
}

function clearGrantedMemo() {
  try {
    localStorage.removeItem(GRANTED_KEY);
  } catch {
    /* ignore */
  }
}

function memoGranted(): boolean {
  try {
    return localStorage.getItem(GRANTED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Most recent successful device fix from ANY caller, or null if none / older than maxAgeMs (default
 * LAST_FIX_MAX_MS). A "where is the phone now" read (maxAgeMs ≤ LAST_FIX_MAX_MS) also refuses a fix
 * taken before the last resume; a long-window reader (an address box's bias: "near where it worked
 * this morning") keeps it.
 */
export function lastFix(maxAgeMs: number = LAST_FIX_MAX_MS): GeoCoords | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_FIX_KEY) ?? "null");
    const at = typeof v?.at === "number" ? v.at : v?.ts; // `ts`: a fix written before cn-v1142
    if (typeof v?.lat !== "number" || typeof v?.lng !== "number" || typeof at !== "number") return null;
    if (Date.now() - at > maxAgeMs) return null;
    if (maxAgeMs <= LAST_FIX_MAX_MS && at < staleBeforeMs) return null;
    return { lat: v.lat, lng: v.lng };
  } catch {
    return null;
  }
}

function errCode(e: unknown): string {
  const o = e as { code?: unknown; message?: unknown } | null;
  return String(o?.code ?? o?.message ?? "");
}

/** The phone's own read (GeofencePlugin.currentPosition). null = hand over to the WebView path. */
async function nativePosition(p: NativeGeo): Promise<GeoResult | null> {
  try {
    const r = await p.currentPosition!({ timeout: 10_000 });
    if (typeof r?.latitude !== "number" || typeof r?.longitude !== "number") return { status: "unavailable" };
    const coords = { lat: r.latitude, lng: r.longitude };
    const accuracy = typeof r.accuracy === "number" ? r.accuracy : 0;
    recordFix(coords, accuracy);
    return { status: "ok", coords, accuracy, ts: Date.now() };
  } catch (e) {
    const code = errCode(e);
    if (code === "denied") {
      clearGrantedMemo();
      return { status: "denied" };
    }
    if (code === "timeout") return { status: "timeout" };
    // The phone has not been asked yet: the native side never asks (that is a tap's job), so the
    // WebView path runs — callers only get here inside a tap, because the gate says "prompt".
    // An older plugin without the method: the WebView path too.
    if (code === "not-determined" || /UNIMPLEMENTED|not implemented/i.test(code)) return null;
    return { status: "unavailable" };
  }
}

/**
 * One-shot device position. NEVER throws and NEVER hangs past the timeout; resolves a discriminated
 * status so the caller decides how to handle denied vs timeout vs unavailable (instead of all → null).
 * In a shell that reads natively, the phone answers (see the header); else the WebView.
 */
export async function getPosition(opts?: PositionOptions): Promise<GeoResult> {
  const p = hasNativeRead() ? shellPlugin() : null;
  if (p) {
    const r = await nativePosition(p);
    if (r) return r;
  }
  return webPosition(opts);
}

function webPosition(opts?: PositionOptions): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ status: "unavailable" });
    if (typeof window !== "undefined" && window.isSecureContext === false) return resolve({ status: "insecure" });
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const coords = { lat: p.coords.latitude, lng: p.coords.longitude };
        recordFix(coords, p.coords.accuracy ?? 0); // memoize the grant + refresh the shared last-fix cache
        resolve({ status: "ok", coords, accuracy: p.coords.accuracy ?? 0, ts: Date.now() });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          clearGrantedMemo(); // revoked/blocked — the memo must never green-light a silent read again
          resolve({ status: "denied" });
        } else if (err.code === err.TIMEOUT) resolve({ status: "timeout" });
        else resolve({ status: "unavailable" });
      },
      { ...DEFAULTS, ...opts },
    );
  });
}

/**
 * Continuous watch with a REAL error handler (callers used to pass `() => {}`, so a watch that never
 * armed — GPS off, permission revoked mid-session — failed completely silently). Returns a cleanup fn
 * (no-op if geolocation is unavailable). `onError` receives the same discriminated status.
 */
export function watchPosition(
  onFix: (r: { coords: GeoCoords; accuracy: number; ts: number }) => void,
  onError: (status: "denied" | "timeout" | "unavailable" | "insecure") => void,
  opts?: PositionOptions,
): () => void {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    onError("unavailable");
    return () => {};
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    onError("insecure");
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => {
      const coords = { lat: p.coords.latitude, lng: p.coords.longitude };
      recordFix(coords, p.coords.accuracy ?? 0); // memoize the grant + refresh the shared last-fix cache
      onFix({ coords, accuracy: p.coords.accuracy ?? 0, ts: Date.now() });
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) clearGrantedMemo(); // revoked mid-watch — see getPosition
      onError(err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable");
    },
    opts,
  );
  return () => {
    try {
      navigator.geolocation.clearWatch(id);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Best-effort up-front permission state (Permissions API isn't everywhere — Safari added it late). Lets
 * a caller know location is already "denied" without firing a doomed getPosition that just times out.
 *
 * Where the API can't answer (unsupported / throws — older iOS), the geo:granted memo stands in:
 * "granted" there means a real fix succeeded before, so a silent read is safe. A live "prompt" or
 * "denied" always wins over the memo — never fire an off-gesture request in either state (THE iOS RULE).
 */
export async function geoPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  // Inside a shell that reads natively, the phone's authorization — never the WebView's own answer,
  // which says "prompt" there however the phone is set.
  const p = hasNativeRead() ? shellPlugin() : null;
  if (p) {
    try {
      const a = (await p.status())?.authorization;
      if (a === "always" || a === "whenInUse") return "granted";
      if (a === "denied" || a === "restricted") {
        clearGrantedMemo();
        return "denied";
      }
      return "prompt";
    } catch {
      return "unknown";
    }
  }
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) {
      return memoGranted() ? "granted" : "unknown";
    }
    const s = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    if (s.state === "denied") {
      clearGrantedMemo(); // the OS says no — the memo must not outlive that
      return "denied";
    }
    if (s.state === "granted" || s.state === "prompt") return s.state;
    return memoGranted() ? "granted" : "unknown";
  } catch {
    return memoGranted() ? "granted" : "unknown";
  }
}
