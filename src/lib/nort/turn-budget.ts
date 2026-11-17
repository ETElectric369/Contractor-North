import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";

/**
 * HOW MUCH NORT MAY CHANGE IN ONE TURN. The chat route's loop asks this file before every registry
 * write, and nothing else decides it. Pure: no clock of its own, no database, no catalog.
 *
 * WHY THERE IS A BUDGET AT ALL (cn-v180). Nort reads text nobody on the crew wrote: a lead's
 * message from the public form, a note copied from an email, a paper somebody dropped. The fence
 * around a tool's answer and the prompt's rule say that text is data. Sixteen of his seventy-five
 * writes stop the turn at a confirm card the model cannot answer for itself (among them recording
 * money, finishing a job, changing or ending an appointment, the bulk task moves, a standing
 * order), and no write of his sends anything to a customer. The budget is the belt under those,
 * for the other fifty-nine: if a line Nort only READ were ever taken for an instruction, this is
 * the most it could change before a person speaks again. (The counts are held by this file's test.)
 *
 * WHY BOOKING A DAY HAS TWENTY AND EVERYTHING ELSE KEEPS THREE (2026-11-16). The budget was three
 * for every write, a number picked when Nort had six kinds. The owner, driving, booked the next
 * day by voice: three jobs, one of them off hold, a crew of three on each, and one job that did not
 * exist yet. Fourteen changes, and the three stopped him four times to say "continue"; his report
 * called it "a hands-free blocker while driving". So the writes a day is booked with
 * (DAY_BOOKING_WRITES) draw on twenty: four jobs, each given a status, a day and three people.
 * Every one of those lands on the Schedule or a job's own page, where a person can see it and put
 * it back by hand. The rest keep the three they had, because the review of this change named what
 * twenty of them could do unseen: twenty facts written into every crew member's prompt (a memory
 * has no screen), twenty customers' phone numbers rewritten, twenty jobs cancelled or their crews
 * cleared, an estimate emptied line by line. Nothing that was three is more than three now.
 *
 * WHY THERE IS A CLOCK. The platform cuts the route at its maxDuration (120 seconds), mid-stream,
 * with nothing said and nothing saved to the transcript. A turn of three changes never came near
 * that; a turn of twenty can. So the first three writes of a turn are never refused for its age
 * (no turn that worked yesterday is refused today), and a write past the third is made only while
 * the turn is younger than WRAP_UP_AFTER_MS: after that the model is told the time is up and says
 * what is done and what is left. And because that only stops writes, the loop itself stops asking
 * for another round once the turn is older than STOP_ROUNDS_AFTER_MS, and says so in the person's
 * language. A round already running when a line is crossed is not cut short by either: these bound
 * what STARTS late, which is what was missing, and nobody has timed a twenty-change turn yet.
 */

/** The most registry writes one turn may make, all kinds together. */
export const MAX_WRITES_PER_TURN = 20;

/** The most writes one turn may make that are NOT booking a day: the whole budget until
 *  2026-11-16. Also how many writes a turn may always make, however long it has run. */
export const MAX_OTHER_WRITES_PER_TURN = 3;

/** Past this many milliseconds a turn makes no write beyond its first three. */
export const WRAP_UP_AFTER_MS = 70_000;

/** Past this many milliseconds the loop does not start another round. */
export const STOP_ROUNDS_AFTER_MS = 95_000;

/**
 * What a day is booked with: making a job, putting it in flight, giving it a day and its people,
 * naming its customer, and a reminder with its day and its person. Each lands where a person sees
 * it (the Schedule, the job, the reminders list). A name here is necessary and not enough: see
 * isDayBookingWrite for the two that also depend on what they are asked to do.
 */
export const DAY_BOOKING_WRITES: ReadonlySet<string> = new Set([
  "job.create",
  "job.setStatus",
  "job.scheduleDay",
  "job.move",
  "job.assign",
  "appointment.create",
  "appointment.linkCustomer",
  "customer.create",
  "task.create",
  "task.setDue",
  "task.assign",
]);

/**
 * Is this write part of booking a day? Read from the model's own input, before anything runs, and
 * strict on purpose: what it cannot read as booking counts against the three.
 *  - job.setStatus books only when it keeps the job in flight (to be scheduled, scheduled, in
 *    progress, on hold). Cancelling is not booking; finishing has its own door and its own card.
 *  - job.assign books only when it ADDS a person. An empty assignee clears the whole crew.
 */
export function isDayBookingWrite(action: string, input: unknown): boolean {
  if (!DAY_BOOKING_WRITES.has(action)) return false;
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (action === "job.setStatus") return typeof i.status === "string" && (ACTIVE_JOB_STATUSES as readonly string[]).includes(i.status);
  if (action === "job.assign") return typeof i.assignee === "string" && i.assignee.trim() !== "";
  return true;
}

export type TurnBudget = "ok" | "changes_spent" | "time_spent";

/**
 * May this turn make one more write? `writes` is how many it has made the attempt of, all kinds
 * together, and `others` how many of those were not booking a day. A write a handler refuses or
 * fails still counts (the count goes up before it runs); one this budget turns away, or one held
 * behind a pending confirm card, never ran and does not. `elapsedMs` is the request's age.
 */
export function turnBudget(p: { writes: number; others: number; booking: boolean; elapsedMs: number }): TurnBudget {
  if (p.writes >= MAX_WRITES_PER_TURN) return "changes_spent";
  if (!p.booking && p.others >= MAX_OTHER_WRITES_PER_TURN) return "changes_spent";
  if (p.writes >= MAX_OTHER_WRITES_PER_TURN && p.elapsedMs >= WRAP_UP_AFTER_MS) return "time_spent";
  return "ok";
}

/** Should the loop stop here, before it asks for another round? */
export function roundsOutOfTime(elapsedMs: number): boolean {
  return elapsedMs >= STOP_ROUNDS_AFTER_MS;
}

/** What the model is handed in place of the write's result. It reads these; the person hears its
 *  own sentence, so both name the one way on: say "continue". */
export const CHANGES_SPENT_SAID = "That's enough changes for one go — ask me to continue if you want more.";
export const TIME_SPENT_SAID =
  'This turn is out of time, so that change was not made. Make no more changes now: say plainly what is done and what is left, and that saying "continue" picks it up.';

/** The tool result for a write the budget refused. */
export function budgetRefusal(spent: Exclude<TurnBudget, "ok">): string {
  return JSON.stringify({ ok: false, error: spent === "time_spent" ? TIME_SPENT_SAID : CHANGES_SPENT_SAID });
}

/** What the PERSON hears when the loop stops for time: the route says it itself, so it is said in
 *  their language. (Two sentences, not a catalog: a lib never imports one, and nothing else says these.) */
export function outOfTimeSaid(lang: "en" | "es"): string {
  return lang === "es"
    ? 'Se me acabó el tiempo en esta. Di "continúa" y sigo donde me quedé.'
    : 'I ran out of time on that one. Say "continue" and I\'ll pick up where I left off.';
}
