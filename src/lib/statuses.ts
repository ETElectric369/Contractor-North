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

/** Inquiry (lead) pipeline statuses. inquiries.status is FREE TEXT in the DB (0034 —
 *  comment-only enum), so this TS spine is the ONLY write guard: a junk status write
 *  would silently vanish from every filtered leads view. types.ts InquiryStatus derives
 *  from this list. */
export const INQUIRY_STATUSES = ["new", "contacted", "quoted", "won", "lost"] as const;

/** Appointment statuses — mirrors the 0052 check constraint, so a bad value gets the
 *  spine-style message instead of a raw Postgres constraint error. */
export const APPOINTMENT_STATUSES = ["scheduled", "proposed", "completed", "cancelled"] as const;

/** Statuses whose appointments should EXIST as a Google Calendar event (calendar-sync's
 *  push set) — DERIVED from the spine above, never hand-listed, so a future spine change
 *  can't silently drift the push set. The EXCLUSIONS carry the semantic: `proposed` stays
 *  off Google until the customer picks (the confirm flips it to `scheduled`, which the
 *  cron sweep catches); `cancelled` deletes the event. A status added to the spine later
 *  pushes by default — list it here ONLY if it must stay off Google. */
const APPT_NON_PUSH_STATUSES: ReadonlySet<string> = new Set(["proposed", "cancelled"]);
export const APPT_PUSH_STATUSES: readonly string[] = APPOINTMENT_STATUSES.filter(
  (s) => !APPT_NON_PUSH_STATUSES.has(s),
);

/** Appointment TYPES — mirrors the 0051 check constraint + 0131 (final_inspection).
 *  Erik's design (2026-07-14): an inspection IS an appointment type — appointments and
 *  inspections are ONE platform. His "client_meeting" converges onto the pre-existing
 *  `meeting` value (label-only change — no data rewrite), and `final_inspection` is the
 *  one genuinely new value (the code-inspection at job end, distinct from the pre-sale
 *  site walk-through). The create/edit dropdown and the write-guards both read this list.
 *  (Audit 2026-07-16: TS spine and the 0131 DB check are in lockstep; final_inspection
 *  simply has no rows yet — expected early adoption lag, not a dead value.) */
export const APPOINTMENT_TYPES = [
  "inspection",
  "final_inspection",
  "quote",
  "meeting",
  "appointment",
  "other",
] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

/** The inspection-shaped subset — what the Sales → Inspections tab shows. */
export const INSPECTION_TYPES = ["inspection", "final_inspection"] as const;
export const isInspectionType = (t: string | null | undefined): boolean =>
  (INSPECTION_TYPES as readonly string[]).includes(t ?? "");

const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  inspection: "Inspection",
  final_inspection: "Final inspection",
  quote: "Quote / estimate",
  meeting: "Client meeting",
  appointment: "Appointment",
  other: "Other",
};

/** Human label for an appointment type — unknown/legacy values render as themselves
 *  rather than crashing or lying. */
export function appointmentTypeLabel(t: string | null | undefined): string {
  return APPOINTMENT_TYPE_LABELS[(t ?? "") as AppointmentType] ?? (t || "appointment");
}

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
