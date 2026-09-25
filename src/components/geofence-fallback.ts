/**
 * WHEN THE UNANSWERED GEOFENCE SHEET WILL CLOSE THE SHIFT ON ITS OWN (audit v994 SI7).
 *
 * One predicate for the three places that must agree: the fix handler that fires the close, the
 * heartbeat that keeps the promise honest, and the line that says the time out loud. A long-shift
 * sheet opens on the picker, so an untouched picker is the same unanswered prompt; before this the
 * close could fire from the picker five minutes later at a time the sheet never showed.
 *
 * Pure: the monitor hands it its refs.
 */
export type GeofencePhase = "idle" | "prompt" | "picking" | "saving" | "confirmed";

export function fallbackArmed(s: {
  phase: GeofencePhase;
  /** The sheet opened on a clock already past the long-shift line (straight onto the picker). */
  longPrompt: boolean;
  /** The person has picked a stop time. */
  picked: boolean;
  /** "live": the watch saw him at the site and then outside; "wake": nothing was observed. */
  source: "live" | "wake";
  /** The last time a fix put him inside the fence (0 = never this page-life). */
  lastInsideMs: number;
  /** The fix stream had a hole, so the last-inside time is a memory, not an observation. */
  streamGap: boolean;
}): boolean {
  const unanswered = s.phase === "prompt" || (s.phase === "picking" && s.longPrompt && !s.picked);
  return unanswered && s.source === "live" && s.lastInsideMs > 0 && !s.streamGap;
}
