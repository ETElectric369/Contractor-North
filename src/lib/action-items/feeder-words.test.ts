import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT EACH NEEDS YOU ROW HANDS THE BOX (the redraw, cn-v1161; the plan's table A2).
 *
 * The box draws WHO (bold), WHAT (a key and its slots, said in the reader's language) and one thing at
 * the right edge (the amount, else the age). The feeders hand over the facts and never a sentence.
 * These pin, per feeder: who or whoSay, what's key and slots, the amount where A2 sets one, the rollup's
 * `since`, and an undated late invoice's day. And that every key a feeder can emit is a name the plan
 * gave the catalog (FEEDER_SAY_KEYS), so the box can never draw a raw key.
 */

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const TZ = "America/Los_Angeles";
/** Noon-ish Pacific on a day `n` days back, as a timestamp. */
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();
const dayAgo = (n: number) => daysAgo(n).slice(0, 10);

const state = vi.hoisted(() => ({ rows: {} as Record<string, any[]> }));

/** Each read answers by its table and a column only it names; everything else is empty. */
function pick(table: string, cols: string): any {
  if (table === "profiles") return { org_id: "org-1", role: "owner" };
  if (table === "invoices" && cols.includes("due_date")) return state.rows.late ?? [];
  if (table === "invoices" && cols.includes("hold_until")) return state.rows.drafts ?? [];
  if (table === "quotes" && cols.includes("accepted_at")) return state.rows.accepted ?? [];
  if (table === "quotes" && cols.includes("valid_until")) return state.rows.awaiting ?? [];
  if (table === "quotes" && cols.includes("quote_line_items")) return state.rows.estimateDrafts ?? [];
  if (table === "organized_items" && cols.includes("summary")) return state.rows.papers ?? [];
  if (table === "contracts") return state.rows.contracts ?? [];
  if (table === "lien_records") return state.rows.liens ?? [];
  if (table === "jobs" && cols.includes("job_schedule_segments(")) return state.rows.needDay ?? [];
  if (table === "jobs" && cols.includes("hold_reason")) return state.rows.holds ?? [];
  if (table === "appointments" && cols.includes("assigned_to")) return state.rows.visits ?? [];
  return [];
}

function fakeClient() {
  const chain = (table: string) => {
    let cols = "";
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const data = pick(table, cols);
            const rows = Array.isArray(data) ? data : [];
            return (ok: any, err: any) => Promise.resolve({ data: Array.isArray(data) ? rows : data, error: null, count: rows.length }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const data = pick(table, cols);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
            };
          }
          if (prop === "select") {
            return (c?: string) => {
              cols = c ?? "";
              return q;
            };
          }
          return () => q;
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table), rpc: () => chain("rpc") };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { getActionItems } from "./query";
import { FEEDER_SAY_KEYS } from "./feeder-keys";
import { inquiryActionItem } from "./switches";
import { supplierDeskFailedItem, supplierPaperActionItem } from "./supplier-paper-item";
import { supplierPayActionItems } from "./supplier-pay-item";
import { noJobHoursActionItem } from "./no-job-hours-item";
import { DONE_UNREAD_ITEM, doneJobItem, doneVisitItem } from "./done-not-billed";
import { PERMIT_INSPECTIONS_UNREAD_ITEM, permitInspectionWhat } from "./permit-inspection-items";
import { jobsNeedingADay, needDayWhyFact } from "./jobs-needing-a-day";
import type { ActionItem } from "./types";

/** The plan's D1 and D2 names a feeder may emit, typed out here so the list cannot grow a stranger. */
const PLAN_KEYS = new Set([
  // D1, the WHO words and labels.
  "ny_who_someone", "ny_who_hoursNoJob", "ny_who_supplierBills", "ny_who_bankDownload", "ny_who_receipt", "ny_who_note",
  "ny_who_document", "ny_who_paper", "ny_who_unread", "ny_who_hoursNotAllListed",
  "ny_lbl_holds", "ny_lbl_receipts", "ny_lbl_supplierBills", "ny_lbl_hoursNoJob",
  // D2, the phrases.
  "ny_w_invoice", "ny_w_invoiceNotSent", "ny_w_jobFinishedSend", "ny_w_jobCancelledSend", "ny_w_visitNotBilled",
  "ny_w_workNotBilled", "ny_w_visitBilledNotPaid", "ny_w_workBilledNotPaid", "ny_w_jobNotBilled", "ny_w_noCostsYet",
  "ny_w_lienPrelim", "ny_w_lienPrelimPast", "ny_w_lienRecord", "ny_w_lienRecordPast", "ny_w_leadNew", "ny_w_leadFollowUp",
  "ny_w_requestNew", "ny_w_requestFollowUp", "ny_w_toWriteUp", "ny_w_toWriteUpTitled", "ny_docEstimate", "ny_docQuote",
  "ny_w_docNotSent", "ny_w_docNoAnswer", "ny_w_docFollowUp", "ny_w_docOfferEnds", "ny_w_docOfferEnded",
  "ny_w_contractNotSigned", "ny_w_saidYes", "ny_w_saidYesNoRef", "ny_w_neverHadADay", "ny_w_datedNeverWorked",
  "ny_w_lastDay", "ny_w_workedNothingNext", "ny_w_quietSince", "ny_w_nToBuy", "ny_w_holdBack", "ny_w_holdNoDay",
  "ny_w_noReason", "ny_w_visitNotClosed", "ny_w_visitNotClosedTitled", "ny_w_toBuy", "ny_w_plusMore",
  "ny_w_permitToBook", "ny_w_permitNotWrittenUp", "ny_w_permitFailed", "ny_w_permitCancelled", "ny_w_clockRunning",
  // The fixer (cn-v1161): a visit that did not pass with no result day on file names no day.
  "ny_w_permitFailedNoDay", "ny_w_permitCancelledNoDay",
  "ny_w_shiftNoJob", "ny_w_hoursSpan", "ny_w_hoursOn", "ny_w_receiptFrom", "ny_w_receipt", "ny_w_billFrom", "ny_w_bill",
  "ny_w_fromSupplier", "ny_w_fromSuppliers", "ny_w_payBySavesOne", "ny_w_payBySavesMany", "ny_w_alreadySent",
  "ny_w_takenPastStock", "ny_w_takenPastStockNoName", "ny_w_paperToSort", "ny_w_noteToReview", "ny_w_toFile",
  "ny_w_bankToSort",
  // D2, the Couldn't Check sentences.
  "ny_w_unreadJobsDay", "ny_w_unreadHolds", "ny_w_unreadReceipts", "ny_w_unreadDone", "ny_w_unreadPermits",
  "ny_w_unreadSupplierPapers", "ny_w_unreadSupplierPay", "ny_w_unreadHours", "ny_w_hoursNotAllListed",
  // D3's pile names, which a Couldn't Check line borrows as its label when it has a pile.
  "ny_btn_pile_jobsNeedingADay", "ny_btn_pile_doneNotBilled", "ny_btn_pile_permitInspections",
]);

const FEEDERS = [
  "query.ts",
  "switches.ts",
  "done-not-billed.ts",
  "permit-inspection-items.ts",
  "supplier-paper-item.ts",
  "supplier-pay-item.ts",
  "no-job-hours-item.ts",
  "jobs-needing-a-day.ts",
];

describe("the keys a feeder emits", () => {
  it("every one is a name the plan gave the catalog, listed once", () => {
    expect(new Set(FEEDER_SAY_KEYS).size).toBe(FEEDER_SAY_KEYS.length);
    for (const k of FEEDER_SAY_KEYS) expect(PLAN_KEYS.has(k), k).toBe(true);
  });

  it("every ny_ word in a feeder's source is on the list, and every listed key is emitted somewhere", () => {
    const listed = new Set<string>(FEEDER_SAY_KEYS);
    const seen = new Set<string>();
    for (const f of FEEDERS) {
      const src = readFileSync(join(__dirname, f), "utf8");
      for (const m of src.matchAll(/"(ny_[A-Za-z_]+)"/g)) {
        expect(listed.has(m[1]), `${f}: ${m[1]}`).toBe(true);
        seen.add(m[1]);
      }
    }
    for (const k of FEEDER_SAY_KEYS) expect(seen.has(k), k).toBe(true);
  });

  it("only the one select grew: the accepted estimates name their total", () => {
    const src = readFileSync(join(__dirname, "query.ts"), "utf8");
    expect(src).toContain('"id, quote_number, doc_type, status, total, accepted_at, created_at, job_id, customer_id, customers(name), jobs:job_id(job_number, name, scheduled_start, status)"');
    expect(src.match(/kind: "supplier_paper"/g)).toHaveLength(1);
  });
});

describe("the pure feeders", () => {
  it("a lead: its name in bold, else the word for nobody named; Leads off says it as a request", () => {
    const lead = { id: "i1", name: "Sam Tillery", status: "new", next_follow_up_at: null };
    expect(inquiryActionItem(lead, TODAY, true)).toMatchObject({ who: "Sam Tillery", what: { key: "ny_w_leadNew" } });
    expect(inquiryActionItem({ ...lead, status: "contacted" }, TODAY, true).what).toEqual({ key: "ny_w_leadFollowUp" });
    expect(inquiryActionItem(lead, TODAY, false).what).toEqual({ key: "ny_w_requestNew" });
    expect(inquiryActionItem({ ...lead, status: "contacted" }, TODAY, false).what).toEqual({ key: "ny_w_requestFollowUp" });
    const nameless = inquiryActionItem({ ...lead, name: "  " }, TODAY, true);
    expect(nameless.who).toBeNull();
    expect(nameless.whoSay).toEqual({ key: "ny_who_someone" });
  });

  it("the supplier bills: a count in words, the one supplier named, the papers' total as the amount", () => {
    const card = (supplier: string, total: number) => ({ supplier, total }) as any;
    const one = supplierPaperActionItem({ cards: [card("Bayberry Supply", 120), card("Bayberry Supply", 30.5)] } as any)!;
    expect(one.whoSay).toEqual({ key: "ny_who_supplierBills", vars: { n: 2 } });
    expect(one.what).toEqual({ key: "ny_w_fromSupplier", vars: { name: "Bayberry Supply" } });
    expect(one.amount).toBeCloseTo(150.5, 2);
    const two = supplierPaperActionItem({ cards: [card("Bayberry Supply", 10), card("Thistlewood Lumber", 5)] } as any)!;
    expect(two.what).toEqual({ key: "ny_w_fromSuppliers" });
    expect(supplierDeskFailedItem({ failed: { papers: true, pay: false } })).toMatchObject({
      whoSay: { key: "ny_who_unread", vars: { labelKey: "ny_lbl_supplierBills" } },
      what: { key: "ny_w_unreadSupplierPapers" },
    });
    expect(supplierDeskFailedItem({ failed: { papers: false, pay: true } })?.what).toEqual({ key: "ny_w_unreadSupplierPay" });
  });

  it("pay a supplier: the supplier in bold, the deadline and saving as slots, what is owed as the amount", () => {
    const due = { accountId: "a1", supplier: "Bayberry Supply", owed: 5174.62, payBy: "2026-12-10", saves: 35.5, invoices: 7, sent: 0, daysLeft: 5 };
    const [row] = supplierPayActionItems([due] as any);
    expect(row.who).toBe("Bayberry Supply");
    expect(row.amount).toBe(5174.62);
    expect(row.what).toEqual({ key: "ny_w_payBySavesMany", vars: { day: "2026-12-10", money: 35.5, n: 7 } });
    const [sentSome] = supplierPayActionItems([{ ...due, invoices: 1, sent: 200 }] as any);
    expect(sentSome.what).toEqual({ key: "ny_w_payBySavesOne", vars: { day: "2026-12-10", money: 35.5, n: 1, andKey: "ny_w_alreadySent", money2: 200 } });
  });

  it("hours on no job: the count in words, the hours and days as slots, the names as data, and since = the oldest shift", () => {
    const shift = (day: string, name: string) => ({ day, name }) as any;
    const span = noJobHoursActionItem({ shifts: [shift("2026-10-07", "Theo Vance"), shift("2026-10-02", "Dana Rook")], hours: 9.25, capped: false, companyCode: null } as any)!;
    expect(span.whoSay).toEqual({ key: "ny_who_hoursNoJob", vars: { n: 2 } });
    expect(span.what).toEqual({ key: "ny_w_hoursSpan", vars: { hours: 9.3, day: "2026-10-02", day2: "2026-10-07" }, tail: "Theo, Dana" });
    expect(span.since).toBe("2026-10-02");
    expect(span.when).toBeNull(); // still no deadline
    const oneDay = noJobHoursActionItem({ shifts: [shift("2026-10-02", "Dana Rook")], hours: 4, capped: true, companyCode: null } as any)!;
    expect(oneDay.what).toEqual({ key: "ny_w_hoursOn", vars: { hours: 4, day: "2026-10-02" }, tail: "Dana" });
    expect(oneDay.whoSay).toEqual({ key: "ny_who_hoursNoJob", vars: { n: "1+" } });
    expect(noJobHoursActionItem(null, { failed: true })).toMatchObject({
      whoSay: { key: "ny_who_unread", vars: { labelKey: "ny_lbl_hoursNoJob" } },
      what: { key: "ny_w_unreadHours" },
    });
    const cappedEmpty = noJobHoursActionItem({ shifts: [], hours: 0, capped: true, companyCode: null } as any)!;
    expect(cappedEmpty.whoSay).toEqual({ key: "ny_who_hoursNotAllListed" });
    expect(cappedEmpty.what?.key).toBe("ny_w_hoursNotAllListed");
  });

  it("done, not billed: a visit leads with its customer; a done job with the job, its customer as the tail", () => {
    const v = { id: "a1", job_id: null, title: "Hot tub circuit", who: "Casey Loam", at: "2026-07-02", openInvoice: null };
    expect(doneVisitItem(v)).toMatchObject({ who: "Casey Loam", what: { key: "ny_w_visitNotBilled", vars: { text: "Hot tub circuit" } } });
    expect(doneVisitItem({ ...v, openInvoice: "inv-1" }).what).toEqual({ key: "ny_w_visitBilledNotPaid", vars: { text: "Hot tub circuit" } });
    expect(doneVisitItem({ ...v, title: null }).what).toEqual({ key: "ny_w_workNotBilled" });
    expect(doneVisitItem({ ...v, title: null, openInvoice: "inv-1" }).what).toEqual({ key: "ny_w_workBilledNotPaid" });
    expect(doneVisitItem({ ...v, who: null }).who).toBeNull();
    expect(doneJobItem({ id: "j1", job_number: "J-011", name: "Larkspur Panel", customer: "Casey Loam", at: null })).toMatchObject({
      who: "Larkspur Panel · J-011",
      what: { key: "ny_w_jobNotBilled", tail: "Casey Loam" },
    });
    expect(DONE_UNREAD_ITEM).toMatchObject({ whoSay: { key: "ny_who_unread", vars: { labelKey: "ny_btn_pile_doneNotBilled" } }, what: { key: "ny_w_unreadDone" } });
  });

  it("a permit's inspection: the authority and its day as slots, the customer as the tail", () => {
    expect(permitInspectionWhat("to_book", "Snowbell County", null, null, "Casey Loam")).toEqual({ key: "ny_w_permitToBook", vars: { name: "Snowbell County" }, tail: "Casey Loam" });
    expect(permitInspectionWhat("overdue", "Snowbell County", "2026-10-01", null, null)).toEqual({ key: "ny_w_permitNotWrittenUp", vars: { name: "Snowbell County", day: "2026-10-01" }, tail: null });
    expect(permitInspectionWhat("needs_another", "Snowbell County", "2026-10-01", "failed", null).key).toBe("ny_w_permitFailed");
    expect(permitInspectionWhat("needs_another", "Snowbell County", "2026-10-01", "cancelled", null).key).toBe("ny_w_permitCancelled");
    // No result day on file: a day-less phrase, never "failed on" with a hole.
    expect(permitInspectionWhat("needs_another", "Snowbell County", null, "failed", null)).toEqual({ key: "ny_w_permitFailedNoDay", vars: { name: "Snowbell County" }, tail: null });
    expect(permitInspectionWhat("needs_another", "Snowbell County", null, "cancelled", "Casey Loam")).toEqual({ key: "ny_w_permitCancelledNoDay", vars: { name: "Snowbell County" }, tail: "Casey Loam" });
    expect(PERMIT_INSPECTIONS_UNREAD_ITEM).toMatchObject({ whoSay: { vars: { labelKey: "ny_btn_pile_permitInspections" } }, what: { key: "ny_w_unreadPermits" } });
  });

  it("a job needing a day: the why line's fact as a key and its day, and lines to buy as a second phrase", () => {
    const T = "2026-09-27";
    expect(needDayWhyFact({ lastWorked: null, firstDated: null, lastDated: null, todayStr: T })).toEqual({ key: "ny_w_neverHadADay" });
    expect(needDayWhyFact({ lastWorked: null, firstDated: "2026-09-02", lastDated: "2026-09-02", todayStr: T })).toEqual({ key: "ny_w_datedNeverWorked", vars: { day: "2026-09-02" } });
    expect(needDayWhyFact({ lastWorked: "2026-06-01", firstDated: null, lastDated: "2026-06-12", todayStr: T })).toEqual({ key: "ny_w_lastDay", vars: { day: "2026-06-12" } });
    expect(needDayWhyFact({ lastWorked: "2026-09-25", firstDated: null, lastDated: null, todayStr: T, toBuy: 6 })).toEqual({
      key: "ny_w_workedNothingNext",
      vars: { day: "2026-09-25", andKey: "ny_w_nToBuy", n: 6 },
    });
    expect(needDayWhyFact({ lastWorked: "2026-09-11", firstDated: null, lastDated: null, todayStr: T })).toEqual({ key: "ny_w_quietSince", vars: { day: "2026-09-11" } });
    // The finding carries both, from one set of facts.
    const [f] = jobsNeedingADay({ jobs: [{ id: "j1", status: "in_progress", time_entries: [{ clock_in: "2026-09-11T18:00:00Z" }] }], todayStr: T, tz: TZ });
    expect(f.why).toBe("Quiet since Sep 11");
    expect(f.whyFact).toEqual({ key: "ny_w_quietSince", vars: { day: "2026-09-11" } });
  });
});

describe("the build: each row's who, what and amount (table A2)", () => {
  beforeEach(() => {
    state.rows = {};
  });
  const build = async () => (await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: TZ })).now;
  const byId = (rows: ActionItem[], id: string) => {
    const r = rows.find((x) => x.id === id) ?? rows.flatMap((x) => x.children ?? []).find((x) => x.id === id);
    expect(r, id).toBeTruthy();
    return r!;
  };

  it("an UNDATED late invoice is late from the day it turned late (made + 30), not the day it was made", async () => {
    state.rows.late = [
      { id: "inv-a", invoice_number: "INV-101", total: 900, amount_paid: 0, due_date: null, status: "sent", created_at: daysAgo(45), customers: { name: "Dana Rook" } },
      { id: "inv-b", invoice_number: "INV-102", total: 300, amount_paid: 0, due_date: null, status: "sent", created_at: daysAgo(65), customers: null },
      { id: "inv-c", invoice_number: "INV-103", total: 200, amount_paid: 50, due_date: dayAgo(10), status: "partial", created_at: daysAgo(40), customers: { name: "Theo Vance" } },
    ];
    const rows = await build();
    const a = byId(rows, "inv-a");
    expect(a.when).toBe(dayAgo(15));
    expect(a.level).toBe("soon"); // 15 days late, not 45
    expect(a).toMatchObject({ who: "Dana Rook", what: { key: "ny_w_invoice", vars: { ref: "INV-101" } }, amount: 900 });
    const b = byId(rows, "inv-b");
    expect(b.when).toBe(dayAgo(35));
    expect(b.level).toBe("now");
    expect(b.who).toBe("INV-102"); // no customer: the invoice's number
    // A dated one keeps its due day.
    expect(byId(rows, "inv-c").when).toBe(dayAgo(10));
  });

  it("a won estimate: the customer, the number as a slot, the job as the tail, the accepted total", async () => {
    state.rows.accepted = [
      { id: "q1", quote_number: "E-040", doc_type: "estimate", status: "accepted", total: 4200, accepted_at: daysAgo(2), created_at: daysAgo(9), job_id: "j1", customers: { name: "Casey Loam" }, jobs: { job_number: "J-050", name: "Snowbell Deck", scheduled_start: null, status: "to_be_scheduled" } },
    ];
    const r = byId(await build(), "q1");
    expect(r).toMatchObject({ who: "Casey Loam", amount: 4200, what: { key: "ny_w_saidYes", vars: { ref: "E-040" }, tail: "Snowbell Deck · J-050" } });
  });

  it("no answer yet: the customer, the doc and number, why it is here, and the SENT day in since", async () => {
    state.rows.awaiting = [
      { id: "q2", quote_number: "E-041", doc_type: "estimate", status: "sent", total: 800, valid_until: dayAgo(-3), created_at: daysAgo(4), job_id: null, follow_up_at: null, customers: { name: "Sam Tillery" }, jobs: null },
      { id: "q3", quote_number: "Q-007", doc_type: "quote", status: "sent", total: 500, valid_until: null, created_at: daysAgo(12), job_id: null, follow_up_at: null, customers: { name: "Theo Vance" }, jobs: null },
    ];
    const rows = await build();
    const ends = byId(rows, "q2");
    expect(ends.what).toEqual({ key: "ny_w_docOfferEnds", vars: { docKey: "ny_docEstimate", ref: "E-041", day: dayAgo(-3) } });
    expect(ends.since).toBe(daysAgo(4)); // the day it went out, whatever `when` holds (defect D1)
    expect(ends.who).toBe("Sam Tillery");
    const quiet = byId(rows, "q3");
    expect(quiet.what).toEqual({ key: "ny_w_docNoAnswer", vars: { docKey: "ny_docQuote", ref: "Q-007" } });
    expect(quiet.since).toBe(daysAgo(12));
  });

  it("a draft invoice (one set aside whose job finished, too) and a contract say who, what and the amount", async () => {
    state.rows.drafts = [
      { id: "d1", invoice_number: "INV-110", total: 650, amount_paid: 0, status: "draft", created_at: daysAgo(3), hold_until: null, hold_reason: null, job_id: "j2", customers: { name: "Dana Rook" }, jobs: { job_number: "J-060", name: "Larkspur Panel", status: "in_progress" } },
      { id: "d2", invoice_number: "INV-111", total: 90, amount_paid: 0, status: "draft", created_at: daysAgo(3), hold_until: dayAgo(-10), hold_reason: null, job_id: "j3", customers: null, jobs: { job_number: "J-061", name: "Thistlewood Gate", status: "complete" } },
    ];
    state.rows.contracts = [{ id: "c1", contract_number: "C-005", status: "sent", job_id: "j4", created_at: daysAgo(5), customers: { name: "Theo Vance" }, jobs: { job_number: "J-062", name: "Bayberry Shed", status: "in_progress" } }];
    const rows = await build();
    expect(byId(rows, "d1")).toMatchObject({ who: "Dana Rook", amount: 650, what: { key: "ny_w_invoiceNotSent", vars: { ref: "INV-110" }, tail: "Larkspur Panel · J-060" } });
    expect(byId(rows, "d2")).toMatchObject({ who: "Thistlewood Gate · J-061", what: { key: "ny_w_jobFinishedSend", vars: { ref: "INV-111" }, tail: null } });
    expect(byId(rows, "c1")).toMatchObject({ who: "Theo Vance", what: { key: "ny_w_contractNotSigned", vars: { ref: "C-005" }, tail: "Bayberry Shed · J-062" } });
    expect(byId(rows, "c1").amount ?? null).toBeNull();
  });

  it("papers: the title in bold, else its kind in words; a bank download in words; the phrase says where it is sorted", async () => {
    state.rows.papers = [
      { id: "p1", kind: "note", status: "needs_review", title: "", category: null, source: null, doc_type: null, amount: null, created_at: daysAgo(2) },
      { id: "p2", kind: "receipt", status: "needs_review", title: "Snowbell hardware", category: null, source: null, doc_type: null, amount: 42.1, created_at: daysAgo(2) },
    ];
    const rows = await build();
    const note = byId(rows, "p1");
    expect(note.who).toBeNull();
    expect(note.whoSay).toEqual({ key: "ny_who_note" });
    expect(note.what?.key).toMatch(/^ny_w_(noteToReview|toFile|paperToSort)$/);
    const receipt = byId(rows, "p2");
    expect(receipt.who).toBe("Snowbell hardware");
    expect(receipt.amount).toBe(42.1);
  });

  it("a job needing a day and a hold: the job in bold, the customer as the tail, the fact as a key", async () => {
    state.rows.needDay = [{ id: "j5", job_number: "J-070", name: "Larkspur Remodel", status: "to_be_scheduled", created_at: daysAgo(20), customers: { name: "Casey Loam" }, job_schedule_segments: [], time_entries: [] }];
    state.rows.holds = [
      { id: "j6", job_number: "J-071", name: "Snowbell Barn", updated_at: daysAgo(30), hold_reason: "Waiting on the owner", hold_until: dayAgo(1), customers: { name: "Theo Vance" }, holder: null },
      { id: "j7", job_number: "J-072", name: "Bayberry Porch", updated_at: daysAgo(30), hold_reason: "", hold_until: null, customers: null, holder: null },
    ];
    const rows = await build();
    expect(byId(rows, "j5")).toMatchObject({ who: "Larkspur Remodel · J-070", what: { key: "ny_w_neverHadADay", tail: "Casey Loam" } });
    expect(byId(rows, "onhold-j6")).toMatchObject({ who: "Snowbell Barn · J-071", what: { key: "ny_w_holdBack", vars: { text: "Waiting on the owner" }, tail: "Theo Vance" } });
    expect(byId(rows, "onhold-j7").what).toEqual({ key: "ny_w_holdNoDay", vars: { textKey: "ny_w_noReason" }, tail: null });
  });

  it("a visit nobody closed out: the customer in bold, the type always in the phrase, a typed title beside it", async () => {
    const v = (id: string, type: string, title: string | null, who: string | null) => ({ id, type, title, starts_at: daysAgo(3), status: "scheduled", job_id: null, inquiry_id: null, assigned_to: "owner-1", customers: who ? { name: who } : null });
    state.rows.visits = [v("v1", "service_call", null, "Dana Rook"), v("v2", "service_call", "Breaker swap", "Dana Rook"), v("v3", "meeting", "Breaker swap", null)];
    const rows = await build();
    expect(byId(rows, "v1")).toMatchObject({ who: "Dana Rook", what: { key: "ny_w_visitNotClosed", vars: { type: "service_call" } } });
    expect(byId(rows, "v2").what).toEqual({ key: "ny_w_visitNotClosedTitled", vars: { text: "Breaker swap", type: "service_call" } });
    // Nobody named: the bold line is the title, so the phrase does not say it again.
    expect(byId(rows, "v3")).toMatchObject({ who: null, what: { key: "ny_w_visitNotClosed", vars: { type: "meeting" } } });
  });

  it("no row the build hands over carries a key that is not on the list", async () => {
    state.rows.late = [{ id: "inv-z", invoice_number: "INV-120", total: 10, amount_paid: 0, due_date: dayAgo(3), status: "sent", created_at: daysAgo(40), customers: null }];
    state.rows.needDay = [{ id: "j9", job_number: "J-090", name: null, status: "scheduled", scheduled_start: daysAgo(4), created_at: daysAgo(20), customers: null, job_schedule_segments: [], time_entries: [] }];
    const listed = new Set<string>(FEEDER_SAY_KEYS);
    const keysOf = (s: { key: string; vars?: Record<string, unknown> } | undefined) =>
      s ? [s.key, ...Object.entries(s.vars ?? {}).filter(([k, v]) => k.endsWith("Key") && v != null).map(([, v]) => String(v))] : [];
    for (const r of [...(await build()), ...(await build()).flatMap((x) => x.children ?? [])]) {
      for (const k of [...keysOf(r.what), ...keysOf(r.whoSay)]) expect(listed.has(k), `${r.id}: ${k}`).toBe(true);
    }
  });
});
