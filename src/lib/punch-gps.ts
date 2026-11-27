import { getPunchPosition, type GeoResult } from "@/lib/geo";
import { PHONE_ANCHOR_MAX_M } from "@/app/(app)/timeclock/adopt-window";
import type { GeoPoint } from "@/lib/types";

/**
 * ONE READ FOR EVERY PUNCH DOOR (cn-v1201, 2026-11-26: "i was at the job today when i clocked in and
 * it said it couldnt secure a gps coordinate").
 *
 * The Time Clock, My Day, the job page and the visit page each had their own copy of "read the phone,
 * race a short cap, punch regardless", and every cause of a miss became the same null. This is the one
 * copy, and it says WHY a punch has no position:
 *
 *   rough        the phone answered, rougher than PHONE_ANCHOR_MAX_M (it could never be the fence's centre)
 *   stale        the phone answered with a fix older than STALE_FIX_MS
 *   denied       location is off for North
 *   timeout / unavailable / insecure   the phone's own answer
 *   cap          the punch's cap ran out first; the read goes on (it fills the shared last fix) and
 *                its late answer changes nothing that was returned
 *
 * THE iOS RULE (geo.ts): the read starts SYNCHRONOUSLY, inside the caller's tap. The caller must not
 * put an `await` ahead of this call. It NEVER rejects: no position is a note, never a lost punch.
 *
 * The last punch's miss is remembered in module memory with the time it was recorded (lastPunchMiss),
 * for the fence's trace (lib/punch-trace) and nothing else; nothing is written to storage, and a punch
 * that got a position clears it. No words here (a lib never imports a catalog): the doors say what a miss means.
 */

export type PunchMiss = "rough" | "stale" | "denied" | "timeout" | "unavailable" | "insecure" | "cap";
export type PunchGps = { gps: GeoPoint | null; miss: PunchMiss | null };

/** A fix older than this is not "where the phone is now" for a punch (the read's own maximumAge). */
export const STALE_FIX_MS = 30_000;

/** What every punch asks for. In the shell getPunchPosition asks for a hundred metres whatever these
 *  say; in a browser they are the options, as the doors passed them before. */
const PUNCH_READ: PositionOptions = { enableHighAccuracy: true, timeout: 8000, maximumAge: STALE_FIX_MS };

let lastMiss: { miss: PunchMiss | null; atMs: number } | null = null;

/** How long before the fence's window opens a punch's read may have been recorded and still be this
 *  clock-in's (the tap reads before the server writes the row that opens the window). */
export const PUNCH_MISS_MATCH_MS = 60_000;

/**
 * The punch miss of THIS clock-in, for the trace: the last punch's miss when it was recorded no more
 * than PUNCH_MISS_MATCH_MS before `sinceMs` (the adoption window's opening). null means "no punch miss
 * known to this page for this clock-in": none was recorded in this page's life, the last punch got a
 * position, or the last one recorded belongs to an earlier punch.
 */
export function lastPunchMiss(sinceMs: number): PunchMiss | null {
  if (!lastMiss) return null;
  if (Number.isFinite(sinceMs) && lastMiss.atMs < sinceMs - PUNCH_MISS_MATCH_MS) return null;
  return lastMiss.miss;
}

/**
 * THE ONE WINDOW EVENT the fence fires about the open punch's location (cn-v1201), with
 * `detail.outcome`:
 *   added   the late stamp landed: the Time Clock's note becomes "Location added" (only if one is up);
 *   closed  the adoption window closed with no position: a "still looking" note is removed;
 *   off     the gate refused a read while there is no anchor: a "still looking" note becomes the
 *           location-off note.
 * One name and one reader, here, for both sides.
 */
export const PUNCH_LOCATION_EVENT = "cn:punch-location";
export type PunchLocationOutcome = "added" | "closed" | "off";
const PUNCH_LOCATION_OUTCOMES: readonly PunchLocationOutcome[] = ["added", "closed", "off"];

/** Fire the event. Never throws (nothing listening is fine). */
export function firePunchLocation(outcome: PunchLocationOutcome): void {
  try {
    window.dispatchEvent(new CustomEvent(PUNCH_LOCATION_EVENT, { detail: { outcome } }));
  } catch {
    /* no window, or nothing listening */
  }
}

/** The Time Clock's note after a clock-in with no position: location off, still looking, or the late
 *  stamp landed. (The words are the panel's; a lib carries none.) */
export type PunchNote = "denied" | "waiting" | "added";

/**
 * How the one event moves the note (cn-v1201), pure: `added` makes any note "added" (no note stays no
 * note); `closed` removes a "still looking" note (a location-off note stays); `off` turns a "still
 * looking" note into the location-off one. Anything else leaves the note as it is.
 */
export function punchNoteAfter(note: PunchNote | null, outcome: PunchLocationOutcome | null): PunchNote | null {
  if (note === null || outcome === null) return note;
  if (outcome === "added") return "added";
  if (note !== "waiting") return note;
  return outcome === "closed" ? null : "denied";
}

/** The event's outcome, or null for anything that is not one of the three. */
export function punchLocationOutcome(e: Event): PunchLocationOutcome | null {
  const o = (e as CustomEvent<{ outcome?: unknown } | null>).detail?.outcome;
  return PUNCH_LOCATION_OUTCOMES.includes(o as PunchLocationOutcome) ? (o as PunchLocationOutcome) : null;
}

/**
 * THE ONE READING OF A FIX FOR A PUNCH AND FOR THE FENCE'S ADOPTION (cn-v1201): "ok" only when the
 * phone answered with a fix no older than STALE_FIX_MS and no rougher than PHONE_ANCHOR_MAX_M; else
 * the word for why not. An accuracy that is negative or not a finite number is "rough": CoreLocation
 * marks an invalid fix with a negative accuracy, so it is not a position. Zero stays within the limit
 * (a native fix with no accuracy reads 0, as before). Pure.
 */
export function fixWord(r: GeoResult): "ok" | Exclude<PunchMiss, "cap"> {
  if (r.status !== "ok") return r.status;
  if (typeof r.fixAgeMs === "number" && r.fixAgeMs > STALE_FIX_MS) return "stale";
  const a = r.accuracy;
  if (!(typeof a === "number" && Number.isFinite(a) && a >= 0 && a <= PHONE_ANCHOR_MAX_M)) return "rough";
  return "ok";
}

export function punchGps(capMs: number): Promise<PunchGps> {
  let read: Promise<PunchGps>;
  try {
    read = getPunchPosition(PUNCH_READ)
      .then((r): PunchGps => {
        const w = fixWord(r);
        if (w !== "ok" || r.status !== "ok") return { gps: null, miss: w === "ok" ? "unavailable" : w };
        return { gps: { lat: r.coords.lat, lng: r.coords.lng, accuracy: r.accuracy }, miss: null };
      })
      .catch((): PunchGps => ({ gps: null, miss: "unavailable" }));
  } catch {
    read = Promise.resolve({ gps: null, miss: "unavailable" });
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<PunchGps>((res) => {
    timer = setTimeout(() => res({ gps: null, miss: "cap" }), capMs);
  });
  return Promise.race([read, cap]).then((out) => {
    if (timer) clearTimeout(timer);
    lastMiss = { miss: out.miss, atMs: Date.now() };
    return out;
  });
}
