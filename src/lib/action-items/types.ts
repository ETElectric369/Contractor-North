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
// tasks live on the job's Tasks chip and a person's Reminders on My Day's Tasks & Reminders (0358).
// The old task/work_order kinds and their Convert sheet are gone (Wave 1, W1-16);
// the registry keeps task.* and inquiry.convert for Nort. North's own bug reports
// are not a company's decision either: they live on Bug Watch with its own count.
// Door labels ("Everything else · N", "Office · N") are browse affordances, not
// badges — grey inventory only.
//
// ── TWO LISTS, ONE BUILD (Wave 1, NY-list) ──
// Erik stopped opening My Day: Needs You was "stockpiled with things i cant act on or already have
// on hold". One build hands back two lists from one read: NOW, what he can act on today (the badge
// is its length, a pile counting one), and WAITING, everything waiting on someone else or on a day,
// each with why and the day it comes back (the grey "Waiting (N)" fold, never a badge). Nothing
// waits without a day (waitingRow), and a hold never hides money or a legal clock.
//
// ── TWO LISTS, ONE BUILD (Wave 1, NY-list) ──
// Erik: Needs You is "stockpiled with things i cant act on or already have on hold". So the build
// hands back two lists from one read: NOW (what he can act on today; the badge is its length) and
// WAITING (everything waiting on someone else or on a day, each with the day it comes back: the
// "Waiting (N)" fold under the card, never a badge). Nothing waits without a day (waitingRow).

import type { SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";

export type ActionKind =
  | "job_to_schedule" // a job with nothing ahead of it: no day, no segment, no visit, nobody on it (Jobs Needing A Day)
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
  | "materials_needed" // unpurchased take-off items on a job the crew is about to stand on (buy before the truck rolls)
  | "job_on_hold" // a held job whose day has come (hold_until today or earlier, or no day at all): a Reminder, with its reason
  | "stock_short" // pieces taken from stock past what the shelf showed ($0, billing nothing) — Settle until settled or undone
  // ── "Hey you, here's a bill, what's it for?" (Bills plan, Wave A) ──
  // ONE rolled-up item ("Supplier Bills · 11") carrying a card per supplier paper that needs a
  // person. A rollup, never one item per paper: that is how it badges +1 (the invariant above).
  | "supplier_paper"
  // "Pay CED $5,174.62 By Oct 10 · Saves $35.50 on 7 invoices": one per supplier account whose own
  // open documents carry a live prompt-pay discount due within two weeks. Dated by that deadline and
  // gone once it passes (supplier-pay-due.ts), so it badges honestly: a decision with an expiry.
  | "supplier_pay"
  // A receipt or bill photo on a job that no bill, supplier document or petty cash accounts for (a
  // crew member's photo from Snap Or Note, or a staff snap whose read failed): lib/job-photos' own rule.
  | "receipt_unbilled";

/** The four urgency streams, in the order Needs You is sorted: money first (chase the dollars), then
 *  fresh leads, then today's work, then everything else. No headers are drawn for them any more
 *  (Wave 1, W1-15: one flat list of plain chips); the rank is the sort's first key after "done".
 *  The last is `other`, and it sorts last. It is not the Waiting fold: the fold is a second list (the
 *  things waiting on someone else, each with the day it comes back), not a rank of this one. */
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
  materials_needed: "today", // the shopping run happens before the truck rolls — today's prep
  job_on_hold: "other", // paused, waiting on something (material/task/customer) — the "did we forget this?" clock
  // A short costs the job $0 and bills nothing until the office files the roll and settles it:
  // dollars leaking off the invoice, the same species as job_unbilled_work.
  stock_short: "money",
  supplier_paper: "money", // a supplier bill on no job is a cost no job is carrying: money
  supplier_pay: "money", // a discount that expires unless he pays: money
  receipt_unbilled: "money", // a cost on a job nobody recorded: the invoice can't bill what isn't on the books
};

/** The canonical verbs. Each (kind, verb) a row can send maps to a registry action (dispatch-map.ts). */
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
  /**
   * A PILE (Wave 1, W1-14): two or more open rows of one kind, rolled into this one row (piles.ts
   * rollUpPiles). Its id is `pile:<name>`, it only opens (no verb is ever sent against it), and it
   * counts 1 on the badge. `children` are the rows it holds, in the build's order.
   */
  pile?: PileInfo;
  children?: ActionItem[];
  /** When this began waiting (yyyy-mm-dd or ISO), for a pile's pips: never drawn as a deadline. */
  since?: string | null;
  /** Staff only: the money on the row, for a pile's "$2,340 across 4". Never set on a tech's row. */
  amount?: number | null;
  /** quote_draft only (staff): what the Send sheet names before it sends (lane 4's SendSheet). */
  send?: SendFacts | null;
  /** job_on_hold only: the reason already saved on the hold. Its Snooze asks why only when none is. */
  holdReason?: string | null;
  /** An endless row a Snooze can park (needs_you_waits, 0367): its stable key. Absent: no Snooze. */
  waitKey?: string | null;
  /** The record a verb writes when it isn't this row's own id: a won estimate's JOB gets the day. */
  targetId?: string | null;
  /** organize only: where it is sorted (the /bills tray, Organize, or a bank download's own card). */
  paper?: "tray" | "organize" | "bank";
  /** supplier_pay only: who gets paid, for its "Pay <Supplier>" button. */
  payee?: string | null;
  /** materials_needed only: how many lines are still open to buy, for "Buy Materials · N open". */
  openToBuy?: number | null;
}

