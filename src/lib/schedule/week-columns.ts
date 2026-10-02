import { isWeekendDay } from "@/lib/tz";

/**
 * A WEEKEND DAY EARNS ITS SPACE, OR IT ISN'T DRAWN.
 *
 * Erik, 2026-10-02: "optional weekend displayed unless something is booked, saves a lot of space."
 *
 * On his 16 Pro the week's seventh column came out 13 pixels wide — a column you cannot read and
 * cannot tap, spent on a Sunday that almost never has work on it. So Saturday and Sunday each ask
 * for their own column INDEPENDENTLY: the one with the emergency call on it is drawn, the empty one
 * beside it is not, and the five working days take the room back.
 *
 * NOT A SWITCH (KISS). There is nothing to turn on and nothing to remember, because the rule reads
 * the data: put work on a Saturday — from the month, from the day, from the rail — and that Saturday
 * is there the next time the week is drawn. Nothing is ever hidden with something on it.
 *
 * THREE THINGS OVERRIDE "EMPTY", and each one is a dead end without it:
 *   - TODAY. The day you are standing in is always on the screen, even a Sunday you are not working.
 *   - ARMED. While work is picked in the placement rail (schedule/place-rail), every day is a drop
 *     target — and you cannot drop a job onto a column that isn't there.
 *   - WORK ON IT. Whatever the view would have drawn on that day; the caller answers that, because
 *     only the view knows what it draws (`hasWork`).
 *
 * WEEKEND, WHEREVER THE WEEK START PUTS IT. This asks the calendar, never the position: a
 * Monday-start week leaves Sat+Sun at the end, a Sunday-start week opens on one of them.
 *
 * `hidden` comes back BESIDE `shown` from the one call, so the header that names the folded-away days
 * can never disagree with the columns about which they are.
 */
export function weekViewDays(
  days: readonly string[],
  opts: {
    /** Does this day have anything the view would draw on it? Only the view knows. */
    hasWork: (ymd: string) => boolean;
    /** The company's today (org tz) — always drawn. */
    todayStr: string;
    /** Work is picked in the placement rail: every day must be tappable. */
    armed?: boolean;
  },
): { shown: string[]; hidden: string[] } {
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const ymd of days) {
    const drawn =
      !isWeekendDay(ymd) || opts.armed === true || ymd === opts.todayStr || opts.hasWork(ymd);
    (drawn ? shown : hidden).push(ymd);
  }
  /* A WEEK IS NEVER NOTHING. If the data ever makes every day fold away (it cannot today — the five
     working days are unconditional — but a later rule could), the week keeps its days rather than
     drawing an empty card with an hour gutter and no columns. */
  return shown.length ? { shown, hidden } : { shown: [...days], hidden: [] };
}

/** A folded-away day, short enough to sit in a week's header and still name itself: "Sat 4". Noon UTC
 *  for the same reason everything else here uses it — a raw parse reads a day early west of Greenwich.
 *  ONE spelling, so the schedule's header and My Day's cannot drift apart.
 *  COMPOSED, not left to a skeleton: `{ weekday: "short", day: "numeric" }` is "18 Sat" in en-US CLDR,
 *  which is how the grid's own column headers read and is not how anybody says it in a sentence. */
export function shortDayWords(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ""))) return "";
  const d = new Date(`${ymd}T12:00:00Z`);
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${Number(ymd.slice(8, 10))}`;
}
