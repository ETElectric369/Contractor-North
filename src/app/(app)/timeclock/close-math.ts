/**
 * Pure arithmetic for closing a shift, and for the /timeclock "finish your timecard" prompt.
 *
 * A split shift used to keep its clock times on the entry and write its hours per job into a second
 * table, so closing one had to protect those rows (a floor at the last recorded segment, a tail row
 * for the part after the last switch). Since 0288 a Switch Job CLOSES the running entry and opens the
 * next one, so every part of a day is its own entry with its own clock times, and a close only ever
 * touches the one entry that is still running. What is left here is the part that never depended
 * on the split: a close may not land before the shift started or in the future.
 *
 * Neither function touches payroll arithmetic: hours paid come from clock_in/clock_out/lunch as
 * they always have (see payroll-math).
 */
import { isLongOpenShift } from "@/lib/long-shift";

/**
 * The clock-out instant to persist for an explicitly supplied `at` (the geofence "time they left",
 * a picked time). Clamped to [clock_in + 1 min, now + 1 min]: never negative hours, never a close
 * in the future.
 *
 * @param atMs       the caller's requested clock-out (epoch ms)
 * @param clockInMs  the entry's clock-in (epoch ms); 0/NaN when unknown
 * @param nowMs      current time (epoch ms)
 */
export function clampCloseAtMs(atMs: number, clockInMs: number, nowMs: number): number {
  const ci = Number.isFinite(clockInMs) ? clockInMs : 0;
  return Math.min(Math.max(atMs, ci + 60_000), nowMs + 60_000);
}

/** Written onto an auto-closed shift's notes once its owner has answered the after-the-fact
 *  questions, so the prompt stops asking. Human-readable on purpose: the office reads it too. */
export const AUTO_CONFIRMED_CRUMB = "[hours confirmed after the auto clock-out]";

/** The notes with the confirmation crumb added once (never twice). */
export function withAutoConfirmedCrumb(notes: string | null | undefined): string {
  const base = (notes ?? "").trim();
  if (base.includes(AUTO_CONFIRMED_CRUMB)) return base;
  return base ? `${base}\n${AUTO_CONFIRMED_CRUMB}` : AUTO_CONFIRMED_CRUMB;
}

/**
 * Whether the /timeclock "finish your timecard" prompt should surface for an auto-closed entry.
 *
 * A geofence close (or "clock out now, I'll answer later") asked nobody anything, so the prompt asks
 * the one thing a tech can still answer after the fact: did you take a lunch. (The office's own
 * prompt also offers "I switched at [time]", which is a split.) It stays until somebody answers,
 * and answering writes AUTO_CONFIRMED_CRUMB. Until 2026-09-24 the gate was "hours not yet broken
 * down by job"; every hour of an entry now belongs to its own job, so there is nothing left to break
 * down and the only question left is whether it was answered.
 *
 * Payroll-neutral: this only decides whether to ASK.
 */
export function autoClockoutPromptState(input: { notes: string | null | undefined }): { show: boolean } {
  return { show: !String(input.notes ?? "").includes(AUTO_CONFIRMED_CRUMB) };
}

// ── A FORGOTTEN CLOCK STOPS AT A STATED TIME (Erik, 2026-09-24) ───────────────────────────────────

/**
 * Whether a clock-out has to ask WHEN the shift stopped instead of closing it at "now".
 *
 * True when a person tapped a plain Clock Out (nothing picked, nobody's geofence answering for
 * them), the close lands at about now, and the clock has been running LONG_SHIFT_HOURS or more. A
 * 34-hour "now" close is the one-tap mistake this exists to stop: the man forgot on Tuesday, taps
 * Clock Out on Wednesday, and payroll reads a day and a half.
 *
 * Passes, deliberately:
 *   - picked: the person stated the stop time, which is the whole point;
 *   - unattended: a geofence exit nobody answered carries an OBSERVED past time and is already
 *     flagged for the office by auto_closed_reason;
 *   - a close well before now (an `at` the geofence observed): that is a real time, not a default.
 */
export function needsStatedStop(input: {
  clockInMs: number;
  closeMs: number;
  nowMs: number;
  picked: boolean;
  unattended: boolean;
}): boolean {
  if (input.picked || input.unattended) return false;
  if (Math.abs(input.closeMs - input.nowMs) > 2 * 60_000) return false;
  return isLongOpenShift(input.clockInMs, input.closeMs);
}

function clockLabel(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}

/** "Sep 23, 11:56 PM" in the org's clock, plain spaces. */
function whenLabel(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  return `${day}, ${clockLabel(iso, tz)}`;
}

/**
 * The line written onto a shift's notes when a clock is stopped after the fact, so the timecard says
 * who set the stop time and when. The notes are the only history a time entry has (a full edit
 * trail is a bigger change), and a stop time a person typed a day later has to be told apart from
 * a live punch.
 *
 *   office: "[clocked out by Erik Taylor on Sep 23, 11:56 PM; it had been running since Sep 22, 1:37 PM]"
 *           plus "; start moved from 1:37 PM to 12:00 PM" inside the brackets when the start moved
 *           (with the dates, "from Sep 22, 1:37 PM to Sep 21, 11:00 PM", when it moved to another day).
 *   self:   "[stop time picked by Brian Taylor on Sep 23, 7:02 AM, after the shift]"
 */
export function stopCrumb(input: {
  byName: string;
  atIso: string;
  runningSinceIso: string;
  newStartIso: string | null;
  tz: string;
  how: "office" | "self";
}): string {
  const who = (input.byName || "").trim() || "the office";
  if (input.how === "self") {
    return `[stop time picked by ${who} on ${whenLabel(input.atIso, input.tz)}, after the shift]`;
  }
  let body = `clocked out by ${who} on ${whenLabel(input.atIso, input.tz)}; it had been running since ${whenLabel(input.runningSinceIso, input.tz)}`;
  if (input.newStartIso && Math.abs(Date.parse(input.newStartIso) - Date.parse(input.runningSinceIso)) >= 60_000) {
    // A start moved to another day names both days, so the card never reads a day's move as an
    // hour's.
    const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: input.tz });
    const label = dayOf(input.newStartIso) === dayOf(input.runningSinceIso) ? clockLabel : whenLabel;
    body += `; start moved from ${label(input.runningSinceIso, input.tz)} to ${label(input.newStartIso, input.tz)}`;
  }
  return `[${body}]`;
}

/** The notes with a stop crumb appended on its own line, never twice. */
export function withStopCrumb(notes: string | null | undefined, crumb: string): string {
  const base = (notes ?? "").trim();
  if (base.includes(crumb)) return base;
  return base ? `${base}\n${crumb}` : crumb;
}
