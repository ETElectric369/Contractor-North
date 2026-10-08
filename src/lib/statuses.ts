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
 *  site inspection). The create/edit dropdown and the write-guards both read this list.
 *  (Audit 2026-07-16: TS spine and the 0131 DB check are in lockstep; final_inspection
 *  simply has no rows yet — expected early adoption lag, not a dead value.) */
export const APPOINTMENT_TYPES = [
  "inspection",
  "final_inspection",
  // A SERVICE CALL IS A KIND OF BOOKING. Erik: "At booking: [Service call] [Contract job] →
  // service calls land on the job board → walk-through never asks; it already knows." It used to
  // be the inspection's first question, where its answer was already settled — the phone knew
  // it while Alexa wrote the address down. See migration 0188.
  "service_call",
  // THE WORK ITSELF, ON A DAY (0231). Not every booking is a visit before the work — a job he
  // already quoted is a Monday, and folding that into "inspection" overruled the one person who
  // knew. See lib/schedule/work-shape.
  "job",
  // A phone call somebody has to sit down and make (0232) — unbillable, unavoidable, and until now
  // the only kind of work the app could describe but not put on a day.
  "call",
  "quote",
  "meeting",
  "appointment",
  "other",
] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

/**
 * THE KINDS A PERSON PICKS (W2-06): five, in his words — Inspection, Job, Service Call, Phone Call,
 * Other. Nine was a list nobody could choose from: "Quote / Estimate", "Client Meeting" and
 * "Appointment" each meant Other in practice, and a final inspection is the city's, on the job's
 * permit (production: inspection 44, appointment 8, job 4, service_call 2, call 1, quote 1, meeting 1).
 *
 * APPOINTMENT_TYPES above stays the database-valid, read set: an old row typed quote / meeting /
 * appointment / final_inspection still reads truly under its old label, and its own old kind always
 * saves (appointments/actions resolveType). Only the pickers and the create guards narrow to this.
 */
/* SERVICE CALL CAME OFF THIS LIST (Erik, 2026-10-03): "I think we should takeoff service call as a
 * bucket because its deadweight as we have replaced it with time and material versus fixed price."
 * He is right, and the code already said so: the appointment page called it "a legacy
 * service_call/job appointment — new ones become real jobs at booking", isServiceCall() had NO
 * callers, and the one query that still named it grouped it WITH 'job'. The question it used to
 * answer at booking — do I bill actuals or a price? — is jobs.billing_type now, so the bucket was
 * asking something that had moved. Two August rows still READ as Service Call, because
 * APPOINTMENT_TYPES above is the read set and only this list narrows.
 * NOT THE SAME THING as the 'service' WorkKind on an inquiry (schedule/work-shape.ts, pinned by
 * inquiries_work_kind_known): that is a live answer to a different question — what KIND of work is
 * this — on a different table. It stays. */
export const PICKABLE_APPOINTMENT_TYPES = ["inspection", "job", "call", "other"] as const satisfies readonly AppointmentType[];
export type PickableAppointmentType = (typeof PICKABLE_APPOINTMENT_TYPES)[number];
export const isPickableAppointmentType = (t: unknown): t is PickableAppointmentType =>
  (PICKABLE_APPOINTMENT_TYPES as readonly string[]).includes(String(t ?? ""));

/** The Type select's options for a row: the five, plus the row's OWN old kind when it has one (a
 *  Client Meeting edited stays a Client Meeting). Without it the controlled select shows the first
 *  option instead, and a Save silently rewrites the type to something nobody picked. */
export function appointmentTypeOptions(current?: string | null): string[] {
  const own = String(current ?? "");
  const legacy = own && !isPickableAppointmentType(own) && (APPOINTMENT_TYPES as readonly string[]).includes(own);
  return legacy ? [...PICKABLE_APPOINTMENT_TYPES, own] : [...PICKABLE_APPOINTMENT_TYPES];
}

/** The inspection-shaped subset — what the Sales → Inspections tab shows. */
export const INSPECTION_TYPES = ["inspection", "final_inspection"] as const;

/** Visits whose PRODUCT is an estimate — the write-up-nag set: the inspections plus the
 *  explicit "quote" booking ("you are going out to price it" — lib/schedule/work-shape).
 *  A completed quote visit used to leave every surface at once: not an inspection (write-up
 *  feeder passed it by), not billable work (visit_unbilled is service_call/job only) — priced
 *  it and vanished. INSPECTION_TYPES itself stays narrow: it gates inspection-only UI. */
export const ESTIMATE_VISIT_TYPES = [...INSPECTION_TYPES, "quote"] as const;

export const isInspectionType = (t: string | null | undefined): boolean =>
  (INSPECTION_TYPES as readonly string[]).includes(t ?? "");

