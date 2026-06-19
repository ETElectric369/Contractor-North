/**
 * Timezone-aware "today" helpers. The server runs in UTC, but the business
 * operates in its own timezone (org settings `timezone`, IANA e.g.
 * "America/Los_Angeles"). Computing day boundaries in UTC makes afternoon work
 * in the Americas fall into "tomorrow", so always derive the day in the org tz.
 */

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

/** Display an instant in the ORG timezone — the tz-correct twins of
 *  formatDate/formatDateTime in lib/utils.ts. Those use the runtime tz, so on the
 *  UTC Vercel server they print UTC (e.g. a 6 PM Pacific clock-out shows as 1 AM
 *  the next day), disagreeing with client-rendered times. Use these for any
 *  server-rendered timestamp that must read in the business's local time. */
export function formatDateTimeTz(value: string | Date | null | undefined, tz: string): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

export function formatDateTz(value: string | Date | null | undefined, tz: string): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
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
  const today = d(/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : "2026-01-01");
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
  const anchor = d(/^\d{4}-\d{2}-\d{2}$/.test(anchorYmd) ? anchorYmd : "2026-01-05");
  const elapsedDays = Math.floor((today.getTime() - anchor.getTime()) / 86_400_000);
  const start = addDays(anchor, Math.floor(elapsedDays / len) * len);
  return { start: fmt(start), end: fmt(addDays(start, len)) };
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
