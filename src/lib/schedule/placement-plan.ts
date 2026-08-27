/**
 * TAP THE WORK, THEN TAP THE DAY — the second tap, finally on the calendar.
 *
 * Erik, looking at the armed rail: "i cant see the whole calendar on the bottom to pick the day,
 * wondering about what you said before about being able to click the day on the calendar to pick it
 * once the jobs are checked."
 *
 * Both halves of that are right, and the second one is the fix for the first.
 *
 * The rail's footer had an <input type="date">. Its native popup opens downward from a control
 * pinned to the bottom of the rail, so it ran off the bottom of the window — he could see about
 * four rows of a month. But the deeper problem is that it was a SECOND, BLIND calendar: a little
 * grey month with no towns on it, no existing work on it, and no idea that Thursday already has a
 * Tahoe City job on it — asking him to choose a day with all the information hidden, while a
 * calendar carrying exactly that information sat four inches to the right.
 *
 * So the date field is gone and the real calendar is the picker. Pick the work, tap the day, done.
 *
 * ── THE SAME TAP NOW MEANS TWO THINGS, AND THAT IS THE RISK ────────────────────────────────
 *
 * Tapping a day header has always drilled into that day. Armed, it must place instead. A control
 * that quietly changes meaning is the kind of trap that makes somebody stop trusting a screen —
 * so the mode has to be VISIBLE, not remembered: armed, every day wears a target ring and says
 * what tapping it will do. This module holds that decision so it is stated once, in words, and
 * tested, rather than living as a truthy check in two components that can drift apart.
 */

/** What a tap on a day means right now. */
export type DayTap = "place" | "open";

export function dayTapMeans(armedCount: number): DayTap {
  return armedCount > 0 ? "place" : "open";
}

/**
 * What the day says it will do when armed.
 *
 * Named with the count because "Put 3 here" answers a question "Place" doesn't: how many am I
 * about to commit, having scrolled away from the rail where I ticked them.
 */
export function dayTargetLabel(armedCount: number): string {
  if (armedCount <= 0) return "";
  return armedCount === 1 ? "Put it here" : `Put ${armedCount} here`;
}

/**
 * The instruction in the rail's footer.
 *
 * Deliberately an arrow to the calendar and not a button. There is no third tap: the day IS the
 * commit. Adding a confirm would put a modal between him and a decision he already made twice.
 */
export function armedInstruction(armedCount: number): string {
  return armedCount === 1
    ? "Now tap the day on the calendar →"
    : "Now tap the day on the calendar — they all go together →";
}

export type PlaceOutcome = {
  /** Leads that became booked walk-throughs. */
  leadsBooked: number;
  /** Leads that didn't. */
  leadsFailed: number;
  /** Floater jobs that got a date. */
  jobsPlaced: number;
  /** Floaters that didn't. */
  jobsFailed: number;
  /** A human day, already formatted by the caller — never a raw YYYY-MM-DD in a sentence. */
  dayLabel: string;
};

/**
 * ANNOUNCE THE DEED, AND NAME WHAT DIDN'T LAND.
 *
 * NOTHING SILENT. A batch that reports "Done" while one of four quietly failed is how somebody
 * stops believing the toast — and then stops believing the schedule. Partial success says so, in
 * the same sentence, with the number.
 */
export function placeMessage(o: PlaceOutcome): { text: string; tone: "success" | "info" | "error" } {
  const placed = o.leadsBooked + o.jobsPlaced;
  const failed = o.leadsFailed + o.jobsFailed;
  if (placed === 0 && failed > 0) {
    return {
      text: failed === 1 ? `That one didn't go on ${o.dayLabel}.` : `None of those ${failed} went on ${o.dayLabel}.`,
      tone: "error",
    };
  }
  if (failed > 0) {
    return { text: `${placed} on ${o.dayLabel}. ${failed} didn't — open them and try again.`, tone: "info" };
  }
  return {
    text: placed === 1 ? `On ${o.dayLabel}.` : `${placed} on ${o.dayLabel}.`,
    tone: "success",
  };
}

/**
 * A day a person would say out loud, from a YYYY-MM-DD.
 *
 * Parsed by PARTS, never `new Date("2026-08-27")` — that is UTC midnight, which reads as the 26th
 * everywhere west of Greenwich. That exact bug shipped once already in the overdue badge and put a
 * red flag on every lead due today; it is not making it into the sentence that confirms a booking.
 */
export function dayLabelFrom(dateISO: string, todayISO?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO ?? ""));
  if (!m) return String(dateISO ?? "");
  if (todayISO && dateISO === todayISO) return "today";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
