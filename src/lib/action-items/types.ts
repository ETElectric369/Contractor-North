// The unified "actionable item" model — the action-layer twin of <ModalActions>.
// Every surface (jobs to schedule, inquiries, appointments, captures to file,
// money/legal clocks, leak detectors) projects onto ONE shape with ONE set of
// canonical verbs, so a single list component and a single voice registry can
// act on all of them.
//
// ── THE BADGE INVARIANT (the law; enforced by tests/badge-economy.test.ts) ──
// A NUMBER on chrome = distinct items needing a HUMAN DECISION TODAY that the
// app cannot defer, shown where the deciding happens, display-capped at 9+.
// No count may be the length of an unbounded or undated set — every counted
// item carries an expiry: a date, a bounded window, or a rollup.
//
// Chores never badge; decisions badge. Overdue tasks scream through Today's 6's
// red due-chips, not through chrome. Door labels ("Everything else · N",
// "Office · N") are browse affordances, not badges — grey inventory only.

export type ActionKind =
  // task/work_order are BADGE-EXEMPT and NO LONGER FED by getActionItems (the
  // task feeder was deleted — an undated task counted as "due now" forever,
  // violating the invariant above). The kinds stay in the union because the
  // dispatch grammar (dispatch.ts resolve()) and the six-slot card's "…" sheet
  // reuse the (kind, verb) → registry mapping. Do not re-feed them.
  | "task" // an open to-do
  | "work_order" // an open to-do tied to a job
  | "job_to_schedule" // a job with no date yet
  | "inquiry" // a new/uncontacted lead
  | "appointment" // a scheduled appt awaiting completion
  | "organize" // a capture (receipt/note/doc) needing a filing decision
  | "invoice_overdue" // a sent/partial invoice past its due date (A/R)
  | "quote_awaiting" // a sent quote/estimate gone quiet or nearing its valid-until
  | "invoice_draft" // a draft invoice never sent (billed-up money sitting in limbo)
  | "lien_deadline" // a lien prelim/recording deadline coming due or past
  | "contract_unsigned" // a contract sent but not yet signed
  | "bug_report" // an open bug reported from the field (owner watch)
  // ── The end-of-day money-leak sweep (the "Apache Ct" detectors) ──
  | "time_stray" // a time entry left running past its day, or closed with no job — hours nobody can bill
  | "job_unbilled_work" // a job worked recently with ZERO costs/materials recorded (the 30'-of-Romex leak)
  | "job_needs_return" // a job worked recently with nothing scheduled next (the forgotten return visit)
  | "materials_needed"; // unpurchased take-off items on a job the crew is about to stand on (buy before the truck rolls)

/** The four urgency streams the inbox renders under. Order is the render order:
 *  money first (chase the dollars), then fresh leads, then today's work, then
 *  the things we're waiting on someone else for. */
export type Stream = "money" | "leads" | "today" | "waiting";

export const STREAM_ORDER: Stream[] = ["money", "leads", "today", "waiting"];

export const STREAM_LABEL: Record<Stream, string> = {
  money: "Money",
  leads: "Leads",
  today: "Today",
  waiting: "Waiting",
};

/** Which stream each kind belongs to — assigned per-kind in ONE place so the
 *  grouped inbox and any digest/summary surface can never disagree. */
export const KIND_STREAM: Record<ActionKind, Stream> = {
  // task/work_order entries exist for type completeness + the dispatch grammar —
  // the inbox never emits them (badge-exempt; see the invariant above).
  task: "today",
  work_order: "today",
  job_to_schedule: "today",
  inquiry: "leads",
  appointment: "today",
  organize: "waiting",
  invoice_overdue: "money",
  quote_awaiting: "money",
  invoice_draft: "money",
  lien_deadline: "waiting", // compliance clock — legal, not A/R
  contract_unsigned: "waiting",
  bug_report: "waiting",
  time_stray: "today", // a running/orphaned clock is today's cleanup, not tomorrow's
  job_unbilled_work: "money", // uncosted work = dollars leaking off the invoice
  job_needs_return: "today", // the return visit gets scheduled today or it gets forgotten
  materials_needed: "today", // the shopping run happens before the truck rolls — today's prep
};

/** The canonical verbs. Each maps to an existing server action in dispatch.ts. */
export type Affordance =
  | "do" // mark complete / contacted
  | "schedule" // put on the calendar / pick a date
  | "assign" // give to a person
  | "convert" // advance the pipeline (inquiry → estimate/job, capture → filed)
  | "snooze" // defer to a later date
  | "dismiss" // remove from my list (delete / cancel / archive)
  | "open"; // drill into the detail page

