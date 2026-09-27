import { NO_JOB_READ_CAP, type NoJobHours } from "@/lib/no-job-hours";
import { formatDateShort } from "@/lib/utils";
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "./types";

/** The rollup's id. Synthetic: open-only, never dispatched (types.ts AFFORDANCES.time_stray). */
export const NO_JOB_HOURS_ITEM_ID = "stray-no-job";

/** Where the rollup opens: the Timecards Fix These box, where each shift has its doors. */
export const NO_JOB_HOURS_HREF = "/timecards#no-job";

/**
 * HOURS ON NO JOB, AS ONE LINE ON MY DAY (the duplicate punches, 2026-09-26).
 *
 * The old line was one row per shift, and only for three days: "Brian's Sep 11 entry has no job"
 * was gone by Sep 14, and on Sep 19 the office typed the same day again on the job. Now every
 * shift still on no job rides inside ONE line, however old, so the badge moves by one (the BADGE
 * INVARIANT, types.ts: a rollup, never the length of an unbounded set) and nothing ages out. It
 * leaves by itself when the last shift is put on a job or filed as company time.
 *
 * Null when there is nothing on no job, so it never sits on My Day saying "0". A failed read is
 * its own line: "couldn't check" is not "nothing waiting".
 */
export function noJobHoursActionItem(summary: NoJobHours | null | undefined, opts: { tz?: string; failed?: boolean } = {}): ActionItem | null {
  if (opts.failed) {
    return {
      id: NO_JOB_HOURS_ITEM_ID,
      kind: "time_stray",
      stream: KIND_STREAM.time_stray,
      title: "Hours On No Job · Couldn't Check",
      subtitle: "Couldn't read the shifts that are on no job just now. Open Timecards to see them.",
      who: null,
      when: null,
      urgency: 1,
      done: false,
      href: NO_JOB_HOURS_HREF,
      affordances: AFFORDANCES.time_stray,
    };
  }
  const shifts = summary?.shifts ?? [];
  if (!shifts.length && summary?.capped) {
    // THE CAP WAS FULL AND NOTHING IN IT COULD BE LISTED (every one billed, empty or today's): an
    // older shift on no job may still be waiting past it. Not "nothing waiting", so not null.
    return {
      id: NO_JOB_HOURS_ITEM_ID,
      kind: "time_stray",
      stream: KIND_STREAM.time_stray,
      title: "Hours On No Job · Couldn't List Them All",
      subtitle: `The newest ${NO_JOB_READ_CAP} shifts on no job are all billed, empty or today's, so older ones weren't checked.`,
      who: null,
      when: null,
      urgency: 1,
      done: false,
      href: NO_JOB_HOURS_HREF,
      affordances: AFFORDANCES.time_stray,
    };
  }
  if (!shifts.length) return null;
  const days = shifts.map((s) => s.day).sort();
  const first = formatDateShort(days[0]);
  const last = formatDateShort(days[days.length - 1]);
  const span = first === last ? `on ${first}` : `from ${first} to ${last}`;
  const hours = Math.round((summary?.hours ?? 0) * 10) / 10;
  const people = Array.from(new Set(shifts.map((s) => s.name.split(/\s+/)[0] || s.name)));
  return {
    id: NO_JOB_HOURS_ITEM_ID,
    kind: "time_stray",
    stream: KIND_STREAM.time_stray,
    title: `Hours On No Job · ${shifts.length}${summary?.capped ? "+" : ""}`,
    subtitle: `${hours} h ${span}${people.length <= 3 ? ` (${people.join(", ")})` : ""}, on no job and no invoice. Put each on its job, or file it as company time.`,
    who: null,
    // Undated on purpose, like the supplier bills: the oldest shift is weeks old, and a red
    // "overdue" would be a deadline nobody set. The rows on Timecards say their own days.
    when: null,
    urgency: 1,
    done: false,
    href: NO_JOB_HOURS_HREF,
    affordances: AFFORDANCES.time_stray,
  };
}
