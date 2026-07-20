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
 *  - CLOCK-IN: "punched from My Day, opened the app at the site" — a short window is
 *    plenty, and it must be short so a reopen-from-home HOURS later can never become
 *    "where the job is".
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
