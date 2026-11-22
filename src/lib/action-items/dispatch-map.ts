import type { ActionKind, Affordance } from "./types";

/**
 * WHICH REGISTRY ACTION A ROW'S VERB RUNS (the Needs You switchboard's table, pure so it is tested
 * whole: dispatch.test.ts walks every (kind, verb) the row table can send and checks each one lands
 * on a real registry action). dispatch.ts is the thin server shim that runs it through
 * executeAction (lookup, auth, validation, the audit log).
 *
 * The row's id is what the list hands over. Derived rows carry prefixed ids, and the prefix is
 * stripped HERE, to the record the verb writes, so a verb never writes zero rows and reports success
 * (the silent-write law): unbilled-<visit> / jdone-<job> (visit_unbilled), qdraft-<estimate>
 * (quote_draft), onhold-<job> (job_on_hold), nocosts-<job> (job_unbilled_work), materials-<job>
 * (materials_needed), receipt-<document> (receipt_unbilled), flagtask-<task> (job_task_flagged). A won
 * estimate's day goes on its JOB, which the row names as `target`.
 *
 * ONE task arm, no convert branch: a Reminder never reaches Needs You (0358), and of a job's tasks only
 * the ones the office flagged do (cn-v1179), whose Check Off is task.complete, the registry's door over
 * tasks/actions toggleTask (the same check-off the job's Tasks tab makes). inquiry.convert stays Nort's.
 * Nor inquiry.delete: a lead's ending is inquiry.markLost (Not Sold, kept on file), never a deletion.
 */
export type DispatchPayload = { date?: string; assignee?: string; reason?: string };

export type Mapped = { name: string; input: Record<string, unknown> };

/**
 * A REFUSAL A ROW CANNOT ANSWER, NAMED (cn-v1179, skeptic #82, S5). A flagged task's Check Off runs
 * task.complete with no cascade; on a task that still has open steps toggleTask refuses with a QUESTION
 * (complete them too?) that a Needs You row has no way to ask. The row never sends cascade (that would
 * close steps nobody looked at): it says one sentence naming its one way through, its own Open the Job.
 * The sentence is the catalog's (ny_taskHasOpenSteps), said by the list in the reader's language; the
 * English here is what a caller that reads no `why` shows.
 */
export type DispatchWhy = "openSteps";
export const DISPATCH_WHY_KEY: Record<DispatchWhy, string> = { openSteps: "ny_taskHasOpenSteps" };
export const OPEN_STEPS_EN = "This task still has open steps. Open the Job to check them off.";
export function refusalWhy(kind: ActionKind, verb: Affordance, res: { ok: boolean; needsCascade?: unknown }): DispatchWhy | null {
  return !res.ok && kind === "job_task_flagged" && verb === "do" && res.needsCascade === true ? "openSteps" : null;
}

/** The record id inside a row id, when it carries `prefix`; null when it doesn't. */
export function recordId(rowId: string, prefix: string): string | null {
  return rowId.startsWith(prefix) && rowId.length > prefix.length ? rowId.slice(prefix.length) : null;
}

