import { describe, it, expect } from "vitest";
import { loadSupplierDesk, supplierDocumentRows } from "./supplier-papers";
import { clearTarget, sentThisCycle, supplierPayDue, PAY_CARD_WINDOW_DAYS } from "./supplier-pay-due";
import { supplierBalance, supplierNetIfPaidBy, type SupplierAccountRow } from "./supplier-balance";
import { claimableDiscounts } from "./supplier-reconcile";
import { supplierPayActionItems, supplierPayHref } from "@/lib/action-items/supplier-pay-item";
import { supplierDeskFailedItem } from "@/lib/action-items/supplier-paper-item";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "PAY CED $5,174.62 BY OCT 10 · Saves $35.50 on 7 invoices" (Erik, 2026-09-26).
 *
 * The rows below are ET's 24 OPEN CED documents exactly as the read-only replay returned them the
 * night this was built (numbers, dates, open balances, discounts), plus one closed one to prove a
 * settled document never adds to either figure. $5,174.62 is CED's open balance; $35.50 is the
 * live discount on seven invoices ($39.64 printed, less the $4.14 on 8802-1107230, which credit
 * memo 8802-1107337 reverses to the cent: CED gives no discount on money it took back).
 */

const CED = "acct-ced";
const ACCOUNTS = [
  { id: CED, name: "Consolidated Electrical Distributors", on_account: true },
  { id: "acct-ace", name: "Ace Mountain Hardware", on_account: true },
];

type Raw = [string, string, string, number, number, number | null, string | null];
// [invoice_number, kind, invoice_date, total, open_balance, discount_amount, discount_by]
const OPEN: Raw[] = [
  ["8802-1103832", "invoice", "2026-07-22", 998.77, 10.29, 11.87, "2026-08-10"],
  ["9019682437", "service_charge", "2026-07-25", 31.26, 31.26, null, null],
  ["8802-1104147", "invoice", "2026-07-28", 101.96, 101.96, 0.93, "2026-08-10"],
  ["8802-1104268", "invoice", "2026-07-28", 859.99, 859.99, 6.25, "2026-08-10"],
  ["8802-1104644", "invoice", "2026-07-29", 95.27, 95.27, 1.48, "2026-08-10"],
  ["8802-1104646", "invoice", "2026-07-29", 36.54, 36.54, 0.34, "2026-08-10"],
  ["8802-1104645", "credit_memo", "2026-08-06", -31.86, -31.86, null, null],
  ["8802-1105997", "invoice", "2026-08-19", 2.3, 2.3, 0.04, "2026-09-10"],
  ["8802-1105963", "invoice", "2026-08-19", 84.37, 84.37, 0.26, "2026-09-10"],
  ["8802-1106188", "invoice", "2026-08-21", 199.48, 199.48, 3.67, "2026-09-10"],
  ["8802-1106249", "invoice", "2026-08-21", 150.27, 150.27, 1.15, "2026-09-10"],
  ["9019994306", "service_charge", "2026-08-25", 15.16, 15.16, null, null],
  ["8802-1107139", "invoice", "2026-09-01", 59.17, 59.17, 0.9, "2026-10-10"],
  ["8802-1107088", "invoice", "2026-09-01", 456.02, 456.02, 4.7, "2026-10-10"],
  ["8802-1107230", "invoice", "2026-09-03", 225.47, 225.47, 4.14, "2026-10-10"],
  ["8802-1107337", "credit_memo", "2026-09-03", -225.47, -225.47, null, null],
  ["8802-1107338", "invoice", "2026-09-03", 223.29, 223.29, 4.1, "2026-10-10"],
  ["8802-1106969", "invoice", "2026-09-04", 301.81, 301.81, 5.54, "2026-10-10"],
  ["8802-1107820", "invoice", "2026-09-16", 187.64, 187.64, 1.77, "2026-10-10"],
  ["8802-1107695", "invoice", "2026-09-16", 1062.18, 1062.18, 8.47, "2026-10-10"],
  ["8802-1108330", "invoice", "2026-09-17", 653.25, 653.25, null, null],
  ["8802-1108540", "credit_memo", "2026-09-22", -82.1, -82.1, null, null],
  ["8802-1108541", "credit_memo", "2026-09-22", -115.33, -115.33, null, null],
  ["8802-1108534", "invoice", "2026-09-22", 873.66, 873.66, 10.02, "2026-10-10"],
];

