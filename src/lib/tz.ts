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
