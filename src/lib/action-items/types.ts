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

import type { SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";
import { GROUP_ORDER, KIND_GROUP, isUnreadLine } from "./needs-you-rule";

export type ActionKind =
  | "job_to_schedule" // a job with nothing ahead of it: no day, no segment, no visit, nobody on it (Jobs Needing a Day)
  | "inquiry" // a new/uncontacted lead
  | "appointment" // a scheduled appt awaiting completion
  | "inspection_writeup" // an inspection that HAPPENED and has no estimate yet — the visit is spent, the money is not
  | "organize" // a capture (receipt/note/doc) needing a filing decision
  | "invoice_overdue" // a sent/partial invoice past its due date (A/R)
  | "quote_awaiting" // a sent quote/estimate gone quiet or nearing its valid-until
  | "quote_accepted" // an estimate the customer just ACCEPTED — schedule the job now (the win)
  | "invoice_draft" // a draft invoice never sent (billed-up money sitting in limbo)
  | "visit_unbilled" // a service call / job-day that HAPPENED and has no invoice — the Nora hole
  | "quote_draft" // an estimate started and never sent — the lead it converted is invisible behind it
  | "lien_deadline" // a lien prelim/recording deadline coming due or past
  | "contract_unsigned" // a contract sent but not yet signed
  // ── The end-of-day money-leak sweep (the "Acacia Ct" detectors) ──
  | "time_stray" // a time entry left running past its day, or closed with no job — hours nobody can bill
  | "job_unbilled_work" // a job worked recently with ZERO costs/materials recorded (the 30'-of-Romex leak)
  | "materials_needed" // unpurchased take-off items on a job the crew is about to stand on (buy before the truck rolls)
  | "job_on_hold" // a held job whose day has come (hold_until today or earlier, or no day at all): a Reminder, with its reason
  | "stock_short" // pieces taken from stock past what the shelf showed ($0, billing nothing) — Settle until settled or undone
  // ── "Hey you, here's a bill, what's it for?" (Bills plan, Wave A) ──
  // ONE rolled-up item ("Supplier Bills · 11") carrying a card per supplier paper that needs a
  // person. A rollup, never one item per paper: that is how it badges +1 (the invariant above).
  | "supplier_paper"
  // "Pay CED $5,174.62 by Oct 10 · Saves $35.50 on 7 invoices": one per supplier account whose own
  // open documents carry a live prompt-pay discount due within two weeks. Dated by that deadline and
  // gone once it passes (supplier-pay-due.ts), so it badges honestly: a decision with an expiry.
  | "supplier_pay"
  // A receipt or bill photo on a job that no bill, supplier document or petty cash accounts for (a
  // crew member's photo from Snap or Note, or a staff snap whose read failed): lib/job-photos' own rule.
  | "receipt_unbilled"
  // A PERMIT STILL WAITING ON AN INSPECTION (0378): one row per permit, never one per visit, and only
  // where the next visit is HIS — to phone for, or to write up. One still waiting on the authority in
  // front of it is in no pile at all (permit-inspection-items has the gate's whole story).
  | "permit_inspection";

/** THE FOUR TILES of Needs You (the redraw, 2026-11): Get Paid, Sales, Operations, Bookkeeping.
 *  Each kind sits in exactly one (needs-you-rule.ts KIND_GROUP), and the build stamps it once.
 *  It is not the Waiting fold: the fold is a second list, not a tile. */
export type Group = "get_paid" | "win_work" | "run_jobs" | "keep_books";

/** A row's mark: NOW (act today, the strip), SOON (a real day is close or has just passed), or none.
 *  On screen SOON is said "Due" (the owner's word, 2026-11-11); the id is never shown and did not follow. */
export type Level = "now" | "soon" | "none";

/**
 * WORDS THE SERVER NAMES AND NEVER WRITES: a catalog key and its slots, said in the viewer's language
 * by the list. Slots: `day` and `day2` are said as days, `money` and `money2` as currency, `type` as
 * the visit type's label, a slot ending in `Key` is another key; `tail` is data only, drawn after it.
 */
export type Say = { key: string; vars?: Record<string, string | number | null>; tail?: string | null };

export { GROUP_ORDER, KIND_GROUP } from "./needs-you-rule";

/**
 * WHAT A ROW'S `when` IS (cn-v1069 follow-up; Erik on an inspection he finished the day before:
 * "1d overdue"?). Two different facts ride the one field: a DEADLINE (a follow-up day, a due date, a
 * lien clock, the day the crew stands on the job) — past it the row is overdue — or the DAY IT
 * HAPPENED (an inspection done, a visit over, a shift closed, a paper that arrived) — past it the row
 * has simply been sitting, and the list says "2d ago", never "overdue". Exhaustive on purpose: a new
 * kind does not compile until somebody says which its day is.
 */
export const WHEN_IS_A_DEADLINE: Record<ActionKind, boolean> = {
  job_to_schedule: true, // its scheduled day
  inquiry: true, // the follow-up day
  appointment: false, // the visit's own day: over, not overdue
  inspection_writeup: false, // the day the inspection happened
  organize: false, // the day the paper arrived
  invoice_overdue: true, // the due date
  quote_awaiting: true, // valid-until / the follow-up day
  quote_accepted: false, // the day they said yes
  invoice_draft: false, // the day it was started
  visit_unbilled: false, // the day the work happened
  quote_draft: false, // the day it was started
  lien_deadline: true, // the clock
  contract_unsigned: false, // the day it was sent
  time_stray: false, // the day of the shift
  job_unbilled_work: false, // the day last worked
  materials_needed: true, // the day the crew stands on it
  job_on_hold: true, // the day the hold said
  stock_short: false, // the day of the take
  supplier_paper: false, // undated
  supplier_pay: true, // the discount's last day
  receipt_unbilled: false, // the day of the photo
  permit_inspection: true, // the booked day
};

/** The canonical verbs. Each (kind, verb) a row can send maps to a registry action (dispatch-map.ts). */
export type Affordance =
  | "do" // mark complete / contacted
  | "schedule" // put on the calendar / pick a date
  | "assign" // give to a person
  | "snooze" // defer to a later date
  | "dismiss" // remove from my list (delete / cancel / archive)
  | "wontHappen" // the visit page's Won't Happen, from a row's ⋯ (added per row, only while the visit is not completed)
  | "notACost" // a receipt row's ⋯ Not a Cost: the paper is filed under that name (the job's paper list's own category edit)
  | "open"; // drill into the detail page

export interface ActionItem {
  id: string;
  kind: ActionKind;
  /** Its tile, stamped once by the build from KIND_GROUP (needs-you-rule.ts). */
  group: Group;
  /** Its mark, stamped once by the build (needs-you-rule.ts levelOf). Absent reads as none. */
  level?: Level;
  title: string;
  subtitle?: string | null; // customer / job / vendor line
  /** Who or which job the row is about, drawn first in bold. Absent: the title. */
  who?: string | null;
  /** The lead as words, when there is no name to draw: a rollup, a Couldn't Check line, a bank download. */
  whoSay?: Say;
  /** The plain phrase under the lead. Absent: the subtitle. */
  what?: Say;
  when?: string | null; // ISO or yyyy-mm-dd (due/follow-up/starts/null)
  /** THE ROW'S REAL CLOCK (cn-v1162): a day by which its own action is due, one somebody set or an
   *  outside party set (a follow-up day, an offer's last day, a come-back day, the crew's day, the day
   *  a new lead came in), never the day the office's own paper was born. ISO or yyyy-mm-dd. Null or absent: it has none, and it is never marked
   *  amber. Read only by the one rule (needs-you-rule levelOf); never sorted on, never said. */
  clock?: string | null;
  urgency: 0 | 1 | 2; // 0 normal · 1 soon/overdue · 2 urgent
  done: boolean; // drives the universal "sinks to the bottom" rule
  href: string; // deep link for Open
  affordances: Affordance[]; // canonical verbs valid for THIS item
  /** THE ROW'S CHIP, when this row's state has its own words (W1-15): "Billed, Not Paid" on a visit
   *  whose invoice is open, "Clock Left Running", "On No Job", "Note to Review", "Bank Download",
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
   * rollUpPiles). Its id is `pile:<name>` (its NOW half `pile:<name>:now`), it only opens (no verb is ever sent against it), and it
   * counts 1 on the badge. `children` are the rows it holds, in the build's order.
   */
  pile?: PileInfo;
  children?: ActionItem[];
  /** When this began waiting (yyyy-mm-dd or ISO): its age words and its place in the order
   *  (sortActionItems), never drawn as a deadline and never a mark (cn-v1162). */
  since?: string | null;
  /** Staff only: the money on the row, or on a pile the sum of its children's (only when every child
   *  has one, the read was not capped and every child is here). Never set on a tech's row. */
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
  /**
   * ALREADY INVOICED (2026-11-04): the work this row asks about was billed on an invoice the app
   * can't tie to it. The ⋯ door opens a sheet of the customer's live invoices; the one picked is
   * tied to the estimate (invoices.quote_id), the job or the visit (lib/action-items/already-invoiced).
   * Staff only; absent: no such door.
   */
  alreadyInvoiced?: AlreadyInvoicedTarget | null;
  /**
   * A DATED AGE (2026-11-04: "140d ago" hid that it was June). The word the row's day is said with:
   * "Accepted Jun 12", "Sent Jun 12", "Started Jul 3" (the year only when it isn't this year).
   * Absent: the relative form (prettyWhen).
   */
  dated?: "Accepted" | "Sent" | "Started" | null;
}

/** What an Already Invoiced door ties a picked invoice to: an estimate, or done work (a job or a visit). */
export type AlreadyInvoicedTarget = { kind: "quote"; id: string } | { kind: "job"; id: string } | { kind: "visit"; id: string };

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
  | "inspections_to_write_up"
  | "jobs_needing_a_day"
  | "holds_back"
  | "papers_to_sort"
  | "notes_to_review"
  | "receipts_not_on_a_bill"
  | "stock_to_settle"
  | "materials_to_buy"
  | "contracts_not_signed"
  | "lien_deadlines"
  | "permit_inspections";

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
  /** "See All on Estimates": the link that stands in for the unfold when not every row is here. */
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
 * today; this is the belt to that: only Operations, and no dollar figure in any title, ever reaches
 * a tech's page ("techs never see prices").
 */
export function waitingForViewer(rows: WaitingItem[], isStaff: boolean): WaitingItem[] {
  if (isStaff) return rows;
  return rows.filter((w) => KIND_GROUP[w.kind] === "run_jobs" && !/\$/.test(w.title) && !/\$/.test(w.why));
}

/**
 * THE CHIP ON EACH ROW (Wave 1, W1-15): plain words, Title Case, saying the STATE the thing is in,
 * never the verb (the row's own button or the page it opens is the verb). One flat list, no section
 * headers, so the chip is what tells a lead from a bill at a glance. A row whose state has words of
 * its own says them instead (ActionItem.chip). The redraw (cn-v1161) draws no chip and no tone (red
 * and amber now mean urgency only, inside the box's one mark). The labels stay: a row's `chip` is a
 * STATE KEY row-buttons.ts and piles.ts branch on, these are its words when it has none of its own,
 * and the follow-up that says them in the reader's language starts here (plan D4).
 */
export const KIND_META: Record<ActionKind, { label: string }> = {
  job_to_schedule: { label: "Needs a Day" },
  inquiry: { label: "Lead" },
  appointment: { label: "Not Closed Out" },
  inspection_writeup: { label: "To Write Up" },
  // Row override: "Billed, Not Paid" when an open invoice anchors the visit (query.ts).
  visit_unbilled: { label: "Done, Not Billed" },
  quote_draft: { label: "Not Sent" },
  // Row overrides: "Note to Review" for a note, "Bank Download" for a bank download (query.ts).
  organize: { label: "Paper to Sort" },
  invoice_overdue: { label: "Past Due" },
  quote_awaiting: { label: "No Reply Yet" },
  quote_accepted: { label: "Won" },
  invoice_draft: { label: "Not Sent" },
  lien_deadline: { label: "Lien Deadline" },
  contract_unsigned: { label: "Not Signed" },
  // Hours on No Job and a closed shift on no job; a clock still running says "Clock Left Running".
  time_stray: { label: "On No Job" },
  job_unbilled_work: { label: "No Costs Yet" },
  // Deliberately NOT "No Costs Yet" (job_unbilled_work = nothing captured yet);
  // this one means items ARE on the take-off and still need buying.
  materials_needed: { label: "To Buy" },
  // Only a hold whose day has come is a Now row (a later one waits in the fold): it is a reminder.
  job_on_hold: { label: "Reminder" },
  stock_short: { label: "To Settle" },
  supplier_paper: { label: "To File" },
  supplier_pay: { label: "Discount Ends" },
  receipt_unbilled: { label: "Not on a Bill" },
  // Row overrides say which: To Book, Not Written Up, Failed, Cancelled (permit-inspection-items).
  permit_inspection: { label: "Permit Inspection" },
};

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
  // Pick a Day (schedule), ⋯ Assign (assign), Finish (do: job.finish), Cancel (dismiss: cancelled).
  job_to_schedule: ["schedule", "assign", "do", "dismiss", "open"],
  // NO convert verb: that sheet was the pre-0230 five-target grammar, and for a JOB-tagged lead
  // it booked a job-TYPED APPOINTMENT (bypassing the designation-does-the-converting law, which
  // only day-carrying doors reach). The lead row and the rail carry the real flow; open lands there.
  // Called (do), Snooze (the day only: inquiry.snooze, never a contact), Lost (inquiry.markLost,
  // kept with status lost, never deleted).
  inquiry: ["do", "snooze", "dismiss", "open"],
  // Close Out (do), ⋯ Didn't Happen (dismiss). A tech's row only opens (appointmentAffordances).
  appointment: ["do", "dismiss", "open"],
  // The href opens THE INSPECTION, the visit's own page (/appointments/<id>), never the estimate
  // builder (cn-v1157: a tap reads or changes the report first; the estimate and the job are chosen
  // from that page). "open" is the row's one button, Open the Inspection.
  // "dismiss" is the OTHER honest ending (0205): most bids lose, and until this verb existed
  // a lost inspection could never leave the inbox at all (Erik's Donner Pass). It writes a real
  // field — appointments.outcome — never a hidden "I clicked this away" flag.
  inspection_writeup: ["dismiss", "open"],
  // Sort It / File It open their page; ⋯ Set Aside puts it in the Archive (Back undoes it there).
  organize: ["dismiss", "open"],
  // Money/legal items drill into their own surface to act (record a payment, serve a
  // notice, chase a signature) — no generic "do"/"dismiss" that would mislabel them.
  invoice_overdue: ["open"],
  // Still Waiting (snooze) sets the FOLLOW-UP day (0366 quotes.follow_up_at), never valid_until,
  // which is the customer's offer window on the public share. ⋯ Won It (do) marks it accepted (the
  // quote page's own Accepted: it stamps the day and makes the job); ⋯ Lost (dismiss) marks it
  // declined, the same decision the quote page's status dropdown makes, one tap closer.
  quote_awaiting: ["snooze", "do", "dismiss", "open"],
  // Pick a Day lands on the won JOB (schedule, added by the build only when the estimate has one).
  // ⋯ Already Invoiced (its own sheet, not a verb) and ⋯ Lost (dismiss: marks it declined).
  quote_accepted: ["dismiss", "open"],
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
  // ⋯ Signed on Paper (do: contract.recordPaperSignature, signed by its customer today).
  contract_unsigned: ["do", "open"],
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
  // Settled on Shop Stock (Settle from Stock once a roll is there, or Undo the take). Derived from
  // the stock's own record, so there is nothing a dismiss could write: it stays until settled.
  stock_short: ["open"],
  // Open-only in the verb grammar: the decision is on the cards INSIDE the rollup, each of which
  // calls fileSupplierPaper itself (Put It on J-011 / Another Job / Shop Stock / Business Cost).
  // The rollup id is synthetic, so no generic verb could name which paper it meant.
  supplier_paper: ["open"],
  // Open-only: the door is the Record a Payment sheet on /bills (?pay=<account>). Nothing to
  // dismiss: it is derived from the supplier's documents and goes when the discount does.
  supplier_pay: ["open"],
  // Record It opens the job's Costs tab, where Record as Cost is. ⋯ Not a Cost (notACost) is the other
  // honest answer: the paper never was a cost (a supplier's quote filed as a Receipt), so it is filed
  // as Not a Cost and stays with the job's papers, the office's alone as the Receipt was. The
  // Couldn't Check line carries only "open" (query.ts).
  receipt_unbilled: ["notACost", "open"],
  // Open-only: every answer is on the permit's own card (book it, move it, say how it went), and each
  // one is a different authority and a different day — no generic verb here could name which. Nothing
  // to dismiss either: the row is derived from the permit's visits and goes when the last one passes.
  permit_inspection: ["open"],
};

