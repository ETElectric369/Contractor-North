/**
 * THE TIME CLOCK'S TWO REMINDERS, ONE RULE EACH (cn-v1192). The owner, of the 6 PM clock-out push:
 * "the 6pm push should only be necessary if someone is clocked in or scheduled correct? it should be
 * precise dont you think?", and of the morning one, "a morning push should be optional in settings
 * like the other notifications".
 *
 * Each rule lives here once and is read by BOTH channels of its route (the push and the text), so the
 * two can never disagree about who is reminded and when:
 *
 *   CLOCK-OUT (api/timeclock/eod-reminder, runs hourly; a company is looked at from its 6 PM to its
 *   11 PM). A person is reminded ONCE, at THEIR due hour, when their shift (by loadShiftChains) is still
 *   open, began on the company's today, is at least an hour old, and the 12-hour question has not asked
 *   about it. The due hour is 6 PM, or, when the job they are clocked into right now is on today's
 *   schedule and its hours end later, the first whole hour at or after that end. Hours that end after
 *   11 PM get no reminder: the run after them is tomorrow, and the 12-hour question is the backstop.
 *
 *   CLOCK-IN (api/timeclock/nudge, runs every 15 minutes; only for a company that ticked Clock-In
 *   Reminders on the Scheduling card, cn-v1193: the owner, "the clock in reminder setting should be
 *   controlled by the boss not the employee"). A person the schedule has on today, with
 *   no punch today and none still open, is reminded ONCE: due when slot - 30 min < first start <=
 *   slot - 15 min, the slot being the run's time floored to the quarter hour. So a 9:00 start is
 *   reminded at 9:15, an 8:30 start at 8:45, an 8:05 start at 8:30: every start has exactly one run,
 *   15 to 30 minutes after it.
 *
 * KNOWN LIMITS, said here where the rules live: a start in the last half hour before the company's
 * midnight gets no clock-in reminder (the run after it reads the next day); a person who switches jobs
 * between two hourly runs can be reminded to clock out twice, or not at all (each run judges the job
 * they are clocked into at that run); and a cron run that fires twice reminds twice, because nothing
 * is stamped.
 *
 * Pure: no reads, no catalog (the words are the routes'). The clock words below carry no catalog
 * either: they are the time, in the reader's locale.
 */
import { localeOf, type Lang } from "@/lib/locale";

/** The clock-out reminder's own hour, and the last hour any run still reminds (company time). */
export const CLOCK_OUT_HOUR = 18;
export const LAST_CLOCK_OUT_HOUR = 23;
/** A shift younger than this at its due run gets no clock-out reminder that evening. */
export const MIN_SHIFT_MS = 60 * 60_000;
/** How long after a scheduled start the clock-in reminder waits. */
export const CLOCK_IN_GRACE_MS = 15 * 60_000;

const QUARTER_MS = 15 * 60_000;

/**
 * A time as a clock in the company's clock, in the reader's language: "7:00 AM", and in Spanish with
 * its article, "las 7:00 am" (or "la 1:00 pm"), so the sentence needs no rule of its own. ICU's narrow
 * no-break space is a plain space, and Spanish "a. m." is written without dots (the sentence adds its
 * own stop), the way the 12-hour question's clock says it. Both reminders' pushes name a time with it.
 */
