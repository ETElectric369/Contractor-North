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

import type { SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";

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
  | "inspection_writeup" // a walk-through that HAPPENED and has no estimate yet — the visit is spent, the money is not
  | "organize" // a capture (receipt/note/doc) needing a filing decision
  | "invoice_overdue" // a sent/partial invoice past its due date (A/R)
  | "quote_awaiting" // a sent quote/estimate gone quiet or nearing its valid-until
  | "quote_accepted" // an estimate the customer just ACCEPTED — schedule the job now (the win)
  | "invoice_draft" // a draft invoice never sent (billed-up money sitting in limbo)
  | "visit_unbilled" // a service call / job-day that HAPPENED and has no invoice — the Nora hole
  | "quote_draft" // an estimate started and never sent — the lead it converted is invisible behind it
  | "lien_deadline" // a lien prelim/recording deadline coming due or past
  | "contract_unsigned" // a contract sent but not yet signed
  | "bug_report" // an open bug reported from the field (owner watch)
  // ── The end-of-day money-leak sweep (the "Apache Ct" detectors) ──
  | "time_stray" // a time entry left running past its day, or closed with no job — hours nobody can bill
  | "job_unbilled_work" // a job worked recently with ZERO costs/materials recorded (the 30'-of-Romex leak)
  | "job_needs_return" // a job worked recently with nothing scheduled next (the forgotten return visit)
  | "materials_needed" // unpurchased take-off items on a job the crew is about to stand on (buy before the truck rolls)
  | "job_on_hold" // a job PAUSED too long — surfaced WITH its blocker (open task / materials not ordered) so it isn't forgotten
  | "stock_short" // pieces taken from stock past what the shelf showed ($0, billing nothing) — Recount until settled or undone
  // ── "Hey you, here's a bill, what's it for?" (Bills plan, Wave A) ──
  // ONE rolled-up item ("Supplier Bills · 11") carrying a card per supplier paper that needs a
  // person. A rollup, never one item per paper: that is how it badges +1 (the invariant above).
  | "supplier_paper"
  // "Pay CED $5,174.62 By Oct 10 · Saves $35.50 on 7 invoices": one per supplier account whose own
  // open documents carry a live prompt-pay discount due within two weeks. Dated by that deadline and
  // gone once it passes (supplier-pay-due.ts), so it badges honestly: a decision with an expiry.
  | "supplier_pay";

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
  // Erik: "all the inspections i've completed ... already happened and need to be actioned for
  // estimates." Same species as invoice_draft — the work is done and nobody has asked for the
  // money yet — so it belongs in the money stream, not on the calendar it already left.
  inspection_writeup: "money",
  organize: "waiting",
  invoice_overdue: "money",
  quote_awaiting: "money",
  quote_accepted: "money", // a won deal is the freshest money event — renders at the very top
  invoice_draft: "money",
  visit_unbilled: "money",
  quote_draft: "money",
  lien_deadline: "waiting", // compliance clock — legal, not A/R
  contract_unsigned: "waiting",
  bug_report: "waiting",
  time_stray: "today", // a running/orphaned clock is today's cleanup, not tomorrow's
  job_unbilled_work: "money", // uncosted work = dollars leaking off the invoice
  job_needs_return: "today", // the return visit gets scheduled today or it gets forgotten
  materials_needed: "today", // the shopping run happens before the truck rolls — today's prep
  job_on_hold: "waiting", // paused, waiting on something (material/task/customer) — the "did we forget this?" clock
  // A short costs the job $0 and bills nothing until the office files the roll and settles it:
  // dollars leaking off the invoice, the same species as job_unbilled_work.
  stock_short: "money",
  supplier_paper: "money", // a supplier bill on no job is a cost no job is carrying: money
  supplier_pay: "money", // a discount that expires unless he pays: money
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
  /** supplier_paper only: the cards the rollup carries, and the jobs their pickers offer. */
  supplierPapers?: SupplierPaperFeed | null;
}

