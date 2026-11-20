import type { InspectionListState } from "@/lib/inspections";

/**
 * WHAT THE PAGE HANDS ITS ROWS (cn-v1171: the Inspections page is one list). The page reads, buckets
 * and words everything on the server, in the reader's language and the company's timezone, so a row
 * and its ⋯ are handed finished strings and never a date to format. Which buttons a row gets is a
 * pure rule here, so it is proven without a page.
 */

/** One move a row's ⋯ can hold, in the order the sheet draws them. Open and Pick a Day are links. */
export type MenuDoor = "open" | "pickDay" | "move" | "happened" | "lost" | "del";

/** The row's one boxed button: Start Inspection, Create Estimate, or Open Inspection. */
export type PrimaryKind = "start" | "estimate" | "open";

/** One inspection on the list. */
export type ListRow = {
  /** The visit's id: the row's key, and what its doors write to. */
  id: string;
  state: InspectionListState;
  /** Who it is for, in bold. */
  who: string;
  /** Where the name leads (the person's file), or null: the name is plain words. */
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
  /** The ⋯'s moves, in order. One: drawn as its own button. None: nothing. */
  doors: MenuDoor[];
  /** The visit's start and end as stored, for Move to Another Day… (it keeps the time and the length). */
  startsAt: string | null;
  endsAt: string | null;
  /** It Happened's toast, finished on the server by the estimates switch (happenedSaidKey). */
  happenedSaid: string;
};

/** One filed inspection that hangs on nobody, in the fold under the list. */
export type FoldRow = { id: string; who: string; what: string; day: string | null; ending: string; href: string };

/**
 * THE ROW'S ONE BOXED BUTTON (the meeting's notes: a boxed "START INSPECTION"). An inspection waiting
 * on a price says Create Estimate when estimates are on, else Open Inspection. Every other row says
 * Start Inspection, except the city's Final Inspection: nobody here starts the city's inspection, so
 * it says Open Inspection.
 */
export function primaryOf(state: InspectionListState, o: { decidable: boolean; estimatesOn: boolean }): PrimaryKind {
  if (state === "write_up") return o.estimatesOn ? "estimate" : "open";
  return o.decidable ? "start" : "open";
}

/**
 * THE ⋯ BY STATE, in the sheet's order. Open Inspection only where the boxed button is not already
 * the visit's own link. Pick a Day for a visit with no day (the Schedule's Waiting for a Day rail is
 * the one door that gives it a day and a time). Move only where there is a time of day to keep. It
 * Happened for a visit whose day went by. Not Sold where the visit happened or its day went by, and
 * only for a kind that has a win or a loss (never the city's). Dismiss for anything not yet done.
 */
export function rowDoors(state: InspectionListState, o: { primary: PrimaryKind; decidable: boolean; hasStart: boolean }): MenuDoor[] {
  const doors: MenuDoor[] = [];
  if (o.primary === "estimate") doors.push("open");
  if (state === "needs_day") doors.push("pickDay");
  if ((state === "coming_up" || state === "missed") && o.hasStart) doors.push("move");
  if (state === "missed") doors.push("happened");
  if ((state === "write_up" || state === "missed") && o.decidable) doors.push("lost");
  if (state === "coming_up" || state === "needs_day" || state === "missed") doors.push("del");
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