/** The documents in the shape the database hands back (supplierDocumentRows' input). */
function hisDocuments(over: (d: Record<string, unknown>) => Record<string, unknown> = (d) => d) {
  const open = OPEN.map(([n, kind, date, total, open_balance, discount_amount, discount_by], i) => ({
    id: `si-${i + 1}`,
    supplier_account_id: CED,
    invoice_number: n,
    kind,
    invoice_date: date,
    due_date: null,
    job_name_raw: null,
    job_id: null,
    total,
    open_balance,
    closed: false,
    discount_amount,
    discount_by,
    source_file: null,
    jobs: null,
  }));
  // Settled, with a discount still printed on it and a date that would be live: counts for nothing.
  const closed = { ...open[12], id: "si-closed", invoice_number: "8802-1100001", open_balance: 0, closed: true, discount_amount: 9.99 };
  return [...open, closed].map(over);
}

const rowsOf = (docs = hisDocuments()) => supplierDocumentRows({ documents: docs, bills: [], links: [], aliasRows: [] }).rows;
const TONIGHT = "2026-09-26";

describe("Pay CED By Oct 10: the line on his real documents", () => {
  it("tonight: Pay CED $5,174.62 By Oct 10, Saves $35.50 on 7 invoices", () => {
    const due = supplierPayDue({ rows: rowsOf(), accounts: ACCOUNTS, today: TONIGHT });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ accountId: CED, supplier: "CED", owed: 5174.62, saves: 35.5, invoices: 7, sent: 0, payBy: "2026-10-10", daysLeft: 14 });
    const [item] = supplierPayActionItems(due);
    expect(item.title).toBe("Pay CED $5,174.62 By Oct 10");
    expect(item.subtitle).toBe("Saves $35.50 on 7 invoices");
    expect(item.when).toBe("2026-10-10");
    expect(item.href).toBe(`/bills?pay=${CED}`);
    expect(item.href).toBe(supplierPayHref(CED));
    expect(item.kind).toBe("supplier_pay");
    expect(item.stream).toBe("money");
    expect(item.affordances).toEqual(["open"]);
    expect(item.urgency).toBe(1);
  });

  it("the figures are the /bills card's figures, read by the same functions", () => {
    const rows = rowsOf();
    const [due] = supplierPayDue({ rows, accounts: ACCOUNTS, today: TONIGHT });
    const account: SupplierAccountRow = {
      id: CED, name: "Consolidated Electrical Distributors", accountNumber: "TR-34426", branchCode: null, onAccount: true, note: null,
      aliases: [], bills: [{ id: "b1", supplier: "CED", billDate: "2026-09-01", amount: 999, status: "unpaid", jobId: null, jobName: null, invoiceNumber: null, isStatement: false }],
      payments: [{ id: "p1", amount: 6000, paidOn: "2026-08-05", method: "check", reference: null, note: null, voided: false }],
      supplierInvoices: rows,
    };
    // The payment sheet's "You owe" (model B: bills and payments are not in it).
    expect(due.owed).toBe(supplierBalance(account, TONIGHT).owed);
    // "Discount Still On The Table".
    const claim = claimableDiscounts(rows, TONIGHT);
    expect(due.saves).toBe(claim.dueOnNext);
    expect(due.invoices).toBe(claim.rows.filter((r) => r.reading.by === claim.nextDeadline).length);
    expect(due.payBy).toBe(claim.nextDeadline);
    // And paying by that day really does claim it all.
    expect(supplierNetIfPaidBy(rows, due.payBy, TONIGHT).discount).toBe(due.saves);
  });

  it(`shows only inside the last ${PAY_CARD_WINDOW_DAYS} days before the deadline, and on the day itself`, () => {
    const at = (today: string) => supplierPayDue({ rows: rowsOf(), accounts: ACCOUNTS, today });
    expect(at("2026-09-25")).toEqual([]); // 15 days out: not yet
    expect(at("2026-09-26")).toHaveLength(1); // 14 days out
    const lastDay = at("2026-10-10");
    expect(lastDay).toHaveLength(1);
    expect(lastDay[0].daysLeft).toBe(0);
    expect(supplierPayActionItems(lastDay)[0].urgency).toBe(2);
  });

  it("gone once the deadline passes: no nag with nothing to save", () => {
    expect(supplierPayDue({ rows: rowsOf(), accounts: ACCOUNTS, today: "2026-10-11" })).toEqual([]);
  });

  it("two deadlines: Saves names only the slice that rides on the soonest date, as /bills does", () => {
    // Bought Oct 2, so its discount runs to Nov 10. On Oct 8 the Oct 10 slice is running out; the
    // Nov 10 one is not, and a line saying "Saves $44.50 By Oct 10" would hurry $9.00 for no reason.
    const later = { ...hisDocuments()[23], id: "si-oct", invoice_number: "8802-1109001", invoice_date: "2026-10-02", total: 900, open_balance: 900, discount_amount: 9, discount_by: "2026-11-10" };
    const rows = rowsOf([...hisDocuments(), later]);
    const claim = claimableDiscounts(rows, "2026-10-08");
    expect(claim.total).toBe(44.5);
    expect(claim.dueOnNext).toBe(35.5);
    const [due] = supplierPayDue({ rows, accounts: ACCOUNTS, today: "2026-10-08" });
    expect(due).toMatchObject({ saves: 35.5, invoices: 7, payBy: "2026-10-10", daysLeft: 2, owed: 6074.62 });
    const [item] = supplierPayActionItems([due]);
    expect(item.subtitle).toBe("Saves $35.50 on 7 invoices");
    expect(item.urgency).toBe(2);
    // Once Oct 10 passes, the Nov 10 slice gets its own line in its own window.
    const [next] = supplierPayDue({ rows, accounts: ACCOUNTS, today: "2026-10-27" });
    expect(next).toMatchObject({ saves: 9, invoices: 1, payBy: "2026-11-10" });
  });

  it("hidden when no document carries a discount", () => {
    const rows = rowsOf(hisDocuments((d) => ({ ...d, discount_amount: null, discount_by: null })));
    expect(supplierPayDue({ rows, accounts: ACCOUNTS, today: TONIGHT })).toEqual([]);
  });

  it("hidden for a register account, an account with nothing owed, and an account with no documents", () => {
    const rows = rowsOf();
    expect(supplierPayDue({ rows, accounts: [{ ...ACCOUNTS[0], on_account: false }], today: TONIGHT })).toEqual([]);
    const paidUp = rowsOf(hisDocuments((d) => ({ ...d, closed: true })));
    expect(supplierPayDue({ rows: paidUp, accounts: ACCOUNTS, today: TONIGHT })).toEqual([]);
    expect(supplierPayDue({ rows, accounts: [ACCOUNTS[1]], today: TONIGHT })).toEqual([]);
  });
});

