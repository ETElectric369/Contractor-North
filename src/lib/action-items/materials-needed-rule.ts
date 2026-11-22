/**
 * WHICH JOBS MAY ASK FOR THEIR MATERIALS: ONE RULE, TWO DOORS.
 *
 * Needs You's "materials to buy" row and the morning notice of the same thing both have to answer
 * one question first: is this a job the crew can still stand on? A cancelled, finished or billed job
 * has nothing left to buy for. A held job waits with its own day and its own reason, and must not ask
 * a second time from another row.
 *
 * The answer lived as a local line inside the Needs You feeder. It is here, in a file of its own,
 * because the morning notice is a SECOND door onto the same thing, and two doors that each keep
 * their own list of statuses drift the first time one of them is changed (the 2026-09-30 audit found
 * 21 such forks; the cure each time was one rule in one function). The feeder in query.ts and the
 * morning read both import this, and a source pin holds each of them to it.
 *
 * Pure. No catalog, no client.
 */
export function materialsJobStatusOk(status: string | null | undefined): boolean {
  return status !== "cancelled" && status !== "complete" && status !== "invoiced" && status !== "on_hold";
}