/** What the Send sheet needs to name before an estimate goes (who, how much, how many lines). */
export interface SendFacts {
  kind: "quote" | "invoice";
  id: string;
  number: string | null;
  customerName: string | null;
  amount: number | null;
  lineCount: number | null;
  /** Open It First: the document, to look at before it goes. */
  openHref: string;
}

/** The piles rollUpPiles makes (piles.ts has their words and doors). */
export type PileName =
  | "estimates_not_sent"
  | "no_answer_yet"
  | "won_needs_a_day"
  | "late_invoices"
  | "invoices_not_sent"
  | "done_not_billed"
  | "leads_to_call"
  | "visits_to_close_out"
  | "walkthroughs_to_write_up"
  | "jobs_needing_a_day"
  | "holds_back"
  | "papers_to_sort"
  | "notes_to_review"
  | "receipts_not_on_a_bill"
  | "stock_to_settle"
  | "materials_to_buy"
  | "contracts_not_signed"
  | "lien_deadlines";

export interface PileInfo {
  name: PileName;
  /** The pile's words without its count: "Estimates Not Sent". */
  label: string;
  /** How many: a real count (the read's exact count, or the rows that passed). */
  count: number;
  /** The read hit its cap: the count is "at least" ("50+"), and See All opens the list page. */
  capped: boolean;
  /** The pile's list page, when it has one. */
  listHref: string | null;
  /** "See All On Estimates": the link that stands in for the unfold when not every row is here. */
  listLabel: string | null;
  /** The pile's verb, the words on its button (it opens the pile): "Send It". */
  verb: string;
}

/**
 * A ROW IN THE WAITING FOLD (Wave 1, NY-list): something waiting on someone else or on a day,
 * with WHY and THE DAY IT COMES BACK. `backOn` is required: nothing goes quiet without a day (Erik:
 * "too quiet gets things lost"). Built only through waitingRow, which refuses a row with no day, so a
 * row with no day stays on Needs You instead of disappearing into the fold.
 */
export interface WaitingItem {
  id: string;
  kind: ActionKind;
  title: string;
  why: string;
  /** The company's day it comes back, yyyy-mm-dd. */
  backOn: string;
  href: string;
}

