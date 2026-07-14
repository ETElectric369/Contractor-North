/**
 * Canonical status sets for work orders + quotes — one definition each so the Postgres
 * enum, the TS type, the dropdown options, and the write-guards can't drift (mirrors the
 * job-status.ts spine). Values MIRROR the Postgres enums in 0001_init: `work_order_status`
 * and `quote_status`. The write actions validate against these before touching the DB.
 */
export const WORK_ORDER_STATUSES = ["draft", "assigned", "in_progress", "complete", "cancelled"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Sort weights for the /quotes default view (mirrors JOB_STATUS_PRIORITY): the LIVE pipeline
 *  (awaiting-answer, in-the-works) floats up; settled paperwork — an accepted estimate that
 *  already became a job, a declined/expired one — files away to the bottom. Erik: "accepted
 *  estimates already converted to jobs file away like finished jobs (BRAIN CLUTTER)". */
export const QUOTE_STATUS_PRIORITY: Record<QuoteStatus, number> = {
  sent: 0,      // waiting on the customer — the working pile
  draft: 1,     // still being built
  accepted: 2,  // won — lives on as a job now
  declined: 3,
  expired: 4,
};
