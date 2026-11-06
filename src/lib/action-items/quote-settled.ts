import { isDrawKind } from "@/lib/invoice-math";

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
 * A draft never settles (work in progress), a void never does, a deposit or progress draw never does
 * (money for work still ahead). An estimate with no job and no invoice naming it is NOT settled: no
 * rule can know, so the row stays, says its date, and offers its doors (Already Invoiced, Lost).
 */

export type SettledWhy = "invoice-names-quote" | "job-billed" | "job-closed" | "superseded";

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

const real = (i: SettledInvoice) => i.status !== "draft" && i.status !== "void";
/** A standard invoice or the final draw: the bill that says the work is over. */
const finishes = (i: SettledInvoice) => !isDrawKind(i.invoice_kind) || i.invoice_kind === "final";

export function quoteSettled(input: {
  quote: SettledQuote;
  job?: SettledJob;
  /** The job's invoices (any status; this function picks). */
  jobInvoices?: readonly SettledInvoice[] | null;
  /** Invoices whose quote_id is this estimate (any status; this function picks). */
  quoteInvoices?: readonly SettledInvoice[] | null;
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
  return { settled: false, why: null };
}

/** The UTC day number of an instant (the bill's day against the estimate's day). */
function dayOf(ms: number): number {
  return Math.floor(ms / 86_400_000);
}