export const KIND_META: Record<ActionKind, { label: string; tone: "slate" | "blue" | "amber" | "green" }> = {
  task: { label: "Task", tone: "slate" },
  work_order: { label: "Job task", tone: "blue" },
  job_to_schedule: { label: "To schedule", tone: "amber" },
  inquiry: { label: "Lead", tone: "green" },
  appointment: { label: "Appointment", tone: "blue" },
  inspection_writeup: { label: "Write up the estimate", tone: "green" },
  visit_unbilled: { label: "Done & paid?", tone: "green" },
  quote_draft: { label: "Finish or send it", tone: "green" },
  organize: { label: "To file", tone: "slate" },
  invoice_overdue: { label: "Overdue invoice", tone: "amber" },
  quote_awaiting: { label: "Awaiting reply", tone: "green" },
  quote_accepted: { label: "Accepted — schedule it", tone: "green" },
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
  job_on_hold: { label: "On hold", tone: "amber" },
  stock_short: { label: "Recount", tone: "amber" },
  supplier_paper: { label: "Supplier Bills", tone: "amber" },
  supplier_pay: { label: "Discount", tone: "green" },
};

// The affordance matrix — which verbs each kind exposes. THE contract, consumed
// by both the UI (<ActionList>) and (later) the voice registry. (Assign/Convert
// land in a follow-up step with inline pickers.)
export const AFFORDANCES: Record<ActionKind, Affordance[]> = {
  task: ["do", "schedule", "assign", "snooze", "dismiss", "open"],
  work_order: ["do", "schedule", "assign", "dismiss", "open"],
  job_to_schedule: ["schedule", "assign", "open"],
  // NO convert verb: that sheet was the pre-0230 five-target grammar, and for a JOB-tagged lead
  // it booked a job-TYPED APPOINTMENT (bypassing the designation-does-the-converting law, which
  // only day-carrying doors reach). The lead row and the rail carry the real flow; open lands there.
  inquiry: ["do", "schedule", "snooze", "dismiss", "open"],
  appointment: ["do", "dismiss", "open"],
  // The href opens the estimate builder prefilled with the walk-through — still the main road.
  // "dismiss" is now the OTHER honest ending (0205): most bids lose, and until this verb existed
  // a lost walk-through could never leave the inbox at all (Erik's Donner Pass). It writes a real
  // field — appointments.outcome — never a hidden "I clicked this away" flag.
  inspection_writeup: ["dismiss", "open"],
  organize: ["dismiss", "open"],
  // Money/legal items drill into their own surface to act (record a payment, serve a
  // notice, chase a signature) — no generic "do"/"dismiss" that would mislabel them.
  invoice_overdue: ["open"],
  // No snooze on quotes: valid_until is the CUSTOMER-facing offer window (it's on the
  // public share), so bumping it would change the offer, not defer the reminder. But LOSING
  // a bid is a real outcome the app had no word for — "dismiss" marks the estimate declined,
  // which is the same decision the quote page's status dropdown makes, one tap closer.
  quote_awaiting: ["dismiss", "open"],
  // Open-only: tapping lands on the JOB, where the inline schedule editor sets the date
  // (which self-clears this item). A dedicated "schedule" verb comes with the funnel wave.
  quote_accepted: ["open"],
  invoice_draft: ["open"],
  // Open-only: these are DERIVED rows whose ids are prefixed composites, so the dismiss verb's
  // write (appointments.outcome / quote declined, keyed by raw id) matched ZERO rows — a silent 204
  // dressed as "dismissed" that resurrected on the next load. The honest endings live on the
  // surfaces: Pay now / delete the draft. A real dismiss can come back once it writes a real field.
  visit_unbilled: ["open"],
  quote_draft: ["open"],
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
  // Open the job to resume it, change status, or clear the blocker (like the other derived
  // job detectors — the decision happens on the job page, so it nags until actually acted on).
  job_on_hold: ["open"],
  // Settled on Shop Stock (Settle From The Shelf once a roll is on it, or Undo the take). Derived
  // from the shelf's own record, so there is nothing a dismiss could write: it stays until settled.
  stock_short: ["open"],
  // Open-only in the verb grammar: the decision is on the cards INSIDE the rollup, each of which
  // calls fileSupplierPaper itself (Put It On J-011 / Another Job / Shop Stock / Business Cost).
  // The rollup id is synthetic, so no generic verb could name which paper it meant.
  supplier_paper: ["open"],
  // Open-only: the door is the Record A Payment sheet on /bills (?pay=<account>). Nothing to
  // dismiss: it is derived from the supplier's documents and goes when the discount does.
  supplier_pay: ["open"],
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