/** The visit types with a WIN OR A LOSS to record (the 0205 outcome; cn-v1069): every kind but the
 *  work visits (job, service_call — their answer is the invoice) and the final inspection (the
 *  authority's answer, on the permit). Wider than ESTIMATE_VISIT_TYPES on purpose: a meeting, a call
 *  or an Other visit that led nowhere is "nothing came of it", and one attached to a job is won.
 *  An untyped visit is a site visit (schedule/work-shape workKind), so null counts. */
export const DECIDABLE_VISIT_TYPES = APPOINTMENT_TYPES.filter((t) => t !== "job" && t !== "service_call" && t !== "final_inspection");
export const isDecidableVisitType = (t: string | null | undefined): boolean =>
  !t || (DECIDABLE_VISIT_TYPES as readonly string[]).includes(t);

/* ONE WORD FOR THE SITE VISIT, AND IT IS THE STORED ONE. The visit before a price is an INSPECTION
   wherever staff or Nort read it, and this map is the only place that says so.

   THE WORD WENT OUT AND CAME BACK, so do not "tidy" it again: W2-10 (8c3e9bc5, written 2026-09-28,
   live as cn-v1034 on the night of 2026-09-30) laid "Walk-Through" over the stored type, and Erik
   reversed it on 2026-10-03 after about three days of it — "im still see walk-throughs as a bucket
   when everything is about inspections and to be called Inspections". Three reasons it is his to
   name and this is where it lands:
     · THE STORED VALUE IS ALREADY 'inspection' (44 rows in production). A display word laid over a
       different stored word is what produced the My Day defect: a reader capitalised the type by
       hand and printed "Inspection" while every other screen said Walk-Through. Matching the display
       word to the stored word kills that whole class.
     · THE PAGE IS /inspections, with Inspections in the dock.
     · THE CITY'S IS NOT THIS. It is the separate type `final_inspection`, "Final Inspection", on the
       job's permit — so nothing had to be reserved for it in the first place.
   Words only: no stored type, column or route changes, and `inspection` is what it always was. */
const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  inspection: "Inspection",
  final_inspection: "Final Inspection",
  service_call: "Service Call",
  job: "Job",
  call: "Phone Call",
  quote: "Quote / Estimate",
  meeting: "Client Meeting",
  appointment: "Appointment",
  other: "Other",
};

/** Human label for an appointment type — unknown/legacy values render as themselves
 *  rather than crashing or lying. */
export function appointmentTypeLabel(t: string | null | undefined): string {
  return APPOINTMENT_TYPE_LABELS[(t ?? "") as AppointmentType] ?? (t || "appointment");
}

/* A STORED TITLE FROM THE THREE DAYS THE VISIT WAS A "WALK-THROUGH", SAID IN TODAY'S WORD.
   The label above fixes the TYPE everywhere. It does not fix a title, and titles were written too:
   from cn-v1034 (2026-09-30) to 2026-10-03 every booking door stamped "Walk-Through: <who>" into
   appointments.title (lib/schedule/work-shape bookingTitle, the lead doors, the public intake's
   auto-book). Nothing rewrote those rows, so Activity printed BOTH words in one line —
   "Inspection booked — Walk-Through: Tom Goodman" — on exactly the visits Erik made while testing
   that change. Two words for one thing is the fault he reported, so the stock tag is re-said where
   it is READ, which is the only fix that needs no edit to a row somebody may have retyped since.

   ONLY THE STOCK TAG AT THE VERY FRONT MOVES, and only when a separator or the end follows it —
   job-name.ts's LEADING_TAG rule, for the same reason: a title is the office's to type, so
   "Walk the attic with Tom" and "Walkthrough video for Rita" come back byte for byte. Nothing is
   written back: the edit form and the Google push keep the stored string, so re-saying it here can
   never quietly rewrite a row.

   The matcher below is a MATCHER, not a word anybody reads — which is why inspection-word.test.ts
   (string literals, template chunks and JSX text) does not sweep it and this file needs no entry on
   its allowlist. What this function RETURNS is the swept word. */
const STORED_OLD_TAG = /^(\s*)(walk\s*-?\s*through(s)?)((?:\s*[:—–·|]\s*)|(?:\s+-\s+)|(?:\s*$))/i;

/** A visit's stored title as a person should read it today: a stock "Walk-Through: Tom Goodman" row
 *  reads "Inspection: Tom Goodman", a bare "Walk-Throughs" reads "Inspections", and a title a person
 *  typed is returned unchanged. Every surface that PRINTS appointments.title reads it through here. */
export function visitTitle(title: string | null | undefined): string {
  return String(title ?? "").replace(STORED_OLD_TAG, (_m, lead: string, _word: string, plural: string | undefined, sep: string) =>
    `${lead}${plural ? "Inspections" : "Inspection"}${sep}`,
  );
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