describe("Paying clears the line (keyed to the cheque, never to when a paper landed)", () => {
  const pay = (amount: number, paid_on: string, voided_at: string | null = null) => ({ supplier_account_id: CED, amount, paid_on, voided_at });
  /**
   * His real book: every paper riding on Oct 10 is open (read-only replay, 2026-09-26). The fixture's
   * one settled paper is synthetic and rides on Oct 10 too; nothing says what closed it, so it would
   * read as money this cycle's cheque paid (the header's named limit, pinned on its own below).
   */
  const hisBook = (over?: (d: Record<string, unknown>) => Record<string, unknown>) => hisDocuments(over).filter((d) => d.id !== "si-closed");
  const dueWith = (payments: ReturnType<typeof pay>[], today = "2026-10-03", docs = hisBook()) =>
    supplierPayDue({ rows: rowsOf(docs), accounts: ACCOUNTS, today, payments });
  // Bought Oct 4: its discount runs to Nov 10, so it is not what the Oct 10 cheque was for.
  const october = { ...hisDocuments()[23], id: "si-oct", invoice_number: "8802-1109001", invoice_date: "2026-10-04", total: 900, open_balance: 900, discount_amount: 9, discount_by: "2026-11-10" };

  it("his real payments are all dated on or before Sep 10, the last cycle: none is Oct 10's", () => {
    const payments = [pay(1000, "2026-06-22"), pay(1500, "2026-07-13"), pay(2000, "2026-08-17"), pay(1500, "2026-09-10")];
    expect(sentThisCycle({ documents: rowsOf(), payments, accountId: CED, payBy: "2026-10-10" })).toEqual({ sent: 0, lastPaidOn: null });
    expect(dueWith(payments, TONIGHT)[0]).toMatchObject({ owed: 5174.62, sent: 0 });
  });

  it("paying the whole cheque on Oct 3 takes the line off My Day", () => {
    expect(dueWith([pay(5139.12, "2026-10-03")])).toEqual([]);
    expect(dueWith([pay(5174.62, "2026-10-03")])).toEqual([]);
    // In chunks too: the cycle's payments add up.
    expect(dueWith([pay(2000, "2026-09-20"), pay(3139.12, "2026-10-02")])).toEqual([]);
  });

  it("and it stays off when a new CED paper lands before CED has applied the cheque", () => {
    // Paid in full Oct 2; on Oct 5 he downloads one new October invoice. The old ones are still
    // open (CED has not applied the cheque), and the line does not come back asking again.
    expect(dueWith([pay(5139.12, "2026-10-02")], "2026-10-05", [...hisBook(), october])).toEqual([]);
  });

  it("but a later purchase still riding on Oct 10 brings it back, at the /bills figure", () => {
    const sep29 = { ...october, id: "si-929", invoice_number: "8802-1108999", invoice_date: "2026-09-29", discount_by: "2026-10-10" };
    const [due] = dueWith([pay(5139.12, "2026-09-28")], "2026-10-03", [...hisBook(), sep29]);
    expect(due).toMatchObject({ owed: 6074.62, sent: 5139.12, saves: 44.5 });
  });

  it("a $1,500 chunk leaves the figure at the /bills You Owe, and names the chunk as a fact", () => {
    const [due] = dueWith([pay(1500, "2026-10-03")]);
    expect(due).toMatchObject({ owed: 5174.62, sent: 1500, saves: 35.5 });
    const [item] = supplierPayActionItems([due]);
    expect(item.title).toBe("Pay CED $5,174.62 By Oct 10");
    expect(item.subtitle).toBe("Saves $35.50 on 7 invoices · $1,500.00 already sent");
  });

  it("a chunk CED has applied and he re-downloaded is off the papers once, never off the figure twice", () => {
    // $2,000 sent Oct 2; CED applies it and closes the oldest open papers; he re-downloads them (no new
    // numbers, so nothing new landed). The figure is CED's new open balance, not $2,000 less again.
    const applied = new Set(["8802-1104268", "8802-1104147", "8802-1104644", "8802-1104646", "8802-1103832", "9019682437", "8802-1104645", "8802-1105997", "8802-1105963", "8802-1106188", "8802-1106249", "9019994306", "8802-1107139", "8802-1107088"]);
    const docs = hisDocuments((d) => (applied.has(String(d.invoice_number)) ? { ...d, closed: true, open_balance: 0 } : d));
    const owedNow = supplierBalance(
      { id: CED, name: "CED", accountNumber: null, branchCode: null, onAccount: true, note: null, aliases: [], bills: [], payments: [], supplierInvoices: rowsOf(docs) },
      "2026-10-06",
    ).owed;
    const [due] = dueWith([pay(2000, "2026-10-02")], "2026-10-06", docs);
    expect(due.owed).toBe(owedNow);
    expect(due.sent).toBe(2000);
  });

  /**
   * AUDIT v1018, CLASS 7 (reproduced with the committed functions): two September invoices, $2,500
   * each, $20 off each by Oct 10. He sends $3,000 on Sep 28; CED applies it oldest-first (the first
   * closed, $500 off the second) and he re-downloads on Oct 1. The line used to measure the cheque
   * against what is LEFT ($1,980), which the applied chunk had already come off, and cleared with
   * $2,000 and its $20 discount still open.
   */
  describe("the cheque is measured against what it was for, not what is left after CED applies it", () => {
    const sept = (id: string, date: string, over: Record<string, unknown> = {}) => ({
      id,
      supplier_account_id: CED,
      invoice_number: `8802-${id}`,
      kind: "invoice",
      invoice_date: date,
      due_date: null,
      job_name_raw: null,
      job_id: null,
      total: 2500,
      open_balance: 2500,
      closed: false,
      discount_amount: 20,
      discount_by: "2026-10-10",
      source_file: null,
      jobs: null,
      ...over,
    });
    const before = [sept("i1", "2026-09-05"), sept("i2", "2026-09-12")];
    const applied = [sept("i1", "2026-09-05", { closed: true, open_balance: 0 }), sept("i2", "2026-09-12", { open_balance: 2000 })];

    it("before he pays, and with the $3,000 sent but not applied, the line shows", () => {
      expect(dueWith([], "2026-09-27", before)[0]).toMatchObject({ owed: 5000, saves: 40, sent: 0 });
      expect(dueWith([pay(3000, "2026-09-28")], "2026-09-29", before)[0]).toMatchObject({ owed: 5000, sent: 3000 });
    });

    it("applied and re-downloaded, it still shows: $2,000 and its $20 are open", () => {
      const [due] = dueWith([pay(3000, "2026-09-28")], "2026-10-01", applied);
      expect(due).toMatchObject({ owed: 2000, saves: 20, sent: 3000 });
    });

    it("and it goes once what was sent covers what the cheque was for ($4,960)", () => {
      expect(dueWith([pay(3000, "2026-09-28"), pay(1960, "2026-10-02")], "2026-10-03", applied)).toEqual([]);
      expect(dueWith([pay(4960, "2026-09-28")], "2026-10-01", [sept("i1", "2026-09-05", { closed: true, open_balance: 0 }), sept("i2", "2026-09-12", { closed: true, open_balance: 0 })])).toEqual([]);
    });

    it("clearTarget: the full cycle, however much of it CED has applied", () => {
      expect(clearTarget(rowsOf(before), "2026-10-10", "2026-10-01")).toBe(4960);
      expect(clearTarget(rowsOf(applied), "2026-10-10", "2026-10-01")).toBe(4960);
      // CED closes papers out of turn (his own book: July papers open beside August ones closed), so
      // a newer paper closed before an older one still counts as what the cheque was for.
      const outOfTurn = [sept("i1", "2026-09-05"), sept("i2", "2026-09-12", { closed: true, open_balance: 0 })];
      expect(clearTarget(rowsOf(outOfTurn), "2026-10-10", "2026-10-01")).toBe(4960);
    });

    it("a part-payment a closed credit memo matches to the cent was the return, not his cheque", () => {
      // CED applied a -$500.00 memo to i1: the memo closed, i1 reads $2,000 open. He owes $1,980 net.
      const memo = sept("cm", "2026-09-15", { kind: "credit_memo", total: -500, open_balance: 0, closed: true, discount_amount: null, discount_by: null });
      const docs = [sept("i1", "2026-09-05", { open_balance: 2000 }), memo];
      expect(clearTarget(rowsOf(docs), "2026-10-10", "2026-09-27")).toBe(1980);
      expect(dueWith([pay(1980, "2026-09-20")], "2026-09-27", docs)).toEqual([]);
      // Each memo is spent once: two purchases part-paid by $500 and one memo leave one as his cash.
      const two = [...docs, sept("i2", "2026-09-06", { open_balance: 2000 })];
      expect(clearTarget(rowsOf(two), "2026-10-10", "2026-09-27")).toBe(4460);
    });

    it("a closure the app cannot date leans toward staying: a last-cycle cheque CED spent here", () => {
      // Sep 8, $3,480 (last cycle) paid the $1,000 August paper and CED spent the rest on i1. He sends
      // $2,480 on Sep 20 for i2. Nothing on the papers says when i1 closed, so i1 reads as this
      // cycle's money and the line stays, naming what he sent, until Oct 10 passes (the header's
      // named limit). Clearing early would lose his discount without a word; staying says so.
      const aug = sept("a1", "2026-08-12", { total: 1000, open_balance: 0, closed: true, discount_amount: 10, discount_by: "2026-09-10" });
      const docs = [aug, sept("i1", "2026-09-05", { closed: true, open_balance: 0 }), sept("i2", "2026-09-12")];
      const [due] = dueWith([pay(3480, "2026-09-08"), pay(2480, "2026-09-20")], "2026-09-27", docs);
      expect(due).toMatchObject({ owed: 2500, sent: 2480, saves: 20 });
      expect(dueWith([pay(3480, "2026-09-08"), pay(2480, "2026-09-20")], "2026-10-11", docs)).toEqual([]);
    });
  });

  /**
   * RE-REVIEW, 2026-09-26: ON HIS REAL BOOK. CED does not apply oldest-first: 8802-1103832 has sat
   * at $10.29 open since July while CED closed August papers. A rule that only put back papers older
   * than the oldest one still open was pinned at Jul 22 and put back nothing, so a $3,000 chunk CED
   * spent on the Oct 10 papers cleared the line with 8802-1108534 and its $10.02 still open.
   */
  describe("on his real CED papers, whatever order CED applies a chunk in", () => {
    const spentOnOct10 = new Set(["8802-1107139", "8802-1107088", "8802-1107338", "8802-1106969", "8802-1107820", "8802-1107695"]);
    const docs = hisBook((d) =>
      spentOnOct10.has(String(d.invoice_number))
        ? { ...d, closed: true, open_balance: 0 }
        : d.invoice_number === "8802-1108534"
          ? { ...d, open_balance: 138.29 }
          : d,
    );

    it("$3,000 sent Sep 28, applied by CED to the Oct 10 papers: the line stays", () => {
      const [due] = dueWith([pay(3000, "2026-09-28")], "2026-10-01", docs);
      expect(due).toMatchObject({ sent: 3000, saves: 10.02, payBy: "2026-10-10" });
      // What the cheque was for is the whole Oct 10 cheque /bills named on Sep 26, however it was spent.
      expect(clearTarget(rowsOf(docs), "2026-10-10", "2026-10-01")).toBe(5139.12);
    });

    it("and goes once the rest is sent", () => {
      expect(dueWith([pay(3000, "2026-09-28"), pay(2139.12, "2026-10-02")], "2026-10-03", docs)).toEqual([]);
    });

    it("a settled Oct 10 paper nothing dates reads as this cycle's money: the line stays, naming the cheque", () => {
      const withSettled = hisDocuments();
      const [due] = dueWith([pay(5174.62, "2026-10-03")], "2026-10-03", withSettled);
      expect(due).toMatchObject({ owed: 5174.62, sent: 5174.62, saves: 35.5 });
      // Never more put back than was sent: the target is the cheque plus that paper, no more.
      expect(clearTarget(rowsOf(withSettled), "2026-10-10", "2026-10-03", 5174.62)).toBe(5188.3);
      expect(clearTarget(rowsOf(withSettled), "2026-10-10", "2026-10-03", 20)).toBe(5159.12);
    });
  });

  it("a voided payment, a cheque dated before the cycle, or one after the deadline never counts", () => {
    expect(dueWith([pay(5174.62, "2026-10-03", "2026-10-03T19:00:00Z")])[0]).toMatchObject({ owed: 5174.62, sent: 0 });
    expect(dueWith([pay(5174.62, "2026-09-10")])[0]).toMatchObject({ owed: 5174.62, sent: 0 });
    expect(dueWith([pay(5174.62, "2026-10-11")])[0]).toMatchObject({ owed: 5174.62, sent: 0 });
    expect(dueWith([{ ...pay(5174.62, "2026-10-03"), supplier_account_id: "acct-ace" }])[0]).toMatchObject({ sent: 0 });
  });
});

