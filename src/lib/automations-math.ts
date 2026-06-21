/** Pure scheduling math for the automation engines (recurring generation + the
 *  customer reminder cadence), extracted from the server-only engines so it can be
 *  unit-tested without a DB. */

/** Advance a yyyy-mm-dd date by one period of the given frequency. Uses noon to
 *  dodge DST edges; month/quarter/year math rolls over as JS Date does (e.g. an end-
 *  of-month date lands on the equivalent rolled date). Unknown frequency = monthly. */
export function advance(date: string, frequency: string): string {
  const d = new Date(`${date}T12:00:00`);
  switch (frequency) {
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The reminder no-spam decision: given the times (ms since epoch) a reminder of this
 *  kind has ALREADY been sent for one entity, should the next one be SUPPRESSED?
 *  True when the per-entity cap is reached, OR the most recent send is within
 *  `withinDays` of `nowMs`. Non-finite timestamps are ignored. */
export function reminderSuppressed(
  priorSentMs: number[],
  withinDays: number,
  cap: number,
  nowMs: number,
): boolean {
  const sent = (priorSentMs ?? []).filter((n) => Number.isFinite(n));
  if (sent.length >= cap) return true;
  if (!sent.length) return false;
  const mostRecent = Math.max(...sent);
  return nowMs - mostRecent < withinDays * 86_400_000;
}
