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
 * iOS NOTE: a home-screen PWA only reliably prompts for / returns location when getPosition() is called
 * from inside a user gesture (a tap). Call it from a click handler for the first/explicit request; an
 * on-mount call may be ignored on iOS (the caller should offer a "use my location" tap as the recovery).
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

/**
 * One-shot device position. NEVER throws and NEVER hangs past the timeout; resolves a discriminated
 * status so the caller decides how to handle denied vs timeout vs unavailable (instead of all → null).
 */
export function getPosition(opts?: PositionOptions): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve({ status: "unavailable" });
    if (typeof window !== "undefined" && window.isSecureContext === false) return resolve({ status: "insecure" });
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          status: "ok",
          coords: { lat: p.coords.latitude, lng: p.coords.longitude },
          accuracy: p.coords.accuracy ?? 0,
          ts: Date.now(),
        }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) resolve({ status: "denied" });
        else if (err.code === err.TIMEOUT) resolve({ status: "timeout" });
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
    (p) => onFix({ coords: { lat: p.coords.latitude, lng: p.coords.longitude }, accuracy: p.coords.accuracy ?? 0, ts: Date.now() }),
    (err) => onError(err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable"),
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
 */
export async function geoPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const s = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return (s.state as "granted" | "denied" | "prompt") ?? "unknown";
  } catch {
    return "unknown";
  }
}