export function clockSince(ms: number, tz: string, lang: Lang): string {
  const clock = new Date(ms)
    .toLocaleTimeString(localeOf(lang), { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .replace(/[  ]/g, " ")
    .replace(/\b([ap])\.\s?m\.$/i, "$1m");
  if (lang !== "es") return clock;
  return `${/^1:/.test(clock) ? "la" : "las"} ${clock}`;
}

/**
 * THE CLOCK-OUT DUE HOUR (company time, 0-23), from the end of the hours of the job a person is
 * clocked into, in minutes past the company's midnight (null: a punch with no job, or a job that is
 * not on today, has no hours). 6 PM, or the first whole hour at or after a later end (7:30 PM is the
 * 8 PM run, 8:00 PM is the 8 PM run). null when the hours end after 11 PM: no run is left that day.
 */
export function clockOutDueHour(jobEndMin: number | null | undefined): number | null {
  if (jobEndMin == null || !Number.isFinite(jobEndMin) || jobEndMin <= CLOCK_OUT_HOUR * 60) return CLOCK_OUT_HOUR;
  const hour = Math.ceil(jobEndMin / 60);
  return hour <= LAST_CLOCK_OUT_HOUR ? hour : null;
}

/** One open punch, as the clock-out rule reads it. */
export type OpenShift = {
  profileId: string;
  /** The open row's own clock-in (the latest open row is what the person is clocked into right now). */
  clockInMs: number;
  /** The shift's start by loadShiftChains (a Switch Job does not reset it). */
  startMs: number;
  /** The open row's job, or null. */
  jobId: string | null;
  /** The 12-hour question already asked about this shift. */
  nudged: boolean;
  /** The person is active in the company. */
  active: boolean;
};

/**
 * THE OPEN SHIFTS IN PLAY on a clock-out run, decided here once: the person is active, the 12-hour
 * question has not asked about the shift, and the shift began on the company's today (not after now).
 * The route counts and reads the schedule by it; dueToClockOut judges only what it keeps.
 */
export function shiftsInPlay(shifts: readonly OpenShift[], p: { dayStartMs: number; nowMs: number }): OpenShift[] {
  return shifts.filter(
    (s) => s.active && !s.nudged && Number.isFinite(s.startMs) && s.startMs >= p.dayStartMs && s.startMs <= p.nowMs,
  );
}

/**
 * WHO IS DUE THE CLOCK-OUT REMINDER ON THIS RUN. `runHour` is the run's hour on the company's clock;
 * `jobEndMin` answers the end of a job's hours today, or null when the job is not on today. One
 * answer per person: their shift's earliest start, judged by the job of the row they clocked into last.
 */
export function dueToClockOut(p: {
  shifts: readonly OpenShift[];
  jobEndMin: (jobId: string) => number | null;
  runHour: number;
  nowMs: number;
  dayStartMs: number;
}): { profileId: string; startMs: number }[] {
  const byPerson = new Map<string, { startMs: number; clockInMs: number; jobId: string | null }>();
  // A removed person is never reminded; one ask per clock; the shift began today.
  for (const s of shiftsInPlay(p.shifts, p)) {
    const had = byPerson.get(s.profileId);
    if (!had) {
      byPerson.set(s.profileId, { startMs: s.startMs, clockInMs: s.clockInMs, jobId: s.jobId });
      continue;
    }
    had.startMs = Math.min(had.startMs, s.startMs);
    if (s.clockInMs > had.clockInMs) {
      had.clockInMs = s.clockInMs;
      had.jobId = s.jobId;
    }
  }
  const out: { profileId: string; startMs: number }[] = [];
  for (const [profileId, s] of byPerson) {
    if (p.nowMs - s.startMs < MIN_SHIFT_MS) continue; // under an hour old: no reminder this evening
    const due = clockOutDueHour(s.jobId ? p.jobEndMin(s.jobId) : null);
    if (due === p.runHour) out.push({ profileId, startMs: s.startMs });
  }
  return out;
}

/** The clock-in run's slot: the run's own time floored to the quarter hour (the cron runs every 15
 *  minutes, vercel.json), so a run a few seconds late is still its own quarter. */
export function clockInSlotMs(nowMs: number): number {
  return Math.floor(nowMs / QUARTER_MS) * QUARTER_MS;
}

/** Is a first start due on the run with this slot? slot - 30 min < start <= slot - 15 min. */
export function isClockInDue(firstStartMs: number, slotMs: number): boolean {
  return Number.isFinite(firstStartMs) && firstStartMs > slotMs - QUARTER_MS - CLOCK_IN_GRACE_MS && firstStartMs <= slotMs - CLOCK_IN_GRACE_MS;
}

/** The people whose first start today falls due on this run, with that start. */
export function dueToClockIn(firstStarts: ReadonlyMap<string, number>, slotMs: number): { profileId: string; startMs: number }[] {
  const out: { profileId: string; startMs: number }[] = [];
  for (const [profileId, startMs] of firstStarts) if (isClockInDue(startMs, slotMs)) out.push({ profileId, startMs });
  return out;
}
