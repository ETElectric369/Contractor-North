import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * THE VISIT CLOSES WHEN ITS ESTIMATE MOVES (cn-v1069; Erik's law: one door opens, the last one
 * closes, and things that pertain to each other stay attached both ways).
 *
 * An estimate stands behind a visit by one of THREE links: the visit's lead (`inquiry_id`), the
 * visit's job (`job_id`), or the write-up backlink the estimator stamps INSIDE the visit's capture
 * (`capture.quote_id`, saveQuote, the only link a lead-less "Inspect now" visit ever gets). Every
 * door that closed a visit from the estimate's side read the first two and never the third, so a
 * visit whose estimate was declined, or became a job, stayed "still open business" on the
 * Inspections tab for good — two of Erik's eight job-less completed visits were exactly this.
 *
 * ONE FUNCTION, called wherever the estimate's answer is decided (its status changing, its job being
 * made, its job being pinned): finds the visits by all three links and closes what is still open —
 * the job attached where the visit has none (attached, NOT absorbed: an attached inspection keeps
 * its own calendar life, 0237), the outcome stamped where none is. Twice-safe: every write is
 * guarded by the column still being null. Best-effort by design: the estimate's own status is the
 * fact that matters, and a missing visit must never fail the estimate's save.
 *
 * Migration 0385 ran the same two rules once over the rows these doors had already missed.
 */
export interface QuoteLinks {
  id: string;
  inquiry_id?: string | null;
  job_id?: string | null;
}

export interface VisitBehind {
  id: string;
  job_id?: string | null;
  outcome?: string | null;
}

export type VisitOutcome = "won" | "lost";

/** What the estimate's deed means for the visits behind it. */
export interface Closing {
  /** The job the estimate became or was pinned to: attached to every visit that has none. */
  jobId?: string | null;
  /** The estimate's decision: stamped on every visit still undecided. */
  outcome?: VisitOutcome | null;
}

/** The estimate's new status, as the visit's outcome: accepted is won, declined or expired is lost,
 *  anything else decides nothing. */
export function outcomeForQuoteStatus(status: string | null | undefined): VisitOutcome | null {
  if (status === "accepted") return "won";
  if (status === "declined" || status === "expired") return "lost";
  return null;
}

/** The PostgREST `or` filter naming every visit this estimate stands behind: by the capture's own
 *  backlink always, by the lead and the job when the estimate has them. */
export function visitsBehindQuoteFilter(q: QuoteLinks): string {
  const arms = [`capture->>quote_id.eq.${q.id}`];
  if (q.inquiry_id) arms.push(`inquiry_id.eq.${q.inquiry_id}`);
  if (q.job_id) arms.push(`job_id.eq.${q.job_id}`);
  return arms.join(",");
}

/** Which of the visits found get which stamp: a job only where there is none, an outcome only where
 *  none is. Pure, so the rule is pinned without a database. */
export function closingsFor(rows: VisitBehind[], w: Closing): { attach: string[]; stamp: string[] } {
  const attach = w.jobId ? rows.filter((r) => !r.job_id).map((r) => r.id) : [];
  const stamp = w.outcome ? rows.filter((r) => !r.outcome).map((r) => r.id) : [];
  return { attach, stamp };
}

export interface ClosedBehind {
  attached: number;
  stamped: number;
  /** A read or write that failed, said; never thrown (the estimate's deed already landed). */
  error?: string;
}

/**
 * Find the org's visits behind `quote` and close what is still open. The client is the caller's
 * (RLS scopes the read and both writes to its org). A zero-row write here is not a failure: the
 * guard (`job_id is null` / `outcome is null`) simply found nothing left to close.
 */
export async function closeVisitsBehindQuote(
  supabase: SupabaseClient,
  quote: QuoteLinks,
  w: Closing,
): Promise<ClosedBehind> {
  if (!w.jobId && !w.outcome) return { attached: 0, stamped: 0 };
  const { data, error } = await supabase
    .from("appointments")
    .select("id, job_id, outcome")
    .or(visitsBehindQuoteFilter(quote))
    .limit(50);
  if (error) return { attached: 0, stamped: 0, error: error.message };
  const { attach, stamp } = closingsFor((data ?? []) as VisitBehind[], w);
  const nowIso = new Date().toISOString();
  let attached = 0;
  let stamped = 0;
  const errors: string[] = [];
  if (attach.length) {
    const { data: rows, error: e } = await supabase
      .from("appointments")
      .update({ job_id: w.jobId, updated_at: nowIso })
      .in("id", attach)
      .is("job_id", null)
      .select("id");
    if (e) errors.push(e.message);
    else attached = rows?.length ?? 0;
  }
  if (stamp.length) {
    const { data: rows, error: e } = await supabase
      .from("appointments")
      .update({ outcome: w.outcome, outcome_at: nowIso, updated_at: nowIso })
      .in("id", stamp)
      .is("outcome", null)
      .select("id");
    if (e) errors.push(e.message);
    else stamped = rows?.length ?? 0;
  }
  return { attached, stamped, ...(errors.length ? { error: errors.join("; ") } : {}) };
}
