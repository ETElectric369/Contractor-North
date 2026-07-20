/**
 * Timezone-aware "today" helpers. The server runs in UTC, but the business
 * operates in its own timezone (org settings `timezone`, IANA e.g.
 * "America/Los_Angeles"). Computing day boundaries in UTC makes afternoon work
 * in the Americas fall into "tomorrow", so always derive the day in the org tz.
 */
import { formatDate, formatDateTime } from "./utils";

/** Milliseconds the tz is ahead of UTC at the given instant (handles DST). */
export function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUtc - at.getTime();
}

/** "YYYY-MM-DD" for `at` (default now) in the given timezone. */
export function todayStrInTz(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The UTC instant of local midnight for a "YYYY-MM-DD" in the given timezone. */
export function tzDayStartUtc(ymd: string, tz: string): Date {
  const guess = new Date(`${ymd}T00:00:00Z`);
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

/** Minutes past local midnight for an instant in the given timezone — the
 *  time-grid's vertical position (a 3:30 PM Pacific clock-out = 930). */
export function tzMinutesOfDay(at: string | Date, tz: string): number {
  const d = typeof at === "string" ? new Date(at) : at;
  const local = new Date(d.getTime() + tzOffsetMs(tz, d));
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** A time entry's place on the org-tz time grid: the ORG-LOCAL day column it
 *  belongs to + minutes-of-day for its top/bottom edge. An entry clocked
 *  7:00 AM Pacific lands at minute 420 on the PACIFIC day — never bucketed by
 *  the server's UTC day (`toISOString().slice`) or the browser's zone. endMin
 *  is null while the entry is open (the grid runs it to the live now line);
 *  an overnight shift clamps at the day edge, 1440 (display v1 — no midnight
 *  split). The SSOT mapping for /timecards; /schedule maps appointments with
 *  the same two primitives (todayStrInTz + tzMinutesOfDay). */
export function timeEntryGridSpan(
  clockIn: string | Date,
  clockOut: string | Date | null | undefined,
  tz: string,
): { dayStr: string; startMin: number; endMin: number | null } {
  const inD = typeof clockIn === "string" ? new Date(clockIn) : clockIn;
  const dayStr = todayStrInTz(tz, inD);
  const startMin = tzMinutesOfDay(inD, tz);
  if (!clockOut) return { dayStr, startMin, endMin: null };
  const outD = typeof clockOut === "string" ? new Date(clockOut) : clockOut;
  const endMin =
    todayStrInTz(tz, outD) === dayStr ? Math.max(startMin + 1, tzMinutesOfDay(outD, tz)) : 1440;
  return { dayStr, startMin, endMin };
}

/** UTC instant for "YYYY-MM-DD" at local clock `hour` (0–23, may be fractional)
 *  in the given timezone. Lets server actions store "8 AM local" without the
 *  bare-string `new Date("…T08:00")` trap (which parses as the server's UTC). */
export function tzLocalHourUtc(ymd: string, hour: number, tz: string): Date {
  return new Date(tzDayStartUtc(ymd, tz).getTime() + hour * 3_600_000);
}

/** UTC ISO for "YYYY-MM-DD" + "HH:MM" interpreted in the given timezone. The
 *  timezone-safe server replacement for `new Date(`${date}T${time}`).toISOString()`
 *  (which parses as the SERVER's UTC, storing the wrong instant). */
export function tzDateTimeUtc(ymd: string, hm: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hm ?? "");
  const hours = m ? Number(m[1]) + Number(m[2]) / 60 : 8; // default 8 AM
  return tzLocalHourUtc(ymd, hours, tz).toISOString();
}

/** Day boundaries (as UTC instants) + the date string for "today" in tz. */
export function todayBoundsInTz(tz: string): { dayStart: Date; dayEnd: Date; todayStr: string } {
  const todayStr = todayStrInTz(tz);
  const dayStart = tzDayStartUtc(todayStr, tz);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  return { dayStart, dayEnd, todayStr };
}

/** Display an instant in a specific org's timezone. These now just forward to the
 *  canonical (timezone-aware) formatters in lib/utils.ts so there is ONE display
 *  implementation — pass a per-org tz here when you have one; callers without an
 *  org tz can use formatDate/formatDateTime directly (they default to the business
 *  timezone). Kept as named twins so existing call sites need no change. */
export function formatDateTimeTz(value: string | Date | null | undefined, tz: string): string {
  return formatDateTime(value, tz);
}

export function formatDateTz(value: string | Date | null | undefined, tz: string): string {
  return formatDate(value, tz);
}

/** The current pay period [start, end) as date strings, for a schedule + anchor.
 *  `end` is exclusive (the next period's start), so filter clock_in >= start AND
 *  clock_in < end. weekly/biweekly cascade from the anchor; semimonthly splits
 *  the month at the 16th; monthly is the calendar month. */
export function payPeriodBounds(
  schedule: "weekly" | "biweekly" | "semimonthly" | "monthly",
  anchorYmd: string,
  ymd: string,
): { start: string; end: string } {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const fmt = (dt: Date) => dt.toISOString().slice(0, 10);
  const addDays = (dt: Date, n: number) => new Date(dt.getTime() + n * 86_400_000);
  // Validate the REAL date, not just the shape: a regex-passing but invalid date
  // (month 13, "2026-02-30") would make fmt()/toISOString throw RangeError and 500
  // the timecards + payroll pages. Fall back to the safe defaults instead.
  const validYmd = (s: string, fb: string) =>
    typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d(s).getTime()) ? s : fb;
  const today = d(validYmd(ymd, "2026-01-01"));
  if (schedule === "monthly") {
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    return { start: fmt(new Date(Date.UTC(y, m, 1))), end: fmt(new Date(Date.UTC(y, m + 1, 1))) };
  }
  if (schedule === "semimonthly") {
    const y = today.getUTCFullYear(), m = today.getUTCMonth();
    return today.getUTCDate() <= 15
      ? { start: fmt(new Date(Date.UTC(y, m, 1))), end: fmt(new Date(Date.UTC(y, m, 16))) }
      : { start: fmt(new Date(Date.UTC(y, m, 16))), end: fmt(new Date(Date.UTC(y, m + 1, 1))) };
  }
  const len = schedule === "weekly" ? 7 : 14;
  const anchor = d(validYmd(anchorYmd, "2026-01-05"));
  const elapsedDays = Math.floor((today.getTime() - anchor.getTime()) / 86_400_000);
  const start = addDays(anchor, Math.floor(elapsedDays / len) * len);
  return { start: fmt(start), end: fmt(addDays(start, len)) };
}

/** The pay period `offset` cycles before the one containing `todayYmd` (0 =
 *  current). Walks back one period at a time so it's correct for every schedule
 *  (incl. variable-length semimonthly/monthly). */
export function payPeriodForOffset(
  schedule: "weekly" | "biweekly" | "semimonthly" | "monthly",
  anchorYmd: string,
  todayYmd: string,
  offset: number,
): { start: string; end: string } {
  // Clamp to a sane non-negative integer so a non-finite/huge offset can't hang
  // the loop (520 ~= 20 years of biweekly periods).
  const steps = Math.max(0, Math.min(520, Math.floor(Number(offset) || 0)));
  let p = payPeriodBounds(schedule, anchorYmd, todayYmd);
  for (let i = 0; i < steps; i++) {
    const prevDay = new Date(new Date(`${p.start}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    p = payPeriodBounds(schedule, anchorYmd, prevDay);
  }
  return p;
}

/** The 7 org-local day-strings of the week containing `todayStr`, shifted by
 *  `offset` weeks — SIGNED, and **positive = FUTURE** (crew planning looks
 *  ahead; note /timecards' local weekRange pages BACK with positive offsets —
 *  different surface, different direction, hence the loud name difference).
 *  Pure UTC-noon arithmetic on the day STRING (the caller already resolved
 *  "today" in the org tz via todayStrInTz), so it's deterministic and DST-safe.
 *  `weekStart` mirrors org settings week_start. Invalid input falls back to a
 *  fixed date instead of throwing (the payPeriodBounds guard precedent). */
export function weekDayStrs(
  todayStr: string,
  weekStart: "sunday" | "monday",
  offset = 0,
): string[] {
  const safe =
    /^\d{4}-\d{2}-\d{2}$/.test(todayStr ?? "") && !Number.isNaN(new Date(`${todayStr}T00:00:00Z`).getTime())
      ? todayStr
      : "2026-01-01";
  const weeks = Math.max(-520, Math.min(520, Math.trunc(Number(offset) || 0)));
  const utcDow = new Date(`${safe}T00:00:00Z`).getUTCDay(); // Sunday = 0
  const dow = weekStart === "sunday" ? utcDow : (utcDow + 6) % 7; // days since the week started
  const start = new Date(`${safe}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - dow + weeks * 7);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/** Pretty "Weekday, Month D" label for a "YYYY-MM-DD", tz-stable. */
export function prettyDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "HH:MM" → minutes since midnight. Server-safe (lives here, NOT in the "use client"
 *  time-grid — importing a client export from a server page was the /timecards RSC crash). */
export function hmToMin(hm: string): number {
  const [h, m] = String(hm ?? "0:0").split(":").map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}
