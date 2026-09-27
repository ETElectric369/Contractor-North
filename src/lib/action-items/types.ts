// The unified "actionable item" model — the action-layer twin of <ModalActions>.
// Every surface (jobs to schedule, inquiries, appointments, captures to file,
// money/legal clocks, leak detectors) projects onto ONE shape with ONE set of
// canonical verbs, so a single list component and a single voice registry can
// act on all of them. On My Day it is Needs You.
//
// ── THE BADGE INVARIANT (the law; enforced by tests/badge-economy.test.ts) ──
// A NUMBER on chrome = distinct items needing a HUMAN DECISION TODAY that the
// app cannot defer, shown where the deciding happens, display-capped at 9+.
// No count may be the length of an unbounded or undated set — every counted
// item carries an expiry: a date, a bounded window, or a rollup.
//
// Chores never badge; decisions badge. TASKS AND REMINDERS ARE NEVER HERE: a job's
// tasks live on the job's Tasks chip and a person's Reminders in Today's 6 (0358).
// The old task/work_order kinds and their Convert sheet are gone (Wave 1, W1-16);
// the registry keeps task.* and inquiry.convert for Nort. North's own bug reports
// are not a company's decision either: they live on Bug Watch with its own count.
// Door labels ("Everything else · N", "Office · N") are browse affordances, not
// badges — grey inventory only.