export interface ActionItem {
  id: string;
  kind: ActionKind;
  stream: Stream; // urgency stream (money/leads/today/waiting) — derived from kind via KIND_STREAM
  title: string;
  subtitle?: string | null; // customer / job / vendor line
  who?: string | null; // assignee name
  when?: string | null; // ISO or yyyy-mm-dd (due/follow-up/starts/null)
  urgency: 0 | 1 | 2; // 0 normal · 1 soon/overdue · 2 urgent
  done: boolean; // drives the universal "sinks to the bottom" rule
  href: string; // deep link for Open
  affordances: Affordance[]; // canonical verbs valid for THIS item
}

export const KIND_META: Record<ActionKind, { label: string; tone: "slate" | "blue" | "amber" | "green" }> = {
  task: { label: "Task", tone: "slate" },
  work_order: { label: "Job task", tone: "blue" },
  job_to_schedule: { label: "To schedule", tone: "amber" },
  inquiry: { label: "Lead", tone: "green" },
  appointment: { label: "Appointment", tone: "blue" },
  organize: { label: "To file", tone: "slate" },
  invoice_overdue: { label: "Overdue invoice", tone: "amber" },
  quote_awaiting: { label: "Awaiting reply", tone: "green" },
  invoice_draft: { label: "Draft invoice", tone: "slate" },
  lien_deadline: { label: "Lien deadline", tone: "amber" },
  contract_unsigned: { label: "Unsigned contract", tone: "blue" },
  bug_report: { label: "Bug report", tone: "amber" },
  time_stray: { label: "Stray time", tone: "amber" },
  job_unbilled_work: { label: "No costs recorded", tone: "amber" },
  job_needs_return: { label: "Nothing scheduled", tone: "blue" },
  // Deliberately NOT "No costs recorded" (job_unbilled_work = nothing captured yet);
  // this one means items ARE on the take-off and still need buying.
  materials_needed: { label: "Materials needed", tone: "blue" },
};

// The affordance matrix — which verbs each kind exposes. THE contract, consumed
// by both the UI (<ActionList>) and (later) the voice registry. (Assign/Convert
// land in a follow-up step with inline pickers.)
export const AFFORDANCES: Record<ActionKind, Affordance[]> = {
  task: ["do", "schedule", "assign", "snooze", "dismiss", "open"],
  work_order: ["do", "schedule", "assign", "dismiss", "open"],
  job_to_schedule: ["schedule", "assign", "open"],
  inquiry: ["do", "schedule", "convert", "snooze", "dismiss", "open"],
  appointment: ["do", "dismiss", "open"],
  organize: ["dismiss", "open"],
  // Money/legal items drill into their own surface to act (record a payment, serve a
  // notice, chase a signature) — no generic "do"/"dismiss" that would mislabel them.
  invoice_overdue: ["open"],
  // No snooze on quotes: valid_until is the CUSTOMER-facing offer window (it's on the
  // public share), so bumping it would change the offer, not defer the reminder —
  // open-only until quotes grow a follow-up field.
  quote_awaiting: ["open"],
  invoice_draft: ["open"],
  lien_deadline: ["open"],
  contract_unsigned: ["open"],
  bug_report: ["open"], // triage on the Bug watch page
  // Detector findings are DERIVED rows (a time entry / a job), not their own records —
  // there's no field a snooze could write, and "dismiss" would hide a real money leak.
  // Open-only: the fix happens on the timecard / the job's costs tab / the job page.
  time_stray: ["open"],
  job_unbilled_work: ["open"],
  job_needs_return: ["open"],
  // The buy/check-off lives on the job's materials list (purchased toggles per item) —
  // a row-level "do" here couldn't say WHICH items got bought.
  materials_needed: ["open"],
};

/**
 * THE universal ordering rule, applied in one place so every surface inherits
 * it: not-done before done ("checked boxes go to the bottom"), then by urgency
 * (high first), then soonest scheduled time first (undated last). Stable.
 */
export function sortActionItems(items: ActionItem[]): ActionItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      if (a.it.done !== b.it.done) return a.it.done ? 1 : -1;
      if (a.it.urgency !== b.it.urgency) return b.it.urgency - a.it.urgency;
      const aw = a.it.when ? Date.parse(a.it.when) : Infinity;
      const bw = b.it.when ? Date.parse(b.it.when) : Infinity;
      if (aw !== bw) return aw - bw;
      return a.i - b.i; // stable
    })
    .map(({ it }) => it);
}
