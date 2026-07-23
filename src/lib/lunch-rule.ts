/** THE lunch rule — one place (Erik 2026-07-22: "remove the took-a-lunch and breaks
 *  checkboxes completely and do it automatically").
 *
 *  A shift over 5 gross hours gets a 30-minute unpaid lunch deducted AUTOMATICALLY —
 *  no attestation checkbox anywhere. The office can still correct any entry's lunch
 *  minutes on Timecards (worked-through-lunch → set 0), and the 0143 write guard keeps
 *  techs from LOWERING lunch on a closed shift (that would add paid hours).
 *
 *  Breaks (paid 10-min rests) don't affect pay and are no longer attested in-app. */
export const AUTO_LUNCH_MIN = 30;
export const AUTO_LUNCH_OVER_HOURS = 5;

/** Unpaid lunch minutes the app auto-deducts for a shift of `grossHours` (lunch-exclusive). */
export function autoLunchMinutes(grossHours: number): number {
  return grossHours > AUTO_LUNCH_OVER_HOURS ? AUTO_LUNCH_MIN : 0;
}