export function resolveRowVerb(
  kind: ActionKind,
  verb: Affordance,
  id: string,
  payload?: DispatchPayload,
  target?: string | null,
): Mapped | null {
  const date = payload?.date;
  const reason = (payload?.reason ?? "").trim();

  if (verb === "do") {
    if (kind === "appointment") return { name: "appointment.setStatus", input: { id, status: "completed" } };
    // Take Off Hold: back to scheduled or to be scheduled by its date (setJobHold(id, null)).
    if (kind === "job_on_hold") {
      const job = recordId(id, "onhold-");
      return job ? { name: "job.takeOffHold", input: { id: job } } : null;
    }
    // Finish: an honest ending for a job nothing is ahead of (job.finish drafts, never sends).
    if (kind === "job_to_schedule") return { name: "job.finish", input: { id } };
    // Won It: the quote page's own Accepted (stamps the day, makes or catches up the job).
    if (kind === "quote_awaiting") return { name: "quote.setStatus", input: { id, status: "accepted" } };
    // Signed on Paper: recorded by the office, signed by the contract's customer, today.
    if (kind === "contract_unsigned") return { name: "contract.recordPaperSignature", input: { id } };
    // Check Off a flagged job task (cn-v1179): the task itself, done.
    if (kind === "job_task_flagged") {
      const task = recordId(id, "flagtask-");
      return task ? { name: "task.complete", input: { id: task, done: true } } : null;
    }
    return null;
  }

  if (verb === "schedule") {
    if (!date) return null;
    // replace: true is the write this tap always made (the job's plan becomes that day). Nort's
    // job.scheduleDay ADDS a day without it since 2026-11-16; a person's tap does what it did.
    if (kind === "job_to_schedule") return { name: "job.scheduleDay", input: { id, date, replace: true } };
    // A won estimate's day goes on its job (the row names it; no job, no day to set here).
    if (kind === "quote_accepted") return target ? { name: "job.scheduleDay", input: { id: target, date, replace: true } } : null;
    return null;
  }

  if (verb === "snooze") {
    if (!date) return null;
    // A lead has no Snooze since cn-v1170 (a lead on the Leads list IS the reminder).
    // A hold whose day has come: another day, the reason written only when none is saved.
    if (kind === "job_on_hold") {
      const job = recordId(id, "onhold-");
      return job ? { name: "job.snoozeHold", input: { id: job, date, ...(reason ? { reason } : {}) } } : null;
    }
    // Set Aside Until…: a draft invoice parks until a day, with its reason when one is given.
    if (kind === "invoice_draft") return { name: "invoice.setAside", input: { id, date, ...(reason ? { reason } : {}) } };
    // MOVE TO ANOTHER DAY on a write-up row (cn-v1175, R7): the visit's own move (appointment.update, the
    // registry's reschedule), on the day picked at the time of day it had (the row's targetId, "HH:mm" in
    // the company's zone; 9 AM when it had none), keeping its length.
    if (kind === "inspection_writeup") {
      const time = typeof target === "string" && /^\d{2}:\d{2}$/.test(target) ? target : "09:00";
      return { name: "appointment.update", input: { id, starts_at: `${date}T${time}` } };
    }
    // An endless row (No Costs Yet, To Buy): its day in needs_you_waits (0367).
    if (kind === "job_unbilled_work") {
      const job = recordId(id, "nocosts-");
      return job ? { name: "job.snoozeNeedsYou", input: { id: job, kind, date, ...(reason ? { reason } : {}) } } : null;
    }
    if (kind === "materials_needed") {
      const job = recordId(id, "materials-");
      return job ? { name: "job.snoozeNeedsYou", input: { id: job, kind, date, ...(reason ? { reason } : {}) } } : null;
    }
    return null;
  }

  if (verb === "assign") {
    if (kind === "job_to_schedule") return { name: "job.assign", input: { id, assignee: payload?.assignee ?? "" } };
    return null;
  }

  // NO DISMISS ON A SALES VISIT (cn-v1175, R8): the write-up row's Dismiss is gone (Not Sold is its one
  // ending), and with it the verb it sent ("wontHappen" is no longer an Affordance). A work visit's
  // Dismiss is the plain visit row's "dismiss" below (appointment.wontHappen).

  // Not a Cost on a receipt row: the paper is filed under that name by the job's own paper list rule
  // (document.notACost). The row is receipt-<document>; the Couldn't Check line maps to nothing.
  if (verb === "notACost") {
    const doc = kind === "receipt_unbilled" ? recordId(id, "receipt-") : null;
    return doc ? { name: "document.notACost", input: { id: doc } } : null;
  }

  if (verb === "dismiss") {
    // THE HONEST ENDINGS. Each writes a real domain fact (a Not Sold lead, a declined estimate, an
    // inspection's outcome, a cancelled visit or job, a paper in the Archive), so Needs You stays a
    // projection of reality and never a list of things somebody clicked away.
    if (kind === "inquiry") return { name: "inquiry.markLost", input: { id } };
    // Dismiss on a visit nobody closed out (cn-v1166, ONE DEED): the same door as every other Dismiss,
    // the visit page's rule (deleted when nothing hangs on it, else cancelled and kept), never a bare
    // cancel under the same name. The row's visit is always still scheduled (query.ts reads only those).
    if (kind === "appointment") return { name: "appointment.wontHappen", input: { id } };
    if (kind === "organize") return { name: "organize.archive", input: { id } };
    if (kind === "quote_awaiting") return { name: "quote.setStatus", input: { id, status: "declined" } };
    // A win that went away after all (Not Sold): the estimate is declined; its job is left as it is.
    if (kind === "quote_accepted") return { name: "quote.setStatus", input: { id, status: "declined" } };
    if (kind === "inspection_writeup") return { name: "appointment.setOutcome", input: { id, outcome: "lost" } };
    if (kind === "quote_draft") {
      const quote = recordId(id, "qdraft-");
      return quote ? { name: "quote.setStatus", input: { id: quote, status: "declined" } } : null;
    }
    if (kind === "visit_unbilled") {
      const visit = recordId(id, "unbilled-");
      if (visit) return { name: "appointment.setStatus", input: { id: visit, status: "cancelled" } };
      const job = recordId(id, "jdone-");
      return job ? { name: "job.setStatus", input: { id: job, status: "cancelled" } } : null;
    }
    if (kind === "job_to_schedule") return { name: "job.setStatus", input: { id, status: "cancelled" } };
    return null;
  }

  return null;
}
