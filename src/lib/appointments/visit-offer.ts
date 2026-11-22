/**
 * THE OFFER, NEVER A GUESS (cn-v1175, R5).
 *
 * The owner's own case: an inspection nobody ever tied to the job it became. The visit carries only its
 * customer; the work was done and billed on a job for the same customer, and the visit kept asking. A
 * customer can have two pieces of work, so the app may not decide that this job is that visit's: that
 * is a guess. It may ASK. A visit that is still open (an inspection to write up, or one whose day went
 * by) whose CUSTOMER RECORD (the visit's customer_id, else its lead's: a link, never a name match) has a
 * job made after the visit offers that job as the row's one boxed button, "Done as <job>?". One tap asks
 * in place; the yes goes through the visit's own attach door (linkAppointmentTo: the job attached, the
 * visit Won), and the row leaves by the one visit rule.
 *
 * More than one candidate: the newest is the button, the others are behind the row's dots. None: the
 * row is as it was. A visit that already has a job, has no day, or has no customer record is offered
 * nothing. Pure; the reader hands the candidates.
 *
 * ESTIMATES ARE NOT OFFERED HERE. "Written Up as <estimate>?" needs a door that ties an existing
 * estimate to a visit, and the only such tie is made inside the estimate's own save (saveQuote's
 * capture backlink). No door was added in this release; the rule takes estimate candidates so the day
 * one exists the offer is one line away, and `kind` already says which.
 */

export type OfferKind = "job" | "estimate";

export type OfferCandidate = {
  kind: OfferKind;
  id: string;
  customer_id: string | null;
  created_at: string | null;
  /** What the button names it by: the job's number and name, the estimate's number or title. */
  label: string;
};

export type VisitOffer = {
  kind: OfferKind;
  id: string;
  label: string;
  /** The other candidates, newest first: behind the row's dots. */
  others: { kind: OfferKind; id: string; label: string }[];
};

export type OfferVisit = {
  starts_at: string | null;
  job_id: string | null;
  customer_id?: string | null;
  /** The visit's lead's customer record, when the visit has none of its own. */
  lead_customer_id?: string | null;
};

/** The customer record a visit is offered by: its own, else its lead's. Never a name. */
export function offerCustomerOf(v: Pick<OfferVisit, "customer_id" | "lead_customer_id">): string | null {
  return v.customer_id || v.lead_customer_id || null;
}

/** The offer for one visit, or null. `kinds` limits what is offered (the doors that exist: jobs). */
export function visitOffer(
  visit: OfferVisit,
  candidates: readonly OfferCandidate[],
  kinds: readonly OfferKind[] = ["job"],
): VisitOffer | null {
  if (visit.job_id) return null;
  const customer = offerCustomerOf(visit);
  const since = visit.starts_at ? Date.parse(visit.starts_at) : NaN;
  if (!customer || !Number.isFinite(since)) return null;
  const made = (c: OfferCandidate) => (c.created_at ? Date.parse(c.created_at) : NaN);
  const fit = candidates
    .filter((c) => kinds.includes(c.kind) && !!c.id && !!c.label.trim() && c.customer_id === customer && made(c) > since)
    .sort((a, b) => made(b) - made(a));
  if (!fit.length) return null;
  const [first, ...rest] = fit;
  return { kind: first.kind, id: first.id, label: first.label, others: rest.map((c) => ({ kind: c.kind, id: c.id, label: c.label })) };
}

/** A job's words on the button: its number and its name, as every other screen says a job. */
export function offerJobLabel(j: { job_number?: string | null; name?: string | null }): string {
  return [j.job_number, j.name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
}
