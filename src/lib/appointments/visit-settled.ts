/**
 * IS THIS VISIT'S BUSINESS OVER? ONE RULE, THREE READERS (cn-v1175).
 *
 * The owner, 2026-11-21, looking at Needs You: "something is not right about how accountability of
 * tasks, they are connected to jobs right? and ones that close out with the job should already be
 * closed out right? [...] check the flows for all of them and see what's missing and where pls".
 *
 * Three readers each asked "is this visit still open?" in their own words: Inspections to Write Up
 * (lib/inspections bucketInspections), Visits to Close Out (Needs You's feeder) and whether a lead's
 * visit still keeps it off the Leads list (lib/leads/new-intake visitStands). The first knew about
 * estimates; the second knew nothing at all, so a visit whose estimate was already written, whose
 * lead had already become a job, or whose job was finished and billed kept asking to be closed out.
 * Now all three ask THIS, and they cannot disagree.
 *
 * SETTLED, by CERTAIN links only (a name or a customer match is never a link: that is a guess, and a
 * guess is offered as a question, never applied; see lib/appointments/visit-offer):
 *
 *   answered      somebody said how it ended (the visit's outcome: won, Not Sold, the old no_bid). A
 *                 visit marked Won with NO job picked is not answered: the win is finished by its job.
 *   job-over      its job is complete, cancelled or invoiced, or carries a bill that finishes the work.
 *                 A SALES visit reads any real bill on its job (a deposit included: the work was sold);
 *                 a WORK visit only a bill that finishes it (a deposit is money for work still ahead).
 * And for a SALES visit only (an inspection or an estimate visit, the visit before a price):
 *   estimate      an estimate was written from it (capture.quote_id), for its lead or for its job.
 *   lead-closed   its lead was won or converted, or a job was made from its lead, AFTER the visit's
 *                 day. Only a visit dated BEFORE that: a second inspection booked after the win is an
 *                 add-on bid, real money, and keeps asking. A visit with no day is never "before".
 *   on-a-job      it is tied to a job: the work it was for went straight to a job.
 *
 * A WORK visit (a job day, a service call, the city's final inspection) is the job's own business: an
 * estimate on its job or a lead behind it is how the job was sold, not an answer to this visit, so
 * those three arms are never read for it. Any other visit (a call, a meeting, Other) is settled only by
 * an answer or its job being over.
 *
 * Pure. No catalog, no client, no money column. Every set is optional: a reader that did not read a
 * link passes nothing for it, and the visit is then offered, never hidden on a guess.
 */

/** The visit before a price: what Sales writes up. */
export const SALES_VISIT_TYPES = ["inspection", "quote"] as const;
/** The work itself, or the authority's visit about it: the job's own business. */
export const WORK_VISIT_TYPES = ["job", "service_call", "final_inspection"] as const;

/** An inspection or an estimate visit. An untyped visit is a site visit (lib/statuses), so it counts. */
export function isSalesVisit(type: string | null | undefined): boolean {
  return !type || (SALES_VISIT_TYPES as readonly string[]).includes(type);
}

/** A job day, a service call or the city's final inspection. */
export function isWorkVisit(type: string | null | undefined): boolean {
  return !!type && (WORK_VISIT_TYPES as readonly string[]).includes(type);
}

export type SettledVisitRow = {
  type?: string | null;
  starts_at: string | null;
  inquiry_id: string | null;
  job_id: string | null;
  capture?: unknown;
  outcome?: string | null;
};

export type VisitLinks = {
  /** Leads that have an estimate written for them. */
  estimateInquiryIds?: ReadonlySet<string>;
  /** Jobs that have an estimate. */
  estimateJobIds?: ReadonlySet<string>;
  /** Estimates that still exist (a capture's quote_id is matched against these). */
  estimateQuoteIds?: ReadonlySet<string>;
  /** Jobs with any real (non-draft, non-void) bill. */
  billedJobIds?: ReadonlySet<string>;
  /** Jobs with a real bill that FINISHES the work (a standard invoice or the final draw). Left out:
   *  a work visit is settled by its job's status alone. */
  finishedJobIds?: ReadonlySet<string>;
  /** Jobs that are complete, cancelled or invoiced. */
  closedJobIds?: ReadonlySet<string>;
  /** Lead id -> the earliest instant it was won or converted, or a job was made from it. */
  leadClosedAt?: ReadonlyMap<string, string>;
};

export type VisitSettledWhy = "answered" | "job-over" | "estimate" | "lead-closed" | "on-a-job";

/** The jobs whose status says the work is over (the estimate rule's own list, lib/action-items/quote-settled). */
export const VISIT_CLOSED_JOB_STATUSES = ["complete", "cancelled", "invoiced"] as const;

/** The estimate this visit was written up into, stamped on the capture by the estimate's save. */
function captureQuote(capture: unknown): string | null {
  if (!capture || typeof capture !== "object") return null;
  const q = (capture as { quote_id?: unknown }).quote_id;
  return typeof q === "string" && q.length > 0 ? q : null;
}

const has = (set: ReadonlySet<string> | undefined, id: string | null | undefined) => !!id && !!set && set.has(id);

/** The first arm that holds, or null: still open business. */
export function visitSettled(row: SettledVisitRow, links: VisitLinks = {}): VisitSettledWhy | null {
  // A WIN WITH NO JOB PICKED IS NOT AN ENDING (cn-v1175, R8): the win is finished by picking its job, so
  // until then the visit is open and asks for it (Inspections, Needs You's write-up pile).
  if ((row.outcome ?? "") !== "" && !(row.outcome === "won" && !row.job_id)) return "answered";
  const work = isWorkVisit(row.type);
  if (row.job_id) {
    if (has(links.closedJobIds, row.job_id)) return "job-over";
    if (has(work ? links.finishedJobIds : links.billedJobIds, row.job_id)) return "job-over";
  }
  if (!isSalesVisit(row.type)) return null;
  const quote = captureQuote(row.capture);
  if (has(links.estimateInquiryIds, row.inquiry_id) || has(links.estimateJobIds, row.job_id) || has(links.estimateQuoteIds, quote)) {
    return "estimate";
  }
  if (row.inquiry_id && links.leadClosedAt?.has(row.inquiry_id)) {
    const closed = Date.parse(links.leadClosedAt.get(row.inquiry_id) ?? "");
    const at = row.starts_at ? Date.parse(row.starts_at) : NaN;
    if (Number.isFinite(closed) && Number.isFinite(at) && at < closed) return "lead-closed";
  }
  if (row.job_id) return "on-a-job";
  return null;
}

/**
 * Lead id -> the earliest instant it closed: its own converted_at (Won stamps it: customerForInquiry),
 * or the first job made from it (jobs.inquiry_id). Rows with no readable day are left out.
 */
export function leadClosedAtFrom(
  leads: readonly { id?: string | null; converted_at?: string | null }[],
  jobs: readonly { inquiry_id?: string | null; created_at?: string | null }[],
): Map<string, string> {
  const out = new Map<string, string>();
  const take = (id: string | null | undefined, at: string | null | undefined) => {
    if (!id || !at || !Number.isFinite(Date.parse(at))) return;
    const had = out.get(id);
    if (!had || Date.parse(at) < Date.parse(had)) out.set(id, at);
  };
  for (const l of leads) take(l.id, l.converted_at);
  for (const j of jobs) take(j.inquiry_id, j.created_at);
  return out;
}
