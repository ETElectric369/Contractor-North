/**
 * "WHAT DID YOU DO TODAY?" AT CLOCK-OUT, FOR THE CREW WHO ARE NOT ASKED FOR THE LEAD'S REPORT
 * (cn-v1190). The owner: "and for techs who are not lead lets have one question with their clocout -
 * what did you do today".
 *
 * Two pure rules, here and not in the "use server" file (which may export only async functions) nor
 * in the sheet (a "use client" module a server page could not call):
 *
 *   · WHO IS ASKED: a tech (not an office seat) who is NOT asked for the lead's daily report. It is
 *     the other branch of lib/daily-report-rule's asksForDailyReport, so a crew lead in a company whose
 *     Daily Reports switch is off is asked this one question too; a lead with reports on keeps his
 *     two-box report; the office keeps Clock Out with Details.
 *   · HOW THE ANSWER JOINS THE SHIFT'S NOTE: added on a line of its own after what is there, never
 *     over it, so the clock's own crumbs (the take-back line, the auto clock-out line, the late-stop
 *     line) stay whole; an empty answer adds nothing; the same answer saved twice is not doubled
 *     (matched as whole lines). The shape of close-math's withStopCrumb and withAutoConfirmedCrumb.
 *
 * Never a word catalog here (a lib never imports one): the sheet says the words.
 */
import { withoutHeldCrumb } from "./held-crumb";

/**
 * NEVER THE SAME QUESTION TWICE (cn-v1190, skeptic #91 S4). Clock Out with Details already holds a box
 * asking "What did you do today?", and My Day's Now card sends the open shift's note: when the close
 * carried words of the person's own, he has already answered, and the sheet does not open.
 *
 * A line the clock wrote is not his answer, so a note of nothing but machine lines still asks: the
 * held-job crumb (withoutHeldCrumb), Switch Job's "[switched to … at …]" (switch-breadcrumb.ts), the
 * auto clock-out's confirmation (close-math AUTO_CONFIRMED_CRUMB) and the stop crumb (close-math
 * stopCrumb, both shapes). Each shape is matched as a WHOLE line, so a person's own words that merely
 * start with a bracket are his words. The test ties every shape to its writer.
 */
const MACHINE_LINE =
  /^\[(?:switched to [^\]\n]* at \d{4}-\d{2}-\d{2}T[0-9:.]+Z|hours confirmed after the auto clock-out|clocked out by [^\n]*; it had been running since [^\n]*|stop time picked by [^\n]*, after the shift)\]$/;

/** Did the close carry no words of the person's own? `notesSent` is the note sent WITH that close. */
export function closeSaidNothing(notesSent: string | null | undefined): boolean {
  return withoutHeldCrumb(notesSent)
    .split("\n")
    .every((line) => {
      const l = line.trim();
      return l === "" || MACHINE_LINE.test(l);
    });
}

/** Is this person asked "What did you do today?" after his own tap clocks him out? (WHO; the doors
 *  also ask closeSaidNothing about the note the close sent.) */
export function asksWhatToday(who: { staff: boolean; asksReport: boolean }): boolean {
  return who.staff === false && who.asksReport !== true;
}

/** The shift's note with the answer added once, on its own line; what was there is kept whole. */
export function withWhatToday(notes: string | null | undefined, answer: string | null | undefined): string {
  const base = (notes ?? "").trim();
  const said = (answer ?? "").trim();
  if (!said) return base;
  // Already there as whole lines (a second Save, a retry that landed the first time): not doubled. A
  // word that merely appears inside a longer line is not the same answer.
  if (`\n${base}\n`.includes(`\n${said}\n`)) return base;
  return base ? `${base}\n${said}` : said;
}
