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
 */

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

let lastFixWriteMs = 0;
function recordFix(c: GeoCoords) {
  try {
    localStorage.setItem(GRANTED_KEY, "1");
  } catch {
    /* private mode etc. — the memo just won't persist */
  }
  const now = Date.now();
  if (now - lastFixWriteMs < 60_000) return; // a live watch streams fixes — don't hammer storage
  lastFixWriteMs = now;
  try {
    localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, ts: now }));
  } catch {
    /* ignore */
  }
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

/** Most recent successful device fix from ANY caller, or null if none / older than maxAgeMs. */
export function lastFix(maxAgeMs: number): GeoCoords | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_FIX_KEY) ?? "null");
    if (typeof v?.lat !== "number" || typeof v?.lng !== "number" || typeof v?.ts !== "number") return null;
    if (Date.now() - v.ts > maxAgeMs) return null;
    return { lat: v.lat, lng: v.lng };
  } catch {
    return null;
  }
}

/**
 * One-shot device position. NEVER throws and NEVER hangs past the timeout; resolves a discriminated
 * status so the caller decides how to handle denied vs timeout vs unavailable (instead of all → null).
 */
export function getPosition(opts?: PositionOptions): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ status: "unavailable" });
    if (typeof window !== "undefined" && window.isSecureContext === false) return resolve({ status: "insecure" });
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const coords = { lat: p.coords.latitude, lng: p.coords.longitude };
        recordFix(coords); // memoize the grant + refresh the shared last-fix cache
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
      recordFix(coords); // memoize the grant + refresh the shared last-fix cache
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
