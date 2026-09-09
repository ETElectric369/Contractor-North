/** THE lunch rule — one place (Erik 2026-09-08: "remove the auto deduct 30 min lunch and
 *  change it to a checkbox as an option but default to 0").
 *
 *  NOTHING is deducted unless a person says a lunch was taken. Every door that closes or
 *  enters a shift offers ONE checkbox worth LUNCH_MIN minutes, unchecked by default, and
 *  sends the minutes it stands for. The office can still type any number of minutes on
 *  Timecards (a 45- or 60-minute lunch), and the 0143 write guard still stops a tech from
 *  LOWERING a lunch already recorded on a closed shift — that would ADD paid hours.
 *
 *  (Supersedes the 2026-07-22 rule, which auto-deducted 30 minutes on any shift over five
 *  gross hours. That fired on shifts nobody took a lunch on, and the only way to undo it
 *  was an office correction after the fact. 0248 drops the matching DB floor.)
 *
 *  Breaks (paid 10-minute rests) don't affect pay and are not attested in-app. */
export const LUNCH_MIN = 30;

/** The one label, so no door invents its own wording for the same box. */
export const LUNCH_LABEL = "Took a 30-minute unpaid lunch";

/** Minutes the checkbox stands for. Unchecked = 0 — the default everywhere. */
export function lunchMinutesFor(took: boolean): number {
  return took ? LUNCH_MIN : 0;
}