/** A PostgREST stand-in: every chain resolves to the table's canned answer and records its filters. */
function fakeSupabase(tables: Record<string, { data: unknown; error?: unknown }>) {
  const filters: string[] = [];
  const from = (table: string) => {
    const answer = { data: tables[table]?.data ?? [], error: tables[table]?.error ?? null };
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push(`${table}.${col}=${val}`);
        return chain;
      },
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(answer),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(answer).then(ok, err),
    };
    return chain;
  };
  return { client: { from }, filters };
}

describe("loadSupplierDesk: one read, the cards and the pay line", () => {
  const ORG = "org-et";
  it("brings the pay line from the same documents, every read filtered to his org", async () => {
    const { client, filters } = fakeSupabase({
      profiles: { data: { org_id: ORG } },
      supplier_invoices: { data: hisDocuments() },
      supplier_accounts: { data: ACCOUNTS },
    });
    const desk = await loadSupplierDesk(client, "user-1", TONIGHT);
    expect(desk?.payDue).toHaveLength(1);
    expect(desk?.payDue[0]).toMatchObject({ owed: 5174.62, saves: 35.5, invoices: 7 });
    for (const t of ["supplier_invoices", "bills", "bill_supplier_invoices", "supplier_aliases", "jobs", "supplier_accounts", "supplier_payments"])
      expect(filters).toContain(`${t}.org_id=${ORG}`);
  });

  it("reads his payments: a cheque dated in this cycle clears the line", async () => {
    const { client } = fakeSupabase({
      profiles: { data: { org_id: ORG } },
      // His real book: no settled paper rides on Oct 10 (see hisBook above).
      supplier_invoices: { data: hisDocuments().filter((d) => d.id !== "si-closed") },
      supplier_accounts: { data: ACCOUNTS },
      supplier_payments: { data: [{ supplier_account_id: CED, amount: 5174.62, paid_on: "2026-10-03", voided_at: null }] },
    });
    const desk = await loadSupplierDesk(client, "user-1", "2026-10-03");
    expect(desk?.payDue).toEqual([]);
  });

  it("a failed payments read is no pay line, never one that ignores a payment he made", async () => {
    const { client } = fakeSupabase({
      profiles: { data: { org_id: ORG } },
      supplier_invoices: { data: hisDocuments() },
      supplier_accounts: { data: ACCOUNTS },
      supplier_payments: { data: null, error: { message: "boom" } },
    });
    const desk = await loadSupplierDesk(client, "user-1", TONIGHT);
    expect(desk?.payDue).toEqual([]);
  });

  it("a failed accounts read is no pay line (there would be no sheet to open), never a crash", async () => {
    const { client } = fakeSupabase({
      profiles: { data: { org_id: ORG } },
      supplier_invoices: { data: hisDocuments() },
      supplier_accounts: { data: null, error: { message: "boom" } },
    });
    const desk = await loadSupplierDesk(client, "user-1", TONIGHT);
    expect(desk?.payDue).toEqual([]);
  });

  it("a failed bills read drops the cards (they would be false) but not the pay line, which no bill changes", async () => {
    const { client } = fakeSupabase({
      profiles: { data: { org_id: ORG } },
      supplier_invoices: { data: hisDocuments() },
      bills: { data: null, error: { message: "boom" } },
      supplier_accounts: { data: ACCOUNTS },
    });
    const desk = await loadSupplierDesk(client, "user-1", TONIGHT);
    expect(desk?.papers).toBeNull();
    expect(desk?.payDue).toHaveLength(1);
    // And it says the cards couldn't be checked (audit v1018, class 2).
    expect(desk?.failed).toEqual({ papers: true, pay: false });
  });
});

