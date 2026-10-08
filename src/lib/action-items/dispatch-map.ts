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
 * (materials_needed), reportback-<job> (job_report_back). A won estimate's day goes on its JOB, which the row names as `target`.
 *
 * No task arms and no convert branch (Wave 1, W1-16): tasks and Reminders never reach Needs You
 * (0358). The registry keeps task.* and inquiry.convert for Nort; nothing here reaches them. Nor
 * inquiry.delete: a lead's ending is inquiry.markLost (kept, status lost), never a deletion.
 */
export type DispatchPayload = { date?: string; assignee?: string; reason?: string };

export type Mapped = { name: string; input: Record<string, unknown> };

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
    if (kind === "inquiry") return { name: "inquiry.contact", input: { id } };
    if (kind === "appointment") return { name: "appointment.setStatus", input: { id, status: "completed" } };
    // Take Off Hold: back to scheduled or to be scheduled by its date (setJobHold(id, null)).
    if (kind === "job_on_hold") {
      const job = recordId(id, "onhold-");
      return job ? { name: "job.takeOffHold", input: { id: job } } : null;
    }
    // Finish: an honest ending for a job nothing is ahead of (job.finish drafts, never sends).
    if (kind === "job_to_schedule") return { name: "job.finish", input: { id } };
    return null;
  }

  if (verb === "schedule") {
    if (!date) return null;
    if (kind === "job_to_schedule") return { name: "job.scheduleDay", input: { id, date } };
    // A won estimate's day goes on its job (the row names it; no job, no day to set here).
    if (kind === "quote_accepted") return target ? { name: "job.scheduleDay", input: { id: target, date } } : null;
    return null;
  }

  if (verb === "snooze") {
    if (!date) return null;
    // SNOOZE IS NOT A CONTACT. The lead comes back on that day and nobody is said to have reached
    // anyone (no 'contacted', no last_contacted_at): Nort's inquiry.snooze, the same deed.
    if (kind === "inquiry") return { name: "inquiry.snooze", input: { id, date } };
    // Still Waiting: the follow-up day only (quotes.follow_up_at); valid_until never moves.
    if (kind === "quote_awaiting") return { name: "quote.followUp", input: { id, date } };
    // A hold whose day has come: another day, the reason written only when none is saved.
    if (kind === "job_on_hold") {
      const job = recordId(id, "onhold-");
      return job ? { name: "job.snoozeHold", input: { id: job, date, ...(reason ? { reason } : {}) } } : null;
    }
    // Set Aside Until…: a draft invoice parks until a day, with its reason when one is given.
    if (kind === "invoice_draft") return { name: "invoice.setAside", input: { id, date, ...(reason ? { reason } : {}) } };
    // An endless row (No Costs Yet, To Buy): its day in needs_you_waits (0367).
    if (kind === "job_unbilled_work") {
      const job = recordId(id, "nocosts-");
      return job ? { name: "job.snoozeNeedsYou", input: { id: job, kind, date, ...(reason ? { reason } : {}) } } : null;
    }
    if (kind === "materials_needed") {
      const job = recordId(id, "materials-");
      return job ? { name: "job.snoozeNeedsYou", input: { id: job, kind, date, ...(reason ? { reason } : {}) } } : null;
    }
    if (kind === "job_report_back") {
      const job = recordId(id, "reportback-");
      return job ? { name: "job.snoozeNeedsYou", input: { id: job, kind, date, ...(reason ? { reason } : {}) } } : null;
    }
    return null;
  }

  if (verb === "assign") {
    if (kind === "job_to_schedule") return { name: "job.assign", input: { id, assignee: payload?.assignee ?? "" } };
    return null;
  }

  if (verb === "dismiss") {
    // THE HONEST ENDINGS. Each writes a real domain fact (a lost lead, a declined estimate, an
    // inspection's outcome, a cancelled visit or job, a paper in the Archive), so Needs You stays a
    // projection of reality and never a list of things somebody clicked away.
    if (kind === "inquiry") return { name: "inquiry.markLost", input: { id } };
    if (kind === "appointment") return { name: "appointment.setStatus", input: { id, status: "cancelled" } };
    if (kind === "organize") return { name: "organize.archive", input: { id } };
    if (kind === "quote_awaiting") return { name: "quote.setStatus", input: { id, status: "declined" } };
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
