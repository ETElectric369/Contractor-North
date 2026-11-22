import type { InspectionListState } from "@/lib/inspections";

/**
 * WHAT THE PAGE HANDS ITS ROWS (cn-v1171: the Inspections page is one list). The page reads, buckets
 * and words everything on the server, in the reader's language and the company's timezone, so a row
 * and its ⋯ are handed finished strings and never a date to format. Which buttons a row gets is a
 * pure rule here, so it is proven without a page.
 */

/** One move a row's ⋯ can hold, in the order the sheet draws them. Open, Won · Start the Job and Pick a
 *  Day are links. */
export type MenuDoor = "open" | "wonStart" | "pickDay" | "move" | "happened" | "lost" | "del";

/** The row's one boxed button: Start Inspection, Create Estimate, or Open Inspection; and for a visit
 *  marked Won with no job picked (cn-v1175, R8), Won · Start the Job (cn-v1176: the Won sheet). */
export type PrimaryKind = "start" | "estimate" | "open" | "wonStart";

/** One inspection on the list. */
export type ListRow = {
  /** The visit's id: the row's key, and what its doors write to. */
  id: string;
  state: InspectionListState;
  /** Who it is for, in bold. */
  who: string;
  /** Where the name leads (the person's file), or null: the name opens the visit itself (cn-v1181, I1). */
  whoHref: string | null;
  /** What it is, as a phrase. May be empty. */
  what: string;
  /** The row's when: how long ago, or when it is. Null when the visit has no day to say. */
  edge: string | null;
  /** The plain slate word for the state, or null (Coming Up: its when says it). */
  stateWord: string | null;
  primary: { label: string; href: string };
  /** The inspection's own page (the ⋯'s Open Inspection). */
  visitHref: string;
  /** The Won sheet on the visit, for the ⋯'s Won · Start the Job when an offer took the boxed button. */
  wonHref?: string | null;
  /** The ⋯'s moves, in order. One: drawn as its own button. None: nothing. */
  doors: MenuDoor[];
  /** The visit's start and end as stored, for Move to Another Day… (it keeps the time and the length). */
  startsAt: string | null;
  endsAt: string | null;
  /** It Happened's toast, finished on the server by the estimates switch (happenedSaidKey). */
  happenedSaid: string;
  /** THE OFFER (cn-v1175, R5): a job made for this visit's customer record after it. When there is one it
   *  is the row's boxed button ("Done as <job>?", asked in place); the others are behind the ⋯. */
  offer?: { id: string; label: string } | null;
  offerOthers?: { id: string; label: string }[];
};

/** One inspection that ended without becoming work and hangs on nobody, in the Not Sold fold. Each one
 *  opens its visit and has Delete… (cn-v1181, I2b: the server deletes it only when nothing is on it). */
export type FoldRow = { id: string; who: string; what: string; day: string | null; ending: string; href: string };

/**
 * EVERY ROW OPENS ITS VISIT (cn-v1181, I1). The owner, 2026-11-22: "theres no way to access it [...]
 * shouldnt each item be clickable to open or delete?". The row's ⋯ holds Open Inspection FIRST, always,
 * unless the boxed button already says Open Inspection (then it is never said twice).
 */
export function openFirst(doors: readonly MenuDoor[], boxedSaysOpen: boolean): MenuDoor[] {
  const rest = doors.filter((d) => d !== "open");
  return boxedSaysOpen ? rest : ["open", ...rest];
}


/**
 * THE ROW'S ONE BOXED BUTTON (the meeting's notes: a boxed "START INSPECTION"). An inspection waiting
 * on a price says Create Estimate when estimates are on, else Open Inspection. Every other row says
 * Start Inspection, except the city's Final Inspection: nobody here starts the city's inspection, so
 * it says Open Inspection.
 */
export function primaryOf(state: InspectionListState, o: { decidable: boolean; estimatesOn: boolean; wonNoJob?: boolean }): PrimaryKind {
  // A WIN WITH NO JOB IS NOT AN ENDING (cn-v1175, R8): it stays on the list and asks for its job.
  if (o.wonNoJob) return "wonStart";
  if (state === "write_up") return o.estimatesOn ? "estimate" : "open";
  return o.decidable ? "start" : "open";
}

/**
 * THE ⋯ BY STATE, in the sheet's order. Open Inspection only where the boxed button is not already
 * the visit's own link. Pick a Day for a visit with no day (the Schedule's Waiting for a Day rail is
 * the one door that gives it a day and a time). Move only where there is a time of day to keep. It
 * Happened for a visit whose day went by.
 *
 * ONE WORD FOR AN ENDING, ONE BOX (cn-v1175, R8). The owner: "i thought we got rid of the Didn't Happen
 * terminology and now could we safely say that it could go in the Not Sold box to simplify everything".
 * A SALES visit (a kind with a win or a loss: an inspection, an estimate visit) ends one way, Not Sold,
 * in every state, whether or not it took place; it keeps the record, and one answered before its day
 * comes off the schedule (setAppointmentOutcome). A WORK visit (the city's final inspection) is never
 * "not sold": it keeps Dismiss while it is not done.
 *
 * A SALES VISIT THAT HANGS ON NOBODY GETS DISMISS… BESIDE NOT SOLD (cn-v1181, I2a). No lead, no customer,
 * no job, no estimate: a visit put in by hand that nothing else holds, which Not Sold alone would only
 * move to the fold. The owner, 2026-11-21: "could we safely say that it could go in the Not Sold box to
 * simplify everything"; and 2026-11-22, of such a visit: "theres no way to access it [...] shouldnt each
 * item be clickable to open or delete?". So Dismiss… is offered on it, while it is not done (the existing
 * door and its existing ask: deleted when nothing is on it, else cancelled and kept on file). A sales
 * visit that belongs to somebody keeps its ONE ending, Not Sold.
 */
export function rowDoors(
  state: InspectionListState,
  o: { primary: PrimaryKind; decidable: boolean; hasStart: boolean; nobody?: boolean },
): MenuDoor[] {
  const doors: MenuDoor[] = [];
  const notDone = state === "coming_up" || state === "needs_day" || state === "missed";
  if (o.primary === "estimate") doors.push("open");
  if (state === "needs_day") doors.push("pickDay");
  if ((state === "coming_up" || state === "missed") && o.hasStart) doors.push("move");
  if (state === "missed") doors.push("happened");
  if (o.decidable) {
    doors.push("lost");
    if (o.nobody && notDone) doors.push("del");
  } else if (notDone) doors.push("del");
  return doors;
}

/**
 * The plain slate word each state says beside what it is. Coming Up has none: its when says it. An
 * inspection done and not priced needs an estimate only where the company makes estimates; with the
 * switch off it is said Inspected (cn-v1171, skeptic #74: the screen says only what is true).
 */
export function stateWordKey(state: InspectionListState, estimatesOn: boolean): string | null {
  if (state === "needs_day") return "ip_needsADay";
  if (state === "write_up") return estimatesOn ? "ip_needsAnEstimate" : "ip_inspected";
  if (state === "missed") return "ip_dayPassed";
  return null;
}

/** What It Happened's toast says, by the same switch: an estimate is what comes next only when on. */
export function happenedSaidKey(estimatesOn: boolean): string {
  return estimatesOn ? "ip_movedToWriteUp" : "ip_markedHappened";
}