import type { SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";

export type ActionKind =
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
  // ── The end-of-day money-leak sweep (the "Apache Ct" detectors) ──
  | "time_stray" // a time entry left running past its day, or closed with no job — hours nobody can bill
  | "job_unbilled_work" // a job worked recently with ZERO costs/materials recorded (the 30'-of-Romex leak)
  | "job_needs_return" // a job worked recently with nothing scheduled next (the forgotten return visit)
  | "materials_needed" // unpurchased take-off items on a job the crew is about to stand on (buy before the truck rolls)
  | "job_on_hold" // a job PAUSED too long — surfaced WITH its blocker (open task / materials not ordered) so it isn't forgotten
  | "stock_short" // pieces taken from stock past what the shelf showed ($0, billing nothing) — Settle until settled or undone
  // ── "Hey you, here's a bill, what's it for?" (Bills plan, Wave A) ──
  // ONE rolled-up item ("Supplier Bills · 11") carrying a card per supplier paper that needs a
  // person. A rollup, never one item per paper: that is how it badges +1 (the invariant above).
  | "supplier_paper"
  // "Pay CED $5,174.62 By Oct 10 · Saves $35.50 on 7 invoices": one per supplier account whose own
  // open documents carry a live prompt-pay discount due within two weeks. Dated by that deadline and
  // gone once it passes (supplier-pay-due.ts), so it badges honestly: a decision with an expiry.
  | "supplier_pay";

/** The four urgency streams, in the order Needs You is sorted: money first (chase the dollars), then
 *  fresh leads, then today's work, then everything else. No headers are drawn for them any more
 *  (Wave 1, W1-15: one flat list of plain chips); the rank is the sort's first key after "done".
 *  The last is `other`, not `waiting`: the Waiting fold (the things waiting on someone else, each
 *  with the day it comes back) arrives next, and it is a different thing from this rank. */
export type Stream = "money" | "leads" | "today" | "other";

export const STREAM_ORDER: Stream[] = ["money", "leads", "today", "other"];

/** Which stream each kind belongs to — assigned per-kind in ONE place so the
 *  inbox and any digest/summary surface can never disagree. */
export const KIND_STREAM: Record<ActionKind, Stream> = {
  job_to_schedule: "today",
  inquiry: "leads",
  appointment: "today",
  // Erik: "all the inspections i've completed ... already happened and need to be actioned for
  // estimates." Same species as invoice_draft — the work is done and nobody has asked for the
  // money yet — so it belongs in the money stream, not on the calendar it already left.
  inspection_writeup: "money",
  organize: "other",
  invoice_overdue: "money",
  quote_awaiting: "money",
  quote_accepted: "money", // a won deal is the freshest money event — renders at the very top
  invoice_draft: "money",
  visit_unbilled: "money",
  quote_draft: "money",
  lien_deadline: "other", // compliance clock — legal, not A/R
  contract_unsigned: "other",
  time_stray: "today", // a running/orphaned clock is today's cleanup, not tomorrow's
  job_unbilled_work: "money", // uncosted work = dollars leaking off the invoice
  job_needs_return: "today", // the return visit gets scheduled today or it gets forgotten
  materials_needed: "today", // the shopping run happens before the truck rolls — today's prep
  job_on_hold: "other", // paused, waiting on something (material/task/customer) — the "did we forget this?" clock
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
  | "snooze" // defer to a later date
  | "dismiss" // remove from my list (delete / cancel / archive)
  | "open"; // drill into the detail page

export interface ActionItem {
  id: string;
  kind: ActionKind;
  stream: Stream; // urgency stream (money/leads/today/other) — derived from kind via KIND_STREAM
  title: string;
  subtitle?: string | null; // customer / job / vendor line
  who?: string | null; // assignee name
  when?: string | null; // ISO or yyyy-mm-dd (due/follow-up/starts/null)
  urgency: 0 | 1 | 2; // 0 normal · 1 soon/overdue · 2 urgent
  done: boolean; // drives the universal "sinks to the bottom" rule
  href: string; // deep link for Open
  affordances: Affordance[]; // canonical verbs valid for THIS item
  /** THE ROW'S CHIP, when this row's state has its own words (W1-15): "Billed, Not Paid" on a visit
   *  whose invoice is open, "Clock Left Running", "On No Job", "Note To Review", "Bank Download",
   *  "Request" with Leads off. Absent: the kind's own chip (KIND_META). */
  chip?: string;
  /** supplier_paper only: the cards the rollup carries, and the jobs their pickers offer. */
  supplierPapers?: SupplierPaperFeed | null;
  /** inquiry with Leads switched off only (action-items/switches): the number Call Back dials. */
  phone?: string | null;
  /**
   * HOURS ON NO JOB (0357): a closed shift nobody put on a job may have been billed by hand on an
   * invoice with no job (TTUSD on INV-055). When a sent invoice with no job could hold it, the row
   * carries the shifts its Already Billed door ticks to start (the sheet lists every other one).
   * Staff only, like every Already Billed door; absent: no such door.
   */
  noJobHours?: { entryIds: string[] } | null;
}

/**
 * THE CHIP ON EACH ROW (Wave 1, W1-15): plain words, Title Case, saying the STATE the thing is in,
 * never the verb (the row's own button or the page it opens is the verb). One flat list, no section
 * headers, so the chip is what tells a lead from a bill at a glance. A row whose state has words of
 * its own says them instead (ActionItem.chip). The tones are the ones each kind always had.
 */
export const KIND_META: Record<ActionKind, { label: string; tone: "slate" | "blue" | "amber" | "green" }> = {
  job_to_schedule: { label: "Needs A Day", tone: "amber" },
  inquiry: { label: "Lead", tone: "green" },
  appointment: { label: "Not Closed Out", tone: "blue" },
  inspection_writeup: { label: "Needs An Estimate", tone: "green" },
  // Row override: "Billed, Not Paid" when an open invoice anchors the visit (query.ts).
  visit_unbilled: { label: "Done, Not Billed", tone: "green" },
  quote_draft: { label: "Not Sent", tone: "green" },
  // Row overrides: "Note To Review" for a note, "Bank Download" for a bank download (query.ts).
  organize: { label: "Paper To Sort", tone: "slate" },
  invoice_overdue: { label: "Past Due", tone: "amber" },
  quote_awaiting: { label: "No Reply Yet", tone: "green" },
  quote_accepted: { label: "Won", tone: "green" },
  invoice_draft: { label: "Not Sent", tone: "slate" },
  lien_deadline: { label: "Lien Deadline", tone: "amber" },
  contract_unsigned: { label: "Not Signed", tone: "blue" },
  // Hours On No Job and a closed shift on no job; a clock still running says "Clock Left Running".
  time_stray: { label: "On No Job", tone: "amber" },
  job_unbilled_work: { label: "No Costs Yet", tone: "amber" },
  job_needs_return: { label: "Needs A Day", tone: "blue" },
  // Deliberately NOT "No Costs Yet" (job_unbilled_work = nothing captured yet);
  // this one means items ARE on the take-off and still need buying.
  materials_needed: { label: "To Buy", tone: "blue" },
  job_on_hold: { label: "On Hold", tone: "amber" },
  stock_short: { label: "To Settle", tone: "amber" },
  supplier_paper: { label: "To File", tone: "amber" },
  supplier_pay: { label: "Discount Ends", tone: "green" },
};

/** The words on a row's chip: its own, else its kind's. */
export function chipOf(item: Pick<ActionItem, "kind" | "chip">): string {
  return item.chip ?? KIND_META[item.kind].label;
}

/** A TECH'S APPOINTMENT ROW OPENS, NOTHING MORE (Wave 0). Done and Delete dispatch to
 *  appointment.setStatus, which is staff-only, so on a tech's row they were doors that only
 *  refused. The appointment page itself is his to read. */
export function appointmentAffordances(isStaff: boolean): Affordance[] {
  return isStaff ? AFFORDANCES.appointment : ["open"];
}

// The affordance matrix — which verbs each kind exposes. THE contract, consumed
// by both the UI (<ActionList>) and (later) the voice registry.
export const AFFORDANCES: Record<ActionKind, Affordance[]> = {
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
 * NEEDS YOU'S ONE ORDER (Wave 1, NY-list), applied ONCE, inside the build, before the list leaves the
 * server: so the planner's top five are the right five, and every surface reading the list reads it
 * in the same order.
 *   1. not done before done ("checked boxes go to the bottom");
 *   2. the stream: money, then leads, then today, then other (a money row with urgency 0 is above a
 *      today row with urgency 2: the dollars come first);
 *   3. urgency, high first;
 *   4. when, oldest first. A row with no date counts as TODAY (not as last): a rollup like Supplier
 *      Bills or Hours On No Job is today's business, never pushed below a row dated tomorrow.
 * Ties keep the build's own order (a stable sort), so the rows the build places on purpose (Supplier
 * Bills, Pay <Supplier>, Hours On No Job) stay where it put them among their equals. `todayStr` is the
 * company's today (YYYY-MM-DD).
 */
export function sortActionItems<T extends Pick<ActionItem, "done" | "urgency" | "when" | "kind"> & { stream?: Stream }>(
  items: T[],
  todayStr: string,
): T[] {
  const today = Date.parse(`${todayStr}T00:00:00Z`);
  const whenMs = (w: string | null | undefined) => {
    const t = w ? Date.parse(w) : NaN;
    return Number.isFinite(t) ? t : today;
  };
  const rank = (it: T) => STREAM_ORDER.indexOf(it.stream ?? KIND_STREAM[it.kind]);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      if (a.it.done !== b.it.done) return a.it.done ? 1 : -1;
      const ra = rank(a.it);
      const rb = rank(b.it);
      if (ra !== rb) return ra - rb;
      if (a.it.urgency !== b.it.urgency) return b.it.urgency - a.it.urgency;
      const wa = whenMs(a.it.when);
      const wb = whenMs(b.it.when);
      if (wa !== wb) return wa - wb;
      return a.i - b.i; // stable: the build's own order
    })
    .map(({ it }) => it);
}
