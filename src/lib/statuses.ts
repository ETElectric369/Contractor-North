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
