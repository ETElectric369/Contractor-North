/**
 * THE CLOCK'S OWN TAKE-BACK LINE (timeclock/actions.ts: noteHeldBefore / putHeldJobBack).
 *
 * A clock-in that woke a held job writes one sealed line into its punch's notes so taking the punch
 * back can put the hold back. It is the clock's, not the tech's: it lives here (not in the "use
 * server" file, which may export only async functions) so every place that SHOWS or COUNTS a punch's
 * notes can leave it out: the Clock panel's box, the timecard modals, the end-of-day reminder's "did
 * he write anything", and the close itself, which strips it so a finished punch never carries it.
 */
export const HELD_CRUMB = /\[This punch took the job off hold\. Before: (\{[^\n]*\}) #([0-9a-f]{16})\]/;

/** The notes as a person wrote them: the clock's own line is not a note (it must not make a punch "touched"). */
export const withoutHeldCrumb = (notes: string | null | undefined): string => (notes ?? "").replace(new RegExp(HELD_CRUMB.source, "g"), "").trim();
