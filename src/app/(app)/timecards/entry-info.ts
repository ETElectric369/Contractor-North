import type { TimeGridInfo } from "@/components/time-grid";
import { withoutHeldCrumb } from "@/lib/held-crumb";

/**
 * WHAT THE BOX ON THE GRID SAYS ABOUT A SHIFT (cn-v1151; Erik, reconciling timecards: "it would be really
 * helpful to have more information on the timecard entry box on the calendar screen, perhaps even just the
 * total hours would be helpful").
 *
 * A pill on the week grid of /timecards was the person, the job and the span, and checking an entry meant
 * opening it. The grid draws a block's own lines now (TimeGridInfo: the time, the hours, the state, the
 * note, as tall as the block has room for), so the box says what he checks a row for without the tap: the
 * span, the hours with the lunch that came off them, where the shift stands, and what the person wrote.
 *
 * THE SAME FACTS AS THE ROW UNDER THE GRID, IN THE SAME WORDS. The list rows (timecard-stack's ShiftRow)
 * badge "No Job" and "Offline", say "on the clock" where the number would be, and read the notes without
 * the clock's own take-back line (lib/held-crumb). This builds the box from the very fields those rows
 * read, so the grid and the list cannot disagree about a shift (the "looks like duplicates" complaint the
 * stack exists to answer, cn-v956).
 *
 * PURE, AND ITS OWN MODULE. toStackEntry is a closure inside the server page, out of a test's reach, and
 * timecard-stack is "use client" (a server page gets its exports as client references, not functions). So
 * the rule lives here, like delete-words: the page calls it, a test runs it.
 */

/** The box's words — English literals, like the row badges beside them: the Timecards office page reads no
 *  catalog of its own yet (its header's nv_ words are the one t() on the page), and the tc_ catalog's
 *  "on the clock" / "paid" / "No job" are the TECH's clock words, lowercase, not these badges. Title Case,
 *  as a clickable's (the small word "the" lowercase mid-title: cn-v1148). */
export const BOX_WORDS = {
  onTheClock: "On the Clock",
  paid: "Paid",
  noJob: "No Job",
  offlinePunch: "Offline Punch",
} as const;

/** The row's facts the box is built from — the same fields toStackEntry puts on the StackEntry. */
export type EntryFacts = {
  /** The span the row shows ("1:00 PM–3:00 PM"; "7:00 AM–now" while open; the out-day when it crossed midnight). */
  sub: string;
  /** Still on the clock. */
  open: boolean;
  /** Hours by the app's one rule (lib/utils hoursBetween, lunch deducted); 0 while open. */
  hours: number;
  lunchMin: number;
  /** When payroll locked this shift (time_entries.paid_at), or nothing. */
  paidAt: string | null | undefined;
  /** A closed shift on no job and no code: hours nobody bills. */
  noJob: boolean;
  /** Where the punch's time came from, when it was not the server clock (0168). */
  source: "manual" | "offline" | null;
  notes: string | null | undefined;
};

/** "2.00 h", "8.50 h · 30 min lunch": the number he reconciles against, with the lunch that came off it.
 *  null while the clock runs — an open shift is worth nothing until it closes (the stack's own law,
 *  StackEntry.open), so the box says where the number would be, never a number. */
export function hoursWords(f: Pick<EntryFacts, "open" | "hours" | "lunchMin">): string | null {
  if (f.open) return null;
  return `${f.hours.toFixed(2)} h${f.lunchMin > 0 ? ` · ${f.lunchMin} min lunch` : ""}`;
}

/** Where the shift stands, one line: On the Clock (warn) while it runs; else Paid (good) once payroll
 *  locked it; else No Job (warn) when nothing bills it; else nothing. An offline punch says so as well —
 *  "· Offline Punch" after the state, or alone in warn — the disclosure the row makes (0168: where a
 *  punch's time came from is said on the row) made on the box too. */
export function stateWords(f: Pick<EntryFacts, "open" | "paidAt" | "noJob" | "source">): TimeGridInfo["state"] {
  const base: TimeGridInfo["state"] = f.open
    ? { text: BOX_WORDS.onTheClock, tone: "warn" }
    : f.paidAt
      ? { text: BOX_WORDS.paid, tone: "good" }
      : f.noJob
        ? { text: BOX_WORDS.noJob, tone: "warn" }
        : null;
  if (f.source !== "offline") return base;
  return base ? { text: `${base.text} · ${BOX_WORDS.offlinePunch}`, tone: base.tone } : { text: BOX_WORDS.offlinePunch, tone: "warn" };
}

/** The box: the span where the sub was drawn (with `info` the grid draws no sub, so the span rides in as
 *  `time`), the hours, the state, and the person's own words less the clock's take-back line — or no note
 *  at all when that leaves nothing. */
export function entryInfo(f: EntryFacts): TimeGridInfo {
  return {
    time: f.sub,
    hours: hoursWords(f),
    state: stateWords(f),
    note: withoutHeldCrumb(f.notes) || null,
  };
}
