/**
 * Pure arithmetic for closing a shift that already carries RECORDED SEGMENTS —
 * the time_allocations rows switchJob writes on every mid-shift job switch.
 *
 * Two invariants live here, both wage/billing-critical, both previously missing:
 *
 *  1. A backdated close may never erase recorded work. The geofence's unanswered-prompt
 *     fallback closes an entry at "the time GPS last saw you at the site". With the
 *     anchor stuck on the FIRST job that timestamp was hours before the switch, so the
 *     close wiped the rest of the day's pay. The floor makes that impossible for EVERY
 *     caller (geofence, voice, registry, a crafted call), not just the fixed one.
 *
 *  2. The final segment — from the last switch to clock-out — has to be allocated.
 *     switchJob records only the OUTGOING job; only the timeclock panel seeded a row for
 *     the incoming one, so a close from My Day / the job page / voice left the entry
 *     PARTIALLY allocated. computeJobLaborBilling treats "has any allocation rows" as
 *     fully allocated, so those tail hours were billed to no job and disappeared from
 *     job cost and from the invoice.
 *
 * Neither function touches payroll: hours paid come from clock_in/clock_out/lunch as
 * they always have (see payroll-math). These decide only WHICH JOB the hours bill to,
 * and stop a close from destroying hours already committed.
 */

/**
 * The clock-out instant to persist for an explicitly-supplied `at`.
 * Clamped to [clock_in + 1min, now] as before, and additionally floored at the end of
 * the last recorded segment (clock_in + recorded hours) so a close can't predate work
 * the entry already recorded.
 *
 * @param atMs          the caller's requested clock-out (epoch ms)
 * @param clockInMs     the entry's clock-in (epoch ms); 0/NaN when unknown
 * @param recordedHours sum of the entry's existing time_allocations hours
 * @param nowMs         current time (epoch ms)
 */
export function clampCloseAtMs(
  atMs: number,
  clockInMs: number,
  recordedHours: number,
  nowMs: number,
): number {
  const ci = Number.isFinite(clockInMs) ? clockInMs : 0;
  const rec = Number.isFinite(recordedHours) && recordedHours > 0 ? recordedHours : 0;
  const floor = Math.max(ci + 60_000, ci + rec * 3_600_000);
  return Math.min(Math.max(atMs, floor), nowMs + 60_000);
}

/**
 * Hours to allocate to the entry's CURRENT job at close — the un-recorded remainder,
 * rounded to cents of an hour. 0 when the entry is already fully (or over-) allocated,
 * so this can never inflate billable time beyond the worked shift.
 */
export function tailAllocationHours(workedHours: number, recordedHours: number): number {
  const worked = Number.isFinite(workedHours) ? workedHours : 0;
  const rec = Number.isFinite(recordedHours) && recordedHours > 0 ? recordedHours : 0;
  const tail = Math.round((worked - rec) * 100) / 100;
  return tail > 0.01 ? tail : 0;
}

/**
 * Whether the /timeclock "finish your timecard" prompt should surface for an auto-closed
 * entry, and in which mode. TWO independent reasons to prompt:
 *
 *  1. UNBILLED REMAINDER — worked hours exceed what's already allocated, so the tech
 *     still has to break the rest of the day down by job/code.
 *  2. MISSING MEAL — a shift over 5 GROSS hours whose auto-close skipped the 30-min meal
 *     (lunch still 0), EVEN WHEN every hour is already allocated. That last case is the
 *     switched geofence auto-close: switchJob's segments + the close's tail backstop
 *     filled the whole shift, so the old "prompt only if under-allocated" gate suppressed
 *     the prompt and the shift paid GROSS with no meal deducted — completeAutoClockOut
 *     (reached only via this prompt) is the only place an auto-closed entry's lunch is set.
 *
 * `mealOnly` marks reason 2 with nothing left to allocate — the prompt is a lunch-only
 * confirmation (Save writes just the meal; the hours are already on the entry).
 *
 * Payroll-neutral: this only decides whether to ASK. Hours paid still come from
 * clock_in/clock_out/lunch.
 */
export function autoClockoutPromptState(input: {
  /** clock_out − clock_in, with NO lunch removed. */
  grossHours: number;
  /** lunch minutes currently recorded on the entry. */
  lunchMinutes: number;
  /** sum of the entry's existing time_allocations (switch segments + any tail). */
  allocatedHours: number;
}): { show: boolean; mealOnly: boolean } {
  const gross = Number.isFinite(input.grossHours) && input.grossHours > 0 ? input.grossHours : 0;
  const lunch = Number.isFinite(input.lunchMinutes) && input.lunchMinutes > 0 ? input.lunchMinutes : 0;
  const allocated = Number.isFinite(input.allocatedHours) && input.allocatedHours > 0 ? input.allocatedHours : 0;
  const worked = Math.max(0, gross - lunch / 60);
  const unbilled = worked - allocated > 0.05;
  // A meal is legally owed on a shift over 5 GROSS hours; lunch === 0 ⇒ it was skipped.
  const mealMissing = gross > 5 && lunch === 0;
  const show = unbilled || mealMissing;
  const mealOnly = show && !unbilled && mealMissing;
  return { show, mealOnly };
}
