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
import { todayStrInTz, tzDateTimeUtc, tzDayStartUtc } from "@/lib/tz";

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

// ── "BRIAN WORKED 8 HOURS TODAY" (audit v994 SI6) ────────────────────────────────────────────────

/**
 * The placeholder span for a duration-entered shift ("Brian worked 8 hours Tuesday"): centred on
 * midday in the org's clock, lengthened by the lunch so the paid hours come out as stated.
 *
 * TODAY IS NOT OVER. 0291 refuses a shift that ends in the future for everyone, so "8 hours today"
 * logged at 3 PM invented an 8 AM to 4 PM span and was refused with "Pick the time it really stopped",
 * on a form with no time field. Now a span that would end after now ends AT now instead, when the
 * hours fit between the org's midnight and now, and says so; when they don't fit, the refusal says
 * what to do in words that match the form. A later day is refused outright: nobody has worked it.
 */
export function durationSpan(input: {
  workDate: string;
  hours: number;
  lunchMin: number;
  tz: string;
  nowMs: number;
}): { ok: true; clockIn: string; clockOut: string; warning?: string } | { ok: false; error: string } {
  const spanMin = Math.round(input.hours * 60) + Math.max(0, input.lunchMin);
  const startMin = Math.max(0, 12 * 60 - Math.round(spanMin / 2));
  const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
  const mm = String(startMin % 60).padStart(2, "0");
  const startIso = tzDateTimeUtc(input.workDate, `${hh}:${mm}`, input.tz);
  if (!startIso) return { ok: false, error: "I couldn't read that date." };
  const endMs = Date.parse(startIso) + spanMin * 60_000;
  const today = todayStrInTz(input.tz, new Date(input.nowMs));
  if (input.workDate > today) {
    return { ok: false, error: "That day hasn't happened yet. Log the hours once they're worked." };
  }
  if (endMs <= input.nowMs) {
    return { ok: true, clockIn: startIso, clockOut: new Date(endMs).toISOString() };
  }
  // Today, and the midday span runs past now: end it at now, if the hours fit since midnight.
  const midnight = tzDayStartUtc(input.workDate, input.tz).getTime();
  const nowMin = Math.floor(input.nowMs / 60_000) * 60_000; // whole minutes, like every other span
  const start = nowMin - spanMin * 60_000;
  if (start < midnight) {
    const h = Number.isInteger(input.hours) ? String(input.hours) : input.hours.toFixed(2);
    return {
      ok: false,
      error: `Today isn't over yet, and ${h} hours${input.lunchMin > 0 ? " plus the lunch" : ""} don't fit between midnight and now. Give the hours after the work is done, or give the start and stop times.`,
    };
  }
  const clockIn = new Date(start).toISOString();
  const clockOut = new Date(nowMin).toISOString();
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString("en-US", { timeZone: input.tz, hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ");
  return {
    ok: true,
    clockIn,
    clockOut,
    warning: `Today isn't over yet, so the hours are logged ending now: ${clock(start)} to ${clock(nowMin)}. Change the times on Timecards if that's not right.`,
  };
}

// ── WHERE A LUNCH LANDS AFTER A SWITCH JOB (0288; audit v994 SW3, SW6) ────────────────────────────

/** The touching part before the switch, as the lunch rule needs it. */
export type LunchPart = {
  id: string;
  clock_in: string;
  clock_out: string | null;
  lunch_minutes: number | null;
  /** A paid part is frozen: its hours are in a payroll_runs snapshot (SW6). */
  paid_at?: string | null;
};

/** A lunch fits a part when at least a minute of work is left after it. */
export function lunchFits(startIso: string, endIso: string | null, lunchMin: number): boolean {
  if (!endIso) return false;
  const span = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(span) && span - Math.max(0, lunchMin) * 60_000 >= 60_000;
}

export type LunchPlacement =
  | {
      ok: true;
      /** The lunch this part carries. */
      here: number;
      /** The lunch written onto the part before the switch (raise-only: never below what it has). */
      prior: { id: string; lunch: number } | null;
      /** Said to the person when the lunch did not land where it was asked for. */
      warning?: string;
    }
  | { ok: false; error: string };

/**
 * THE LUNCH HAS TO FIT THE PART IT LANDS ON. ONE RULE FOR EVERY DOOR THAT STATES A LUNCH AFTER A
 * SWITCH: the clock-out, and the "finish your timecard" prompt after a geofence close (which used to
 * write the whole day's lunch onto a 20-minute last part, where hoursBetween clamps it to 0 and the
 * day is paid for minutes nobody worked, SW3).
 *
 *   - A lunch the person put on the part before the switch goes there when that part is the touching
 *     one, is not paid, and has room; otherwise it lands on this part and the answer says why.
 *   - A lunch on this part that does not fit it goes on the part before when it fits there (and the
 *     answer says so).
 *   - A lunch that fits neither is refused in words (`refuse`), or, when nobody can be asked (the
 *     unattended geofence close), stays on this part as it always did.
 *   - A PAID part before the switch never takes a lunch (SW6): its hours are already in a payroll
 *     snapshot, and the office's editor refuses the same change ("Undo on Payroll first").
 *
 * `here` is this part's span (its clock-in, and the clock-out it has or is about to get). `prior` is
 * the caller's OWN touching closed part before it (ended when this one began), or null.
 */
export function placeLunch(input: {
  hereLunch: number;
  /** A lunch the person put on the part before the switch, and the part they meant. */
  priorLunch?: number;
  priorId?: string | null;
  here: { clock_in: string; clock_out: string };
  prior: LunchPart | null;
  refuse: boolean;
}): LunchPlacement {
  let here = Math.max(0, Math.round(Number(input.hereLunch) || 0));
  const asked = Math.max(0, Math.round(Number(input.priorLunch) || 0));
  const p = input.prior;
  const paid = !!p?.paid_at;
  const room = (lunch: number) => !!p && !paid && lunchFits(p.clock_in, p.clock_out, Math.max(Number(p.lunch_minutes) || 0, lunch));
  let prior: { id: string; lunch: number } | null = null;
  let warning: string | undefined;

  if (asked > 0) {
    if (p && (!input.priorId || input.priorId === p.id) && room(asked)) {
      prior = { id: p.id, lunch: Math.max(Number(p.lunch_minutes) || 0, asked) };
    } else {
      here = Math.max(here, asked);
      warning =
        p && paid && (!input.priorId || input.priorId === p.id)
          ? "The part before the switch is already paid, so the lunch went on this part of your shift."
          : "The lunch didn't fit on the part before the switch, so it went on this part of your shift.";
    }
  }

  if (here > 0 && !lunchFits(input.here.clock_in, input.here.clock_out, here)) {
    if (!prior && p && room(here)) {
      prior = { id: p.id, lunch: Math.max(Number(p.lunch_minutes) || 0, here) };
      warning = `The ${here}-minute lunch is longer than this part of your shift, so it went on the part before the switch.`;
      here = 0;
    } else if (input.refuse) {
      const spanMs = Date.parse(input.here.clock_out) - Date.parse(input.here.clock_in);
      const workedMin = Math.max(0, Math.floor((Number.isFinite(spanMs) ? spanMs : 0) / 60_000));
      return {
        ok: false,
        error:
          `A ${here}-minute lunch is longer than the ${workedMin} ${workedMin === 1 ? "minute" : "minutes"} on ${p ? "this part of your shift" : "this shift"}.` +
          (paid ? " The part before the switch is already paid, so it can't go there." : "") +
          " Untick the lunch, or ask the office to fix it on Timecards.",
      };
    }
  }
  return { ok: true, here, prior, ...(warning ? { warning } : {}) };
}
