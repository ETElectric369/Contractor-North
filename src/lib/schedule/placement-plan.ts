import type { Lang } from "@/lib/locale";
import { say, type Words } from "@/lib/lang-words";

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
export function dayTargetLabel(armedCount: number, lang: Lang = "en", words?: Words): string {
  if (armedCount <= 0) return "";
  return armedCount === 1 ? say(lang, words, "ag_putItHere", "Put it here") : say(lang, words, "ag_putNHere", `Put ${armedCount} here`, { n: armedCount });
}

/**
 * The instruction in the rail's footer.
 *
 * Deliberately an arrow to the calendar and not a button. There is no third tap: the day IS the
 * commit. Adding a confirm would put a modal between him and a decision he already made twice.
 */
export function armedInstruction(armedCount: number, lang: Lang = "en", words?: Words): string {
  return armedCount === 1
    ? say(lang, words, "ag_nowTapTheDay", "Now tap the day on the calendar →")
    : say(lang, words, "ag_nowTapTheDayAll", "Now tap the day on the calendar — they all go together →");
}

export type PlaceOutcome = {
  /** Leads that became booked inspections. */
  leadsBooked: number;
  /** Leads that didn't. */
  leadsFailed: number;
  /** Floater jobs that got a date. */
  jobsPlaced: number;
  /** Floaters that didn't. */
  jobsFailed: number;
  /** Placed jobs nobody gave a length, which went down as two hours (lib/schedule/job-block). */
  jobsDefaulted?: number;
  /** A human day, already formatted by the caller — never a raw YYYY-MM-DD in a sentence. */
  dayLabel: string;
};

/** The words for jobs that landed with the two-hour default: said once, where the deed is announced. */
function defaultedWords(n: number | undefined, lang: Lang, words?: Words): string {
  if (!n || n <= 0) return "";
  return n === 1
    ? ` ${say(lang, words, "ag_defaultedOne", "It had no length, so it's down as 2 hours. Tap it on the calendar to change it.")}`
    : ` ${say(lang, words, "ag_defaultedMany", `${n} had no length, so they're down as 2 hours. Tap one on the calendar to change it.`, { n })}`;
}

/**
 * ANNOUNCE THE DEED, AND NAME WHAT DIDN'T LAND.
 *
 * NOTHING SILENT. A batch that reports "Done" while one of four quietly failed is how somebody
 * stops believing the toast — and then stops believing the schedule. Partial success says so, in
 * the same sentence, with the number.
 */
export function placeMessage(o: PlaceOutcome, lang: Lang = "en", words?: Words): { text: string; tone: "success" | "info" | "error" } {
  const placed = o.leadsBooked + o.jobsPlaced;
  const failed = o.leadsFailed + o.jobsFailed;
  const day = o.dayLabel;
  if (placed === 0 && failed > 0) {
    return {
      text:
        failed === 1
          ? say(lang, words, "ag_placeNoneOne", `That one didn't go on ${day}.`, { day })
          : say(lang, words, "ag_placeNoneMany", `None of those ${failed} went on ${day}.`, { n: failed, day }),
      tone: "error",
    };
  }
  const defaulted = defaultedWords(o.jobsDefaulted, lang, words);
  if (failed > 0) {
    return {
      text: `${say(lang, words, "ag_placeSome", `${placed} on ${day}. ${failed} didn't — open them and try again.`, { n: placed, day, failed })}${defaulted}`,
      tone: "info",
    };
  }
  return {
    text: `${placed === 1 ? say(lang, words, "ag_placeOne", `On ${day}.`, { day }) : say(lang, words, "ag_placeMany", `${placed} on ${day}.`, { n: placed, day })}${defaulted}`,
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
export function dayLabelFrom(dateISO: string, todayISO?: string, lang: Lang = "en", words?: Words): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO ?? ""));
  if (!m) return String(dateISO ?? "");
  if (todayISO && dateISO === todayISO) return say(lang, words, "ag_todayLower", "today");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Spanish reads es-US; English keeps the browser's own locale, exactly as before the agenda wave.
  return d.toLocaleDateString(lang === "es" ? "es-US" : undefined, { weekday: "long", month: "short", day: "numeric" });
}