/**
 * NOTHING SILENT ON MY DAY (audit v1018, class 2). On Oct 8 a failed read of any of the desk's
 * reads used to leave no Supplier Bills line and no "Pay CED By Oct 10" line, which reads exactly
 * like "nothing waiting, no discount due". Now the desk says which half it lost, and My Day carries
 * one undated line pointing at /bills.
 */
describe("a failed supplier read says so on My Day", () => {
  const ORG = "org-et";
  const deskWith = (tables: Record<string, { data: unknown; error?: unknown }>) =>
    loadSupplierDesk(fakeSupabase({ profiles: { data: { org_id: ORG } }, supplier_accounts: { data: ACCOUNTS }, ...tables }).client, "user-1", "2026-10-08");

  it("the supplier's papers unread: no cards, no pay line, and both halves said", async () => {
    const desk = await deskWith({ supplier_invoices: { data: null, error: { code: "57014", message: "timeout" } } });
    expect(desk).toEqual({ papers: null, payDue: [], failed: { papers: true, pay: true } });
    const item = supplierDeskFailedItem(desk)!;
    expect(item).toMatchObject({ title: "Supplier Bills · Couldn't Check", when: null, urgency: 1, href: "/bills", kind: "supplier_paper" });
    expect(item.subtitle).toContain("Couldn't read your supplier papers just now");
  });

  it("the payments or accounts unread: the cards stay, the pay line's absence is said", async () => {
    const lost: Record<string, { data: unknown; error?: unknown }>[] = [
      { supplier_payments: { data: null, error: { message: "boom" } } },
      { supplier_accounts: { data: null, error: { message: "boom" } } },
    ];
    for (const t of lost) {
      const desk = await deskWith({ supplier_invoices: { data: hisDocuments() }, ...t });
      expect(desk?.payDue).toEqual([]);
      expect(desk?.papers).not.toBeNull();
      expect(desk?.failed).toEqual({ papers: false, pay: true });
      expect(supplierDeskFailedItem(desk)?.subtitle).toContain("a discount deadline may be missing here");
    }
  });

  it("every read answered: no such line, and no documents at all is still nothing to bring", async () => {
    const desk = await deskWith({ supplier_invoices: { data: hisDocuments() } });
    expect(desk?.failed).toBeUndefined();
    expect(supplierDeskFailedItem(desk)).toBeNull();
    expect(await deskWith({ supplier_invoices: { data: [] } })).toBeNull();
  });

  it("My Day turns a thrown desk read into the same line, never a quiet nothing", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(src).not.toContain("loadSupplierDesk(supabase, userId, todayStr).catch(() => null)");
    expect(src).toContain("failed: { papers: true, pay: true }");
    expect(src).toContain("supplierDeskFailedItem(await supplierDeskP)");
  });
});
