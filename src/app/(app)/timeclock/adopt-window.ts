/**
 * How long after an anchor window OPENS a missing geofence anchor may still be adopted
 * from a live fix. ONE definition, imported by BOTH the server (adoptGeofenceAnchor in
 * timeclock/actions.ts, which enforces it) and the client (geofence-monitor.tsx, which
 * decides when to even CALL adopt) — they used to hard-code their own copies and drift:
 * the server allowed 45 min after a mid-shift switch while the client capped every
 * adoption at 15 min, so the server's wider post-switch window was dead code and a
 * switch-cleared anchor could never be re-armed once 15 min had passed.
 *
 * Two windows because the two moments are different:
 *  - CLOCK-IN: the tap's own read came back empty and the phone answers a moment later, still
 *    at the site — a short window is plenty, and it must be short so a reopen-from-home HOURS
 *    later can never become "where the job is". Where it OPENS is adoptOpensAtMs, below.
 *  - MID-SHIFT SWITCH: switchJob deliberately NULLS the anchor (never leave the old
 *    site's centre armed), and the tech still has to DRIVE to the new site before
 *    there's a fix worth anchoring on — so the re-arm window is wider (survive the
 *    inter-site drive), still bounded so it can't run all day.
 */
export const ADOPT_AFTER_CLOCK_IN_MS = 15 * 60_000;
export const ADOPT_AFTER_SWITCH_MS = 45 * 60_000;

/** The adoption window for the current trip: the wider post-switch window when a
 *  mid-shift switch has opened a fresh trip this shift, otherwise the clock-in window. */
export function adoptWindowMs(switched: boolean): number {
  return switched ? ADOPT_AFTER_SWITCH_MS : ADOPT_AFTER_CLOCK_IN_MS;
}

/**
 * WHEN THE CLOCK-IN WINDOW OPENS: AT THE TAP, NOT AT THE TIME THAT WAS TYPED (cn-v1169).
 *
 * The window was counted from the entry's `clock_in`, which is the START OF THE WORK, and that is
 * not always the moment the person clocked in. The owner started a clock with a start typed
 * eighty-one minutes back (2026-11-18) and the phone gave no location at the tap: the fifteen
 * minutes were gone before the entry existed, so the fence was off for that clock-in and the app
 * could only say so. A tech's start rounds back to the half hour, so a tap at 7:25 with no fix had
 * the same dead fence for a plainer reason. His go, the next morning, to the fix as proposed:
 * "check it and go for both".
 *
 * What the window is FOR is "the phone is still where the person clocked in", and the moment that
 * speaks to is the tap: the row's own `created_at`. So the window opens at whichever is later, the
 * start or the making of the row.
 *
 * WHY THIS ADDS NO NEW KIND OF ANCHOR: clockIn already stores the tap's own fix at ANY backdate (it
 * writes `gps_in` from the tap whatever start was typed). A fix read a few minutes after that tap,
 * by the same phone, on the same person's own open entry, says the same thing the tap's fix would
 * have. A phone opened from home hours after the TAP is still refused, which is what the short
 * window was always for.
 *
 * AN OFFLINE PUNCH IS THE EXCEPTION AND KEEPS ITS START: its row is made when the phone finds a
 * signal again, hours later and anywhere, so its made-at time says nothing about where the tap was.
 * (`source` 'offline' is the one value the database will not let its subject erase, 0169.)
 *
 * Pure. An unknown made-at time (an older caller, a row read without it) is the start, as before.
 */
export function adoptOpensAtMs(e: { clockInMs: number; madeAtMs?: number | null; source?: string | null }): number {
  const start = Number.isFinite(e.clockInMs) ? e.clockInMs : 0;
  if (e.source === "offline") return start;
  const made = typeof e.madeAtMs === "number" && Number.isFinite(e.madeAtMs) ? e.madeAtMs : 0;
  return Math.max(start, made);
}

/**
 * THE ASK IS REPEATED WHILE THE WINDOW IS OPEN (cn-v1169): what the monitor's timer does next.
 *
 * The monitor asked for a fix when it woke (the app opened, came back to the front, changed page) and
 * at no other time. A phone that could not answer on the first ask, indoors or still finding the
 * sky, was not asked again unless the person happened to move around the app inside the window, and
 * a window that then closed was not said until the next wake. So while there is no anchor a timer
 * comes back once a throttle's length: it asks again unless another check already ran inside that
 * minute, and when the window has closed it says so once and stops. Bounded by the window itself:
 * fifteen asks at most after a clock-in, forty-five after a switch.
 *
 *   stop    nothing is known about when the window opened: nothing to wait for
 *   closed  the window is over: say it, and no more ticks
 *   wait    the window is open: `check` says whether to ask now; come back in `againInMs`, which
 *           lands just past the window's end when that is nearer than the throttle
 */
export type AdoptTick = { kind: "stop" } | { kind: "closed" } | { kind: "wait"; check: boolean; againInMs: number };
export function adoptTick(a: { nowMs: number; fromMs: number; windowMs: number; lastCheckMs: number; throttleMs: number }): AdoptTick {
  if (!a.fromMs) return { kind: "stop" };
  const leftMs = a.fromMs + a.windowMs - a.nowMs;
  if (leftMs < 0) return { kind: "closed" };
  return { kind: "wait", check: a.nowMs - a.lastCheckMs >= a.throttleMs, againInMs: Math.min(a.throttleMs, leftMs) + 250 };
}
