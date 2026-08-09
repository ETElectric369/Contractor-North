/**
 * WHICH DRAFT SLOT AN ESTIMATE-IN-PROGRESS BELONGS TO.
 *
 * Erik, mid-estimate: "im creating an estimate for [13125 Moraine Rd] now and its pulling info from
 * a sarah cain inspection but i cant see anything i wrote for this job."
 *
 * The key was `jobId ?? customerId ?? inquiryId ?? "new"`, and the comment beside it already knew
 * the failure mode — it explained that inquiryId had been ADDED because a lead-sourced estimate
 * "would otherwise collapse to the shared 'new' slot — two prospects' drafts bleeding into each
 * other." The list was still one short.
 *
 * AN ESTIMATE STARTED FROM A WALK-THROUGH HAS NONE OF THE THREE. An inspection happens before the
 * job exists, often before the customer exists, and outside the lead funnel entirely: both of his
 * live inspections — 13125 Moraine Rd and Sarah Cain — carry job_id, customer_id AND inquiry_id all
 * null. So both resolved to "new", and the Sarah Cain draft restored straight over the Moraine Rd
 * prefill. Nothing was deleted; somebody else's job was painted on top of his.
 *
 * The appointment is the most specific identity available (one job can hold several walk-throughs),
 * so it wins. Extracted from the component purely so the precedence is testable — a shared-slot
 * collision is invisible until it costs somebody an hour on a real estimate.
 */
export function quoteDraftKey(ids: {
  captureId?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  inquiryId?: string | null;
}): string {
  const own = ids.captureId || ids.jobId || ids.customerId || ids.inquiryId || "new";
  // The version prefix is a one-time eviction of every pre-fix draft, including the poisoned
  // shared "new" slot. useDraft is sessionStorage, so that entry would otherwise survive until the
  // browser is quit — no use to somebody who is mid-estimate right now.
  return `quote-builder:v2:${own}`;
}