/**
 * NEEDS YOU'S ONE ORDER, applied ONCE, inside the build, before the list leaves the server: every
 * surface reading the list reads it in the same order, the client never sorts, and a pile (piles.ts)
 * sits by its mark, its tile, then its OLDEST child's own day (cn-v1162).
 *   1. not done before done ("checked boxes go to the bottom");
 *   2. NOW rows first: the strip is the top of the list;
 *   3. the tile: Get Paid, Sales, Operations, Bookkeeping (GROUP_ORDER);
 *   4. a "Couldn't Check" line leads its tile, so a failed read is never under the rows it hid;
 *   5. SOON before no mark;
 *   6. the Supplier Bills card (supplier_paper) leads its tile's unmarked rows, by its own key: the
 *      papers come to him there ("bring it to me"), and it is a rollup with no day of its own, so the
 *      day key below would put it after any Bookkeeping row a day old (cn-v1162 chose this key once
 *      the order became age; before, every undated row tied at today and the build's order won). A
 *      marked row still sits above it, and a Couldn't Check line still leads the tile (key 4);
 *   7. THE ROW'S OWN DAY, oldest first: `since ?? when` (since cn-v1162, when the mark stopped reading
 *      age: age is the order now, so the order must truly be age). A row with neither counts as TODAY
 *      (not as last), never pushed below a row dated tomorrow. Pay <Supplier> sorts by its discount
 *      day, and Hours on No Job by its oldest shift (its `since`), like any other row.
 * Ties keep the build's own order (a stable sort). `todayStr` is the company's today (YYYY-MM-DD).
 * The mark is read as stamped (absent: none); the tile, as stamped or from its kind.
 */
export function sortActionItems<T extends Pick<ActionItem, "done" | "when" | "since" | "kind" | "id"> & { group?: Group; level?: Level }>(
  items: T[],
  todayStr: string,
): T[] {
  const today = Date.parse(`${todayStr}T00:00:00Z`);
  const whenMs = (w: string | null | undefined) => {
    const t = w ? Date.parse(w) : NaN;
    return Number.isFinite(t) ? t : today;
  };
  const key = (it: T): number[] => [
    it.done ? 1 : 0,
    it.level === "now" ? 0 : 1,
    GROUP_ORDER.indexOf(it.group ?? KIND_GROUP[it.kind]),
    isUnreadLine(it) ? 0 : 1,
    it.level === "soon" ? 0 : 1,
    it.kind === "supplier_paper" ? 0 : 1,
    whenMs(it.since ?? it.when),
  ];
  return items
    .map((it, i) => ({ it, i, k: key(it) }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
      return a.i - b.i; // stable: the build's own order
    })
    .map(({ it }) => it);
}
