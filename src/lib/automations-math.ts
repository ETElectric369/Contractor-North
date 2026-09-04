/** Pure scheduling math for the automation engines (recurring generation + the
 *  customer reminder cadence), extracted from the server-only engines so it can be
 *  unit-tested without a DB. */

/** Add months and CLAMP to the target month's last day. JS setMonth rolls a 31st over into
 *  the following month (Jan 31 + 1 → Mar 3), which made a monthly template dated the 29th-31st
 *  skip a whole billing cycle — February never got invoiced. */
function addMonthsClamped(d: Date, months: number): void {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
}

/** Advance a yyyy-mm-dd date by one period of the given frequency. Uses noon to dodge DST
 *  edges; month/quarter/year steps clamp to the last day of the target month (Jan 31 → Feb 28,
 *  Feb 29 → next Feb 28) instead of rolling over. Unknown frequency = monthly. */
export function advance(date: string, frequency: string): string {
  const d = new Date(`${date}T12:00:00`);
  switch (frequency) {
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": addMonthsClamped(d, 1); break;
    case "quarterly": addMonthsClamped(d, 3); break;
    case "yearly": addMonthsClamped(d, 12); break;
    default: addMonthsClamped(d, 1);
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
