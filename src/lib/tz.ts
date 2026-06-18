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

/** Pretty "Weekday, Month D" label for a "YYYY-MM-DD", tz-stable. */
export function prettyDay(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