/** The two lists one build hands back: Now (the badge is its length) and Waiting (the fold). */
export interface NeedsYou {
  now: ActionItem[];
  waiting: WaitingItem[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A Waiting row, or null when it has no real day: then it is not folded (it stays a Now row). */
export function waitingRow(w: Omit<WaitingItem, "backOn"> & { backOn: string | null | undefined }): WaitingItem | null {
  const day = String(w.backOn ?? "").slice(0, 10);
  if (!YMD.test(day) || !Number.isFinite(Date.parse(`${day}T12:00:00Z`))) return null;
  return { id: w.id, kind: w.kind, title: w.title, why: w.why.trim() || "Waiting", backOn: day, href: w.href };
}

/**
 * WHAT A TECH'S WAITING LIST MAY HOLD. Every money feeder is staff-only, so a tech's fold is empty
 * today; this is the belt to that: no money kind, and no dollar figure in any title, ever reaches a
 * tech's page ("techs never see prices").
 */
export function waitingForViewer(rows: WaitingItem[], isStaff: boolean): WaitingItem[] {
  if (isStaff) return rows;
  return rows.filter((w) => KIND_STREAM[w.kind] !== "money" && !/\$/.test(w.title) && !/\$/.test(w.why));
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
  // Deliberately NOT "No Costs Yet" (job_unbilled_work = nothing captured yet);
  // this one means items ARE on the take-off and still need buying.
  materials_needed: { label: "To Buy", tone: "blue" },
  // Only a hold whose day has come is a Now row (a later one waits in the fold): it is a reminder.
  job_on_hold: { label: "Reminder", tone: "amber" },
  stock_short: { label: "To Settle", tone: "amber" },
  supplier_paper: { label: "To File", tone: "amber" },
  supplier_pay: { label: "Discount Ends", tone: "green" },
  receipt_unbilled: { label: "Not On A Bill", tone: "amber" },
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

// The affordance matrix — which verbs each kind CAN take. THE contract: the row table
// (row-buttons.ts) only ever sends one of these, and dispatch-map.ts resolves every one to a
// registry action (dispatch.test.ts walks the whole table). A few are added or taken off per row by
// the build, by what the database can hold: "snooze" on an endless row only while needs_you_waits
// (0367) is there, on a hold or an estimate's follow-up only while 0366's day is; "schedule" on a
// win only when the estimate has a job to put the day on.
export const AFFORDANCES: Record<ActionKind, Affordance[]> = {
  // Pick A Day (schedule), ⋯ Assign (assign), Finish (do: job.finish), Cancel (dismiss: cancelled).
  job_to_schedule: ["schedule", "assign", "do", "dismiss", "open"],
  // NO convert verb: that sheet was the pre-0230 five-target grammar, and for a JOB-tagged lead
  // it booked a job-TYPED APPOINTMENT (bypassing the designation-does-the-converting law, which
  // only day-carrying doors reach). The lead row and the rail carry the real flow; open lands there.
  // Called (do), Snooze (the day only: inquiry.snooze, never a contact), Lost (inquiry.markLost,
  // kept with status lost, never deleted).
  inquiry: ["do", "snooze", "dismiss", "open"],
  // Close Out (do), ⋯ Didn't Happen (dismiss). A tech's row only opens (appointmentAffordances).
  appointment: ["do", "dismiss", "open"],
  // The href opens the estimate builder prefilled with the walk-through — still the main road.
  // "dismiss" is the OTHER honest ending (0205): most bids lose, and until this verb existed
  // a lost walk-through could never leave the inbox at all (Erik's Donner Pass). It writes a real
  // field — appointments.outcome — never a hidden "I clicked this away" flag.
  inspection_writeup: ["dismiss", "open"],
  // Sort It / File It open their page; ⋯ Set Aside puts it in the Archive (Back undoes it there).
  organize: ["dismiss", "open"],
  // Money/legal items drill into their own surface to act (record a payment, serve a
  // notice, chase a signature) — no generic "do"/"dismiss" that would mislabel them.
  invoice_overdue: ["open"],
  // Still Waiting (snooze) sets the FOLLOW-UP day (0366 quotes.follow_up_at), never valid_until,
  // which is the customer's offer window on the public share. Lost (dismiss) marks it declined, the
  // same decision the quote page's status dropdown makes, one tap closer.
  quote_awaiting: ["snooze", "dismiss", "open"],
  // Pick A Day lands on the won JOB (schedule, added by the build only when the estimate has one).
  quote_accepted: ["open"],
  // ⋯ Set Aside Until… (snooze: invoice.setAside, a day and an optional reason). Send It opens it.
  invoice_draft: ["snooze", "open"],
  // DERIVED rows whose ids are prefixed composites (unbilled-<visit>, jdone-<job>). Their dismiss
  // once matched ZERO rows (a silent 204 dressed as done); dispatch-map strips the prefix now, so
  // ⋯ Cancel writes the real record (the visit, or the job).
  visit_unbilled: ["dismiss", "open"],
  // Send It is the Send sheet (emailQuote / textQuote, never a verb here); ⋯ Not Needed marks the
  // estimate declined (qdraft-<quote>, prefix stripped).
  quote_draft: ["dismiss", "open"],
  lien_deadline: ["open"],
  contract_unsigned: ["open"],
  // Detector findings are DERIVED rows (a time entry / a job), not their own records, and a money
  // leak is never dismissed. An ENDLESS one (No Costs Yet on a labor-only job, To Buy while a part is
  // back-ordered) gets a Snooze that picks a day (needs_you_waits, 0367): the build adds it.
  time_stray: ["open"],
  job_unbilled_work: ["open"],
  // The buy/check-off lives on the job's materials list (purchased toggles per item) —
  // a row-level "do" here couldn't say WHICH items got bought.
  materials_needed: ["open"],
  // A hold whose day has come: Snooze (job.snoozeHold, another day) and Take Off Hold (do:
  // job.takeOffHold), both on the row. The build takes them off while 0366 isn't on the database.
  job_on_hold: ["snooze", "do", "open"],
  // Settled on Shop Stock (Settle From Stock once a roll is there, or Undo the take). Derived from
  // the stock's own record, so there is nothing a dismiss could write: it stays until settled.
  stock_short: ["open"],
  // Open-only in the verb grammar: the decision is on the cards INSIDE the rollup, each of which
  // calls fileSupplierPaper itself (Put It On J-011 / Another Job / Shop Stock / Business Cost).
  // The rollup id is synthetic, so no generic verb could name which paper it meant.
  supplier_paper: ["open"],
  // Open-only: the door is the Record A Payment sheet on /bills (?pay=<account>). Nothing to
  // dismiss: it is derived from the supplier's documents and goes when the discount does.
  supplier_pay: ["open"],
  // Record It opens the job's Costs tab, where Record As Cost is: the one answer it has.
  receipt_unbilled: ["open"],
};

/**
 * NEEDS YOU'S ONE ORDER (Wave 1, NY-list), applied ONCE, inside the build, before the list leaves the
 * server: every surface reading the list reads it in the same order, and a pile (piles.ts) takes the
 * place its most pressing row would have had.
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
