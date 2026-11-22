import { isDrawKind } from "@/lib/invoice-math";
import { isPrepaymentKind } from "@/lib/prepayments";

/**
 * IS THIS ESTIMATE SETTLED? ONE RULE, ONE FUNCTION (the owner, 2026-11-04: Needs You showed June
 * estimates as needing a day, an answer or a send on a job long finished and billed).
 *
 * Three rows are built from estimates (Won, Needs a Day; No Answer Yet; Estimates Not Sent) and each
 * asked its own inline question about the bill: one read only the job's invoices, one never looked
 * at the job at all, and none read the invoice that NAMES the estimate (invoices.quote_id, 0001).
 * Every one of them asks this now, so the three can never disagree about whether the money moved.
 *
 * Settled when, in this order (the first that holds is the `why`):
 *   invoice-names-quote  a real (non-draft, non-void) invoice that finishes the work (standard or
 *                        the final draw, never a deposit or progress draw) names the estimate (its
 *                        quote_id). Any day, on any job or none: a person tied that bill to it.
 *   job-billed           the job carries a non-draft, non-void invoice that is not a deposit or a
 *                        progress draw (a final draw counts: the work is over), created on or after
 *                        the day the estimate was accepted (a sent or draft one: the day it was made).
 *                        A bill from BEFORE the estimate is an older piece of work on the same job.
 *   job-closed           the job is complete, cancelled, or invoiced (the retired status).
 *   superseded           the estimate is superseded (0391), or a revision of it (revises_quote_id)
 *                        stands accepted.
 * And for a DRAFT or a SENT estimate only (cn-v1175: the owner's "ones that close out with the job should
 * already be closed out right?"), one answer recorded elsewhere:
 *   lead-not-sold        the lead it was written for is Not Sold (inquiries.status 'lost'): the person
 *                        said no, and the estimate still out for them is not a thing to send or chase.
 * NO SIBLING RULE (skeptic #78, cn-v1175): "another estimate on the same job or the same lead was accepted"
 * is NOT an answer about this one, so it settles nothing. Keep Both (cn-v1168, planKeepBoth) puts the
 * earlier estimate back to sent as an open offer beside the accepted one, on the same lead and job: a
 * sibling rule would drop that live offer off Closing and Needs You. And a second estimate written for
 * extra work on a job that already has an accepted one is real work to send: it would never show as
 * unsent. A revision that replaced this estimate is the superseded arm; that is the only "another
 * estimate" that answers for this one.
 * A draft never settles (work in progress), a void never does, a deposit or progress draw never does
 * (money for work still ahead). An estimate with no job and no invoice naming it, whose lead is open, is
 * NOT settled: no rule can know, so the row stays, says its date, and offers its doors (Already Invoiced,
 * Lost).
 */

export type SettledWhy = "invoice-names-quote" | "job-billed" | "job-closed" | "superseded" | "lead-not-sold";

export type SettledQuote = {
  id: string;
  status?: string | null;
  accepted_at?: string | null;
  created_at?: string | null;
  /** The revisions of this estimate (quotes whose revises_quote_id is this one), with their status. */
  revisions?: readonly { status?: string | null }[] | null;
};

export type SettledJob = { id?: string | null; status?: string | null } | null | undefined;

export type SettledInvoice = {
  id?: string | null;
  quote_id?: string | null;
  job_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  invoice_kind?: string | null;
};

export const CLOSED_JOB_STATUSES = ["complete", "cancelled", "invoiced"] as const;
/** The stored word for a Not Sold lead (lib/leads/new-intake NOT_SOLD_STATUS; the value never changed). */
const LEAD_NOT_SOLD = "lost";

/**
 * A JOB WHOSE SALE WENT AWAY (cn-v1175, R3): every estimate on it was declined or expired, and nothing
 * was ever done or billed on it (no time on it, no invoice of any kind but a void one). Such a job is
 * not asked for a day: a win that went away after all leaves its job as it is (Needs You's Not Sold on
 * a won estimate), and the job sat asking for a day for good. A job with no estimate, or with any
 * estimate still in play, or with time or a bill, is not this. Pure; the caller reads the three facts.
 */
export function saleWentAway(input: {
  quotes: readonly { status?: string | null }[];
  hasTime: boolean;
  hasInvoice: boolean;
}): boolean {
  if (input.hasTime || input.hasInvoice || input.quotes.length === 0) return false;
  return input.quotes.every((q) => q.status === "declined" || q.status === "expired");
}

const real = (i: SettledInvoice) => i.status !== "draft" && i.status !== "void";
/** A standard invoice or the final draw: the bill that says the work is over. Never a payment request
 *  (cn-v1177): money asked for ahead of the work, which carries the estimate's quote_id as its deposit. */
const finishes = (i: SettledInvoice) => !isPrepaymentKind(i.invoice_kind) && (!isDrawKind(i.invoice_kind) || i.invoice_kind === "final");

export function quoteSettled(input: {
  quote: SettledQuote;
  job?: SettledJob;
  /** The job's invoices (any status; this function picks). */
  jobInvoices?: readonly SettledInvoice[] | null;
  /** Invoices whose quote_id is this estimate (any status; this function picks). */
  quoteInvoices?: readonly SettledInvoice[] | null;
  /** The lead it was written for, when read (its status). Left out: the arm is never read. */
  lead?: { status?: string | null } | null;
}): { settled: boolean; why: SettledWhy | null } {
  const { quote, job } = input;
  if ((input.quoteInvoices ?? []).some((i) => (i.quote_id == null || String(i.quote_id) === String(quote.id)) && real(i) && finishes(i))) {
    return { settled: true, why: "invoice-names-quote" };
  }
  if (job) {
    const since = quote.accepted_at ?? quote.created_at ?? null;
    const sinceMs = since ? Date.parse(since) : NaN;
    const billed = (input.jobInvoices ?? []).some((i) => {
      if (!real(i) || !finishes(i)) return false;
      if (!Number.isFinite(sinceMs)) return true; // undated estimate: any finishing bill on the job
      const at = i.created_at ? Date.parse(i.created_at) : NaN;
      // An invoice with no readable day is read as billing the job (never a nag on unknown data).
      // Compared by DAY: a bill written the morning of the acceptance still counts.
      return !Number.isFinite(at) || dayOf(at) >= dayOf(sinceMs);
    });
    if (billed) return { settled: true, why: "job-billed" };
    if ((CLOSED_JOB_STATUSES as readonly string[]).includes(String(job.status ?? ""))) return { settled: true, why: "job-closed" };
  }
  if (quote.status === "superseded" || (quote.revisions ?? []).some((r) => r.status === "accepted")) {
    return { settled: true, why: "superseded" };
  }
  if (quote.status === "draft" || quote.status === "sent") {
    if (input.lead?.status === LEAD_NOT_SOLD) return { settled: true, why: "lead-not-sold" };
  }
  return { settled: false, why: null };
}

/** The UTC day number of an instant (the bill's day against the estimate's day). */
function dayOf(ms: number): number {
  return Math.floor(ms / 86_400_000);
}
