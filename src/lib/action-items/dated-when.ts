/**
 * A DATED AGE (2026-11-04: "140d ago" on a June estimate hid that it was June). The word and the day,
 * month and day, the year only when it isn't this year: "Accepted Jun 12", "Sent Dec 3, 2025". Same
 * hydration law as prettyWhen: the business timezone and the server's today, never the runtime's.
 */
export function datedWhen(word: string, when: string | null | undefined, todayStr: string, tz: string): string | null {
  if (!when) return null;
  const hasTime = when.includes("T");
  const d = hasTime ? new Date(when) : new Date(`${when}T12:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const zone = hasTime ? tz : "UTC";
  const year = d.toLocaleDateString("en-CA", { timeZone: zone }).slice(0, 4);
  const thisYear = year === todayStr.slice(0, 4);
  const day = d.toLocaleDateString("en-US", { timeZone: zone, month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) });
  return `${word} ${day}`;
}
