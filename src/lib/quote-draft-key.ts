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
  /** The signed-in user — v3 namespaces slots per user so a shared machine's next sign-in
      can't restore (and silently autosave over) the previous staff user's draft. */
  userId?: string | null;
}): string {
  const own = ids.captureId || ids.jobId || ids.customerId || ids.inquiryId || "new";
  // The version prefix is a one-time eviction of every pre-fix draft, including the poisoned
  // shared "new" slot. useDraft is sessionStorage, so that entry would otherwise survive until the
  // browser is quit — no use to somebody who is mid-estimate right now.
  return `quote-builder:v3:${ids.userId || "anon"}:${own}`;
}

/**
 * WHERE THIS DRAFT MIGHT STILL BE SITTING, newest scheme first.
 *
 * cn-v680's "v2:" prefix orphaned every pre-fix draft — and Erik had an unsaved Moraine Rd estimate,
 * built by hand and never submitted, in the exact slot it orphaned. sessionStorage still had the
 * bytes; the app had simply stopped asking for them.
 *
 * The "new" slot is included on purpose, and it is the whole point: an estimate started from a
 * walk-through had no job, no customer and no lead, so BOTH of his inspections wrote there. That
 * shared slot is precisely where the lost work is.
 */
export function quoteDraftLegacyKeys(ids: {
  captureId?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  inquiryId?: string | null;
  userId?: string | null;
}): string[] {
  const preV2 = ids.jobId || ids.customerId || ids.inquiryId || "new";
  // v2 (pre-user-namespacing) adopts forward — Andrew's possibly-recoverable 45-line session
  // draft lives there; evicting it to gain the namespace would eat the very work being rescued.
  const v2own = ids.captureId || ids.jobId || ids.customerId || ids.inquiryId || "new";
  const keys = [`quote-builder:v2:${v2own}`, `quote-builder:${preV2}`];
  // A walk-through-sourced estimate wrote to the shared slot under the old key even when it had a
  // capture id, because the old key never looked at one.
  if (ids.captureId && preV2 !== "new") keys.push("quote-builder:new");
  return keys;
}
