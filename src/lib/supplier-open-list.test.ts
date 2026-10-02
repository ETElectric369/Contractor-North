import { describe, expect, it } from "vitest";
import { parseCSV } from "@/lib/csv";
import { describePaper, fileRefusal, OPEN_LIST_NOT_FILED, readinessOf } from "@/lib/paperwork";
import {
  columnsFromRemembered,
  discountLine,
  kindFromTypeWords,
  isLineItemHeader,
  looksLikePaperNumber,
  openListFromReader,
  closeCutoff,
  looksLikeStatementText,
  openListFromStatementText,
  openListFromText,
  planHeadline,
  readDate,
  readMoney,
  readOpenListTable,
  reconcileOpenList,
  rememberColumns,
  tableFromText,
  type OpenList,
  type OpenListPaper,
} from "./supplier-open-list";
import { r2, supplierNetIfPaidBy, supplierSaysBalance } from "@/app/(app)/bills/supplier-balance";
import { supplierPayDue } from "@/app/(app)/bills/supplier-pay-due";
import type { SupplierInvoiceRow } from "@/app/(app)/bills/supplier-reconcile";

/**
 * FIXTURE 1: a CED portal Open tab, 2026-09-26 (account AC-10427, Total Balance $3,273.94, 11
 * documents), in the portal's own columns. The engine knows none of these names; they are here to
 * prove the header words find them.
 */
const CED_OPEN_CSV = `File,Note,Reference #,Account #,Type,PO Number,Inv Date,Due Date,Inv Amt,Disc Amt,Disc Date,Paid Online,Open Balance,Ship Addr,Dnld
,,8802-1107338,AC-10427,Invoice,ARR106,09/03/2026,10/15/2026,$223.29,$4.10,10/10/2026,,$223.29,,
,,8802-1106969,AC-10427,Invoice,13897 HONEYSUCKLE,09/04/2026,10/15/2026,$301.81,$5.54,10/10/2026,,$301.81,,
,,8802-1107695,AC-10427,Invoice,41 LARKSPUR,09/16/2026,10/15/2026,"$1,062.18",$8.47,10/10/2026,,"$1,062.18",,
,,8802-1107820,AC-10427,Invoice,41 LARKSPUR,09/16/2026,10/15/2026,$187.64,$1.77,10/10/2026,,$187.64,,
,,8802-1108330,AC-10427,Invoice,518 CINDER LAKE,09/17/2026,10/15/2026,$653.25,,,,$653.25,,
,,8802-1108534,AC-10427,Invoice,13897 HONEYSUCKLE,09/22/2026,10/15/2026,$873.66,$10.02,10/10/2026,,$873.66,,
,,8802-1108540,AC-10427,Credit Memo,518 CINDER LAKE,09/22/2026,10/15/2026,-$82.10,,,,-$82.10,,
,,8802-1108541,AC-10427,Credit Memo,518 CINDER LAKE,09/22/2026,10/15/2026,-$115.33,,,,-$115.33,,
,,8802-1108647,AC-10427,Invoice,13897 HONEY,09/23/2026,10/15/2026,$103.99,,,,$103.99,,
,,8802-1108648,AC-10427,Credit Memo,13897 HONEYSUCKLE,09/23/2026,10/15/2026,-$51.58,-$0.47,10/10/2026,,-$51.58,,
,,8802-1108649,AC-10427,Invoice,ARR99,09/23/2026,10/15/2026,$147.92,$1.36,10/10/2026,,$147.92,,
`;

const ACCOUNT = "acct-supplier-1";

/** The app's 24 open papers on that account before the list (production, 2026-09-26). */
const APP_OPEN: [string, string, string, number, number, number | null, string | null][] = [
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

const papersOf = (rows = APP_OPEN, account: string | null = ACCOUNT): OpenListPaper[] =>
  rows.map(([n, kind, d, total, open, disc, dby], i) => ({
    id: `p${i}`,
    invoiceNumber: n,
    kind,
    invoiceDate: d,
    dueDate: null,
    total,
    openBalance: open,
    closed: false,
    discountAmount: disc,
    discountBy: dby,
    jobNameRaw: null,
    supplierAccountId: account,
  }));

function cedList(extra: Partial<OpenList> = {}): OpenList {
  const read = readOpenListTable({ table: parseCSV(CED_OPEN_CSV), from: "file", name: "Open.csv", listDate: "2026-09-26", listDateFrom: "file" });
  if (!read.ok) throw new Error("the CED fixture did not read");
  return { ...read.list, ...extra };
}

describe("in the tray", () => {
  it("a waiting list is its own card, and File It refuses it in words", () => {
    const item = { id: "p", status: "needs_review", doc_type: "statement", kind: "job_document", proposal: { openList: { list: cedList(), needs: null } } };
    expect(readinessOf(item).state).toBe("open_list");
    expect(fileRefusal(item, { type: "job", jobId: "j" })).toBe(OPEN_LIST_NOT_FILED);
    expect(fileRefusal(item, { type: "keep" })).toBe(OPEN_LIST_NOT_FILED);
    expect(fileRefusal(item, { type: "photo", jobId: "j" })).toBe(OPEN_LIST_NOT_FILED);
    expect(describePaper(item)).toBe("Supplier's Open List, 11 papers");
  });
});

describe("reading values", () => {
  it("reads money the ways suppliers print it", () => {
    expect(readMoney("$1,062.18")).toBe(1062.18);
    expect(readMoney("-$82.10")).toBe(-82.1);
    expect(readMoney("($82.10)")).toBe(-82.1);
    expect(readMoney("82.10-")).toBe(-82.1);
    expect(readMoney("82.10 CR")).toBe(-82.1);
    expect(readMoney("")).toBeNull();
    expect(readMoney("Invoice")).toBeNull();
  });
  it("reads dates, and an Excel serial only in a date column", () => {
    expect(readDate("09/03/2026")).toBe("2026-09-03");
    expect(readDate("9/3/26")).toBe("2026-09-03");
    expect(readDate("02-12-26")).toBe("2026-02-12");
    expect(readDate("2026-09-03")).toBe("2026-09-03");
    expect(readDate("Sep 3, 2026")).toBe("2026-09-03");
    expect(readDate("46268", true)).toBe("2026-09-03");
    expect(readDate("46268")).toBeNull();
    expect(readDate("13/40/26")).toBeNull();
  });
  it("reads the kind from the type words; a payment is not a paper", () => {
    expect(kindFromTypeWords("Invoice", 10)).toBe("invoice");
    expect(kindFromTypeWords("Credit Memo", -10)).toBe("credit_memo");
    expect(kindFromTypeWords("CRM", -10)).toBe("credit_memo");
    expect(kindFromTypeWords("SVC", 14)).toBe("service_charge");
    expect(kindFromTypeWords("Finance Charge", 14)).toBe("service_charge");
    expect(kindFromTypeWords("PP", 22.84)).toBe("invoice"); // a partial pay is an invoice with part paid
    expect(kindFromTypeWords("Payment", -500)).toBe("payment");
    expect(kindFromTypeWords("Unapplied Cash", -500)).toBe("payment");
    expect(kindFromTypeWords("", -5)).toBe("credit_memo");
  });
});

describe("the CED portal's Open tab (fixture 1)", () => {
  it("finds every column by its header words", () => {
    const list = cedList();
    expect(list.rows).toHaveLength(11);
    expect(list.skipped).toEqual([]);
    expect(list.accountNumber).toBe("AC-10427");
    const memo = list.rows.find((r) => r.reference === "8802-1108648")!;
    expect(memo).toMatchObject({ kind: "credit_memo", po: "13897 HONEYSUCKLE", invoiceDate: "2026-09-23", dueDate: "2026-10-15", openBalance: -51.58, discountAmount: -0.47, discountBy: "2026-10-10" });
  });

  it("closes exactly the 16 papers CED no longer lists, adds the 3 it lacks, and lands on CED's figure", () => {
    const plan = reconcileOpenList(cedList(), papersOf(), ACCOUNT);
    expect(plan.close).toHaveLength(16);
    expect(plan.totals.closed).toBe(2070.22);
    expect(plan.add.map((a) => a.number)).toEqual(["8802-1108647", "8802-1108648", "8802-1108649"]);
    expect(plan.totals.added).toBe(200.33);
    expect(plan.update).toEqual([]);
    expect(plan.same).toHaveLength(8);
    expect(plan.totals.before).toBe(5174.62);
    // The gross, the sum of the 11 open balances, to the cent.
    expect(plan.totals.after).toBe(3304.73);
    // CED's Total Balance is the gross less every discount still available.
    expect(plan.totals.listDiscount).toBe(30.79);
    expect(discountLine(plan)).toBe("After $30.79 of prompt-pay discount on the list: $3,273.94.");
    // No printed total in a download: a person has to say it is the whole list.
    expect(plan.complete.ok).toBe(false);
    expect(plan.complete.said).toContain("$3,304.73");
    expect(plan.complete.said).toContain("$3,273.94");
  });

  it("is whole when CED's own Total Balance is printed (gross less discount)", () => {
    const plan = reconcileOpenList(cedList({ printedTotal: 3273.94 }), papersOf(), ACCOUNT);
    expect(plan.complete).toMatchObject({ ok: true, how: "total_net" });
  });

  it("is whole when the supplier's own document count matches", () => {
    const plan = reconcileOpenList(cedList({ printedCount: 11 }), papersOf(), ACCOUNT);
    expect(plan.complete).toMatchObject({ ok: true, how: "count" });
  });

  it("is whole when a person says so", () => {
    const plan = reconcileOpenList(cedList({ wholeList: true }), papersOf(), ACCOUNT);
    expect(plan.complete).toMatchObject({ ok: true, how: "person" });
  });

  it("says it in one sentence, in the account's own name", () => {
    const plan = reconcileOpenList(cedList(), papersOf(), ACCOUNT);
    expect(planHeadline(plan, { from: "file" }, "Consolidated Electrical Distributors", "2026-09-26")).toBe(
      "Consolidated Electrical Distributors' open list of Sep 26: 16 papers marked paid ($2,070.22), 3 new, balance now $3,304.73.",
    );
  });

  it("reads the same list pasted from the portal (tabs)", () => {
    const tsv = parseCSV(CED_OPEN_CSV).map((r) => r.join("\t")).join("\n");
    const table = tableFromText(tsv, parseCSV);
    const read = readOpenListTable({ table, from: "paste", name: "Pasted list", listDate: "2026-09-26", listDateFrom: "today" });
    expect(read.ok && read.list.rows.length).toBe(11);
  });

  it("changes nothing when the same list is applied again", () => {
    const papers = papersOf();
    const first = reconcileOpenList(cedList(), papers, ACCOUNT);
    const closedIds = new Set(first.close.map((c) => c.id));
    const after: OpenListPaper[] = [
      ...papers.map((p) => (closedIds.has(p.id) ? { ...p, closed: true, openBalance: 0 } : p)),
      ...first.add.map((a, i) => ({
        id: `n${i}`, invoiceNumber: a.number, kind: a.row.kind, invoiceDate: a.row.invoiceDate, dueDate: a.row.dueDate, total: a.row.openBalance,
        openBalance: a.row.openBalance, closed: false, discountAmount: a.row.discountAmount, discountBy: a.row.discountBy, jobNameRaw: a.row.po, supplierAccountId: ACCOUNT,
      })),
    ];
    const again = reconcileOpenList(cedList(), after, ACCOUNT);
    expect(again.nothing).toBe(true);
    expect(again.totals.after).toBe(3304.73);
  });

  // THE PAY CARD LANDS ON CED'S TOTAL BALANCE TO THE CENT (Wave 0): the supplier counts the -$0.47
  // on credit memo 8802-1108648, and the app used to floor it at 0 and say $3,273.47.
  it("puts the Pay card on CED's own Total Balance once the list is applied", () => {
    const papers = papersOf();
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    const closedIds = new Set(plan.close.map((c) => c.id));
    const rows: SupplierInvoiceRow[] = [
      ...papers.map((p) => ({ ...p, kind: p.kind as SupplierInvoiceRow["kind"], jobId: null, jobName: null, billCount: 0, ...(closedIds.has(p.id) ? { closed: true, openBalance: 0 } : {}) })),
      ...plan.add.map((a, i) => ({
        id: `n${i}`, invoiceNumber: a.number, kind: a.row.kind as SupplierInvoiceRow["kind"], invoiceDate: a.row.invoiceDate, dueDate: a.row.dueDate, total: a.row.openBalance ?? 0,
        openBalance: a.row.openBalance, closed: false, discountAmount: a.row.discountAmount, discountBy: a.row.discountBy, jobNameRaw: a.row.po, jobId: null, jobName: null, billCount: 0, supplierAccountId: ACCOUNT,
      })),
    ];
    expect(supplierNetIfPaidBy(rows, "2026-10-10", "2026-09-26")).toMatchObject({ gross: 3304.73, discount: 30.79, net: 3273.94 });
    expect(supplierSaysBalance(rows, "2026-09-26")).toMatchObject({ gross: 3304.73, discountStillClaimable: 30.79, netIfPaidToday: 3273.94 });
    const [due] = supplierPayDue({ rows, accounts: [{ id: ACCOUNT, name: "Consolidated Electrical Distributors" }], today: "2026-09-26" });
    expect(due).toMatchObject({ owed: 3304.73, saves: 30.79, invoices: 6, payBy: "2026-10-10" });
    expect(r2(due.owed - due.saves)).toBe(3273.94);
  });
});

describe("date-aware closing", () => {
  it("leaves open a paper dated after the list: it may just be newer", () => {
    const papers = papersOf([
      ...APP_OPEN,
      ["8802-1108700", "invoice", "2026-09-27", 40, 40, null, null],
    ]);
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    expect(plan.close).toHaveLength(16);
    expect(plan.keepNewer.map((k) => k.number)).toEqual(["8802-1108700"]);
    expect(plan.totals.after).toBe(3344.73);
  });

  it("closes a paper dated on the newest listed paper's day, and leaves one the supplier may not have posted yet", () => {
    // The list is saved 9/26 and its newest paper is 9/23: a paper the app has from 9/24 to 9/26
    // (from the emailed PDF) may simply not be on the supplier's side yet.
    const papers = papersOf([
      ...APP_OPEN,
      ["8802-1108700", "invoice", "2026-09-23", 40, 40, null, null],
      ["8802-1108701", "invoice", "2026-09-26", 40, 40, null, null],
    ]);
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    expect(plan.closeBy).toBe("2026-09-23");
    expect(plan.close.map((c) => c.number)).toContain("8802-1108700");
    expect(plan.keepNewer.map((c) => c.number)).toEqual(["8802-1108701"]);
  });

  it("allows a week of posting, so a list of old papers still closes what was paid before it", () => {
    // Only one old paper is still open on the supplier's side; everything up to a week before the
    // list's date that it doesn't list was paid.
    const list = cedList({ rows: cedList().rows.filter((r) => r.reference === "8802-1107338") });
    expect(closeCutoff(list)).toBe("2026-09-19");
    const plan = reconcileOpenList({ ...list, wholeList: true }, papersOf(), ACCOUNT);
    expect(plan.close.map((c) => c.number)).toContain("8802-1108330"); // 9/17
    expect(plan.keepNewer.map((c) => c.number)).toEqual(["8802-1108534", "8802-1108540", "8802-1108541"]); // 9/22
  });

  it("closes nothing from a list whose papers carry no dates of their own", () => {
    const list = cedList({ rows: cedList().rows.map((r) => ({ ...r, invoiceDate: null })), wholeList: true });
    const plan = reconcileOpenList(list, papersOf(), ACCOUNT);
    expect(plan.closeBy).toBeNull();
    expect(plan.close).toEqual([]);
    expect(plan.keepUndated).toHaveLength(16);
  });

  it("leaves open a paper with no date, and names it", () => {
    const papers = papersOf([...APP_OPEN, ["X-1", "invoice", "", 40, 40, null, null]]).map((p) => (p.invoiceNumber === "X-1" ? { ...p, invoiceDate: null } : p));
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    expect(plan.keepUndated.map((k) => k.number)).toEqual(["X-1"]);
  });

  it("never touches a listed number that sits on another supplier's account", () => {
    const papers = papersOf().map((p) => (p.invoiceNumber === "8802-1108330" ? { ...p, supplierAccountId: "someone-else" } : p));
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    expect(plan.conflicts.map((c) => c.number)).toEqual(["8802-1108330"]);
    expect(plan.update.find((u) => u.number === "8802-1108330")).toBeUndefined();
  });

  it("brings a listed paper with no account onto this one", () => {
    const papers = papersOf().map((p) => (p.invoiceNumber === "8802-1108534" ? { ...p, supplierAccountId: null } : p));
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    expect(plan.update).toEqual([
      expect.objectContaining({ number: "8802-1108534", wrote: { supplier_account_id: ACCOUNT }, prior: { supplier_account_id: null } }),
    ]);
    expect(plan.totals.after).toBe(3304.73);
  });

  it("the same number on two accounts (0354): the list reads its own account's paper, whichever id comes first", () => {
    const N = "8802-1108330";
    const own = papersOf().map((p) => (p.invoiceNumber === N ? { ...p, openBalance: 700 } : p));
    const mine = own.find((p) => p.invoiceNumber === N)!;
    // Another supplier's paper with the same number, and a copy on no account, both loaded first.
    const theirs = { ...mine, id: "a-other", supplierAccountId: "someone-else", openBalance: 500 };
    const loose = { ...mine, id: "a-none", supplierAccountId: null, openBalance: 500 };
    const plan = reconcileOpenList(cedList(), [theirs, loose, ...own], ACCOUNT);
    expect(plan.conflicts).toEqual([]);
    const u = plan.update.filter((x) => x.number === N);
    expect(u).toEqual([expect.objectContaining({ id: mine.id, wrote: expect.objectContaining({ open_balance: 653.25 }) })]);
  });

  it("with no paper on this account, a copy on no account comes before another supplier's", () => {
    const N = "8802-1108330";
    const rest = papersOf().filter((p) => p.invoiceNumber !== N);
    const base = papersOf().find((p) => p.invoiceNumber === N)!;
    const theirs = { ...base, id: "a-other", supplierAccountId: "someone-else" };
    const loose = { ...base, id: "a-none", supplierAccountId: null };
    const plan = reconcileOpenList(cedList(), [theirs, loose, ...rest], ACCOUNT);
    expect(plan.conflicts).toEqual([]);
    expect(plan.update.filter((x) => x.number === N)).toEqual([
      expect.objectContaining({ id: "a-none", wrote: { supplier_account_id: ACCOUNT } }),
    ]);
    // Only another supplier's paper holds it: left alone, and said.
    const only = reconcileOpenList(cedList(), [theirs, ...rest], ACCOUNT);
    expect(only.conflicts.map((c) => c.number)).toEqual([N]);
  });

  it("reopens a paper the supplier still lists as open, and says so", () => {
    const papers = papersOf().map((p) => (p.invoiceNumber === "8802-1108330" ? { ...p, closed: true, openBalance: 0 } : p));
    const plan = reconcileOpenList(cedList(), papers, ACCOUNT);
    const u = plan.update.find((x) => x.number === "8802-1108330")!;
    expect(u.wrote).toMatchObject({ open_balance: 653.25, closed: false });
    expect(u.prior).toMatchObject({ open_balance: 0, closed: true });
  });
});

/**
 * FIXTURE 2: A DIFFERENT SUPPLIER, A DIFFERENT SHAPE. A lumber yard's "Invoice #, Date, Amount,
 * Balance" export, with a part-paid invoice, a payment line and a total row. Nothing about CED.
 */
const LUMBER_CSV = `Customer Statement - Open Items
Invoice #,Date,Amount,Balance
L-20417,8/28/26,512.40,212.40
L-20455,9/2/26,88.15,88.15
L-20460,9/9/26,1450.00,1450.00
PMT-5521,9/15/26,,-100.00
Total,,,"$1,650.55"
`;

describe("any supplier's list (fixture 2)", () => {
  const read = () => {
    const r = readOpenListTable({ table: parseCSV(LUMBER_CSV), from: "file", name: "yard.csv", listDate: "2026-09-20", listDateFrom: "file" });
    if (!r.ok) throw new Error("fixture 2 did not read");
    return r.list;
  };
  it("finds its columns and its printed total", () => {
    const list = read();
    expect(list.rows.map((r) => r.reference)).toEqual(["L-20417", "L-20455", "L-20460", "PMT-5521"]);
    expect(list.printedTotal).toBe(1650.55);
    expect(list.rows[0]).toMatchObject({ amount: 512.4, openBalance: 212.4, invoiceDate: "2026-08-28" });
  });

  it("marks a part payment, adds the new one, counts the payment and closes what is gone", () => {
    const list = { ...read(), rows: read().rows.map((r) => (r.reference === "PMT-5521" ? { ...r, kind: "payment" as const } : r)) };
    const papers: OpenListPaper[] = [
      { id: "a", invoiceNumber: "L-20417", kind: "invoice", invoiceDate: "2026-08-28", dueDate: null, total: 512.4, openBalance: 512.4, closed: false, discountAmount: null, discountBy: null, jobNameRaw: null, supplierAccountId: "yard" },
      { id: "b", invoiceNumber: "L-20455", kind: "invoice", invoiceDate: "2026-09-02", dueDate: null, total: 88.15, openBalance: 88.15, closed: false, discountAmount: null, discountBy: null, jobNameRaw: null, supplierAccountId: "yard" },
      { id: "c", invoiceNumber: "L-20399", kind: "invoice", invoiceDate: "2026-08-20", dueDate: null, total: 300, openBalance: 300, closed: false, discountAmount: null, discountBy: null, jobNameRaw: null, supplierAccountId: "yard" },
      { id: "d", invoiceNumber: "L-20480", kind: "invoice", invoiceDate: "2026-09-24", dueDate: null, total: 70, openBalance: 70, closed: false, discountAmount: null, discountBy: null, jobNameRaw: null, supplierAccountId: "yard" },
    ];
    const plan = reconcileOpenList(list, papers, "yard");
    expect(plan.close.map((c) => c.number)).toEqual(["L-20399"]);
    expect(plan.keepNewer.map((c) => c.number)).toEqual(["L-20480"]);
    expect(plan.update).toEqual([expect.objectContaining({ number: "L-20417", wrote: { open_balance: 212.4 }, prior: { open_balance: 512.4 } })]);
    expect(plan.add.map((a) => a.number)).toEqual(["L-20460"]);
    expect(plan.payments.map((p) => p.reference)).toEqual(["PMT-5521"]);
    expect(plan.complete).toMatchObject({ ok: true, how: "total" });
    expect(planHeadline(plan, { from: "file" }, "Tahoe Lumber", "2026-09-26")).toBe(
      "Tahoe Lumber's open list of Sep 20: 1 paper marked paid ($300.00), 1 new, 1 changed, balance now $1,720.55 after $100.00 of payment Tahoe Lumber hasn't applied to a paper yet.",
    );
    // The balance it leads with is the supplier's own figure, net of the unapplied payment.
    expect(plan.totals.after).toBe(1820.55);
    expect(plan.totals.afterNet).toBe(1720.55);
  });

  it("refuses to call a list whole when its rows don't add to its printed total, and no one's word overrides it", () => {
    const short = parseCSV(LUMBER_CSV).filter((r) => r[0] !== "L-20460");
    const r = readOpenListTable({ table: short, from: "file", name: "yard.csv", listDate: "2026-09-20", listDateFrom: "file" });
    if (!r.ok) throw new Error("did not read");
    const papers: OpenListPaper[] = [
      { id: "c", invoiceNumber: "L-20399", kind: "invoice", invoiceDate: "2026-08-20", dueDate: null, total: 300, openBalance: 300, closed: false, discountAmount: null, discountBy: null, jobNameRaw: null, supplierAccountId: "yard" },
    ];
    for (const wholeList of [false, true]) {
      const plan = reconcileOpenList({ ...r.list, wholeList }, papers, "yard");
      expect(plan.complete).toMatchObject({ ok: false, overridable: false });
      expect(plan.complete.said).toContain("$1,650.55");
      // What it would have marked paid stays open, and is shown.
      expect(plan.close).toEqual([]);
      expect(plan.keepPartial.map((p) => p.number)).toEqual(["L-20399"]);
      expect(planHeadline(plan, { from: "file" }, "Tahoe Lumber", "2026-09-26")).toContain("1 paper it doesn't list left open (it is missing papers)");
    }
  });
});

describe("the column picker, once per supplier", () => {
  const ODD = `Doc Ref Code,When,Still Owing\nQ-1001,09/01/26,10.00\nQ-1002,09/05/26,20.00\n`;
  it("asks when the headers say nothing it knows", () => {
    const r = readOpenListTable({ table: parseCSV(ODD), from: "file", name: "odd.csv", listDate: "2026-09-26", listDateFrom: "file" });
    expect(r.ok).toBe(false);
    if (r.ok || !("needs" in r)) throw new Error("expected a column question");
    expect(r.needs.missing).toEqual(["reference", "openBalance"]);
    expect(r.needs.raw).toHaveLength(3);
  });

  it("reads with a person's choice, and remembers it by header for next time", () => {
    const table = parseCSV(ODD);
    const r = readOpenListTable({ table, from: "file", name: "odd.csv", listDate: "2026-09-26", listDateFrom: "file", columns: { reference: 0, invoiceDate: 1, openBalance: 2 }, headerRow: 0 });
    expect(r.ok && r.list.rows.map((x) => x.openBalance)).toEqual([10, 20]);
    const remembered = rememberColumns({ reference: 0, invoiceDate: 1, openBalance: 2 }, table[0], 3);
    // Next month the supplier moved a column; the header words still find them.
    const moved = [["When", "Doc Ref Code", "Still Owing"]];
    expect(columnsFromRemembered(remembered, moved[0], 3)).toEqual({ reference: 1, invoiceDate: 0, openBalance: 2 });
  });
});

describe("a statement PDF's text", () => {
  /** A monthly statement whose text layer comes out one column at a time (CED's does). */
  const COLUMNS = `STATEMENT
ACCOUNT
AC-10427
LOCATION
8802
DATE
05/25/26
PAGE
1 of 1
AGE
90
60
DATE
02-12-26
05-28-26
CODE
PP
SVC
REFERENCE
8802-1093225
8802-9019059048
CUSTOMER PO #
AMOUNT
22.84
14.00
TOTAL DUE
$36.84
`;
  it("zips a column-wise statement back into rows, with its date, account and total", () => {
    const list = openListFromStatementText(COLUMNS, "statement.pdf")!;
    expect(list).not.toBeNull();
    expect(list.listDate).toBe("2026-05-25");
    expect(list.accountNumber).toBe("AC-10427");
    expect(list.printedTotal).toBe(36.84);
    expect(list.rows.map((r) => [r.reference, r.kind, r.invoiceDate, r.openBalance])).toEqual([
      ["8802-1093225", "invoice", "2026-02-12", 22.84],
      ["8802-9019059048", "service_charge", "2026-05-28", 14],
    ]);
    const plan = reconcileOpenList(list, [], "a");
    expect(plan.complete.ok).toBe(true);
  });

  const LINES = `Tahoe Lumber
Statement
Statement Date: 09/20/2026
Account No: 55-0192
Invoice # Date Amount Balance Due
L-20417 08/28/2026 512.40 212.40
L-20455 09/02/2026 88.15 88.15
Total Due $300.55
`;
  it("reads a statement that keeps each row on one line", () => {
    const list = openListFromStatementText(LINES, "yard.pdf")!;
    expect(list.listDate).toBe("2026-09-20");
    expect(list.accountNumber).toBe("55-0192");
    expect(list.rows.map((r) => [r.reference, r.amount, r.openBalance])).toEqual([
      ["L-20417", 512.4, 212.4],
      ["L-20455", 88.15, 88.15],
    ]);
    expect(list.printedTotal).toBe(300.55);
  });

  it("returns nothing for text that isn't a list", () => {
    expect(openListFromStatementText("Thanks for your business.\nCall us any time.", "x.pdf")).toBeNull();
  });

  /** Any supplier's INVOICE that mentions its statement: never read as one. */
  const ACME_INVOICE = `ACME ELECTRIC SUPPLY
INVOICE
Date: 09/20/2026
Account No: 55-0192
Terms: Net 10th following statement
Please remit to the address on your statement.
Invoice Number 7731 Amount Due $229.98
Item Description Qty Price Amount
4471203 12/2 NM-B 250FT 2 89.99 179.98
5512234 SINGLE POLE BREAKER 4 12.50 50.00
Total $229.98
`;
  it("never reads an invoice that mentions its statement as a list, by any door", () => {
    expect(looksLikeStatementText(ACME_INVOICE)).toBe(false);
    for (const strict of [true, false]) {
      expect(openListFromText(ACME_INVOICE, { name: "acme.pdf", from: "file", listDate: "2026-09-26", listDateFrom: "today", parseCsv: parseCSV, strict })).toBeNull();
    }
    // Even titled a statement, item lines with no date of their own are not statement rows.
    expect(openListFromStatementText(ACME_INVOICE.replace("Item Description Qty Price Amount\n", "").replace("INVOICE", "STATEMENT"), "acme.pdf")).toBeNull();
  });

  it("knows a statement by its own title, not the bare word", () => {
    expect(looksLikeStatementText(COLUMNS)).toBe(true);
    expect(looksLikeStatementText(LINES)).toBe(true);
    expect(looksLikeStatementText(LUMBER_CSV)).toBe(true);
    expect(looksLikeStatementText("Invoice 7731\nTerms: Net 10th following statement\n")).toBe(false);
  });

  /**
   * HOURS AND RATE ARE A QUANTITY AND A PRICE (2026-10-02). A trade's time-and-materials invoice prints
   * DATE | DESCRIPTION | HOURS | RATE | AMOUNT over its own lines, and the guard that knows an invoice's
   * item table from a list of open papers only knew QTY and PRICE — so a plumber's three dated labour
   * lines read as three DEPOSITS on a bank card, because a date, a description and an amount is also the
   * shape of a card statement. A quantity is a quantity whether it is counted in pieces or in hours.
   */
  it("an invoice's item table is known by HOURS and RATE as well as by QTY and PRICE", () => {
    for (const heading of [
      "Item Description Qty Price Amount",
      "Date Description Hours Rate Amount",
      "Description Hrs Rate Amount",
      "Line Units Unit Cost Extension",
    ]) {
      expect(isLineItemHeader(heading), heading).toBe(true);
    }
    // And no heading a STATEMENT prints is mistaken for one: there is no quantity on an open list.
    for (const heading of [
      "Age Date Code Reference Customer PO# Discount Open Amount Orig Amount",
      "Date Description Withdrawals Deposits Balance",
      "Invoice Number Invoice Date Due Date Amount Open Balance",
    ]) {
      expect(isLineItemHeader(heading), heading).toBe(false);
    }
  });

  /**
   * A PAPER NUMBER IS NOT A LINE'S NAME, AND NEVER A FIGURE (2026-10-02). What decides whether a PDF
   * nobody vouched for IS a list: a proposal numbering its lines "Interior 1" read as three open bills,
   * and an aging footer's left-aligned "742.61" became a paper for $502.70.
   */
  it("knows a paper number from a line's name and from money", () => {
    for (const yes of ["7741-2203118", "INV-1042", "90412", "8802-1000001", "SC 9001", "#4471203"]) expect(looksLikePaperNumber(yes), yes).toBe(true);
    for (const no of ["Interior 1", "Trim 3", "Rough-in labor", "742.61", "$1,480.06", "(501.05)", "0.00", "09/25/26", "", "CURRENT / 1 - 30"]) {
      expect(looksLikePaperNumber(no), no).toBe(false);
    }
  });

  /**
   * AND THE READER ITSELF NEVER TAKES A FIGURE AS A PAPER NUMBER. An aging footer printed with its
   * amounts under their labels' own left x puts the CURRENT bucket in the REFERENCE column; read as a
   * paper, it invented a bill and the read report's total overshot the paper's own TOTAL DUE by it —
   * while the sentence under it blamed the parse for MISSING something.
   */
  it("a figure in the paper-number column is said out loud, never read as a paper", () => {
    const read = readOpenListTable({
      table: [
        ["Reference", "Open Balance"],
        ["8802-1000001", "10.00"],
        ["742.61", "502.70"],
      ],
      from: "file",
      name: "statement.csv",
      listDate: "2026-09-25",
      listDateFrom: "file",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.list.rows.map((r) => r.reference)).toEqual(["8802-1000001"]);
    expect(read.list.skipped.some((s) => s.why.includes("742.61"))).toBe(true);
  });

  /** A statement two pages long, each page with its own labels and the statement's total. */
  const page = (refs: string[], amts: string[], dates: string[], p: string) =>
    `STATEMENT\nACCOUNT\nAC-10427\nDATE\n09/25/26\nPAGE\n${p}\nDATE\n${dates.join("\n")}\nCODE\n${refs.map(() => "INV").join("\n")}\nREFERENCE\n${refs.join("\n")}\nAMOUNT\n${amts.join("\n")}\nTOTAL DUE\n$60.00\n`;
  it("reads every page of a column-wise statement", () => {
    const text = page(["8802-1000001", "8802-1000002"], ["10.00", "20.00"], ["09-01-26", "09-02-26"], "1 of 2") + page(["8802-1000003"], ["30.00"], ["09-03-26"], "2 of 2");
    const list = openListFromStatementText(text, "statement.pdf")!;
    expect(list.rows.map((r) => [r.reference, r.invoiceDate, r.openBalance])).toEqual([
      ["8802-1000001", "2026-09-01", 10],
      ["8802-1000002", "2026-09-02", 20],
      ["8802-1000003", "2026-09-03", 30],
    ]);
    expect(list.skipped).toEqual([]);
    expect(list.listDate).toBe("2026-09-25");
    expect(reconcileOpenList(list, [], "a").complete).toMatchObject({ ok: true, how: "total" });
  });

  it("names a page it couldn't zip, and then marks nothing paid", () => {
    const broken = page(["8802-1000003"], ["30.00"], ["09-03-26"], "2 of 2").replace("AMOUNT\n30.00\n", "");
    const text = page(["8802-1000001", "8802-1000002"], ["10.00", "20.00"], ["09-01-26", "09-02-26"], "1 of 2") + broken;
    const list = openListFromStatementText(text, "statement.pdf")!;
    expect(list.rows).toHaveLength(2);
    expect(list.skipped).toHaveLength(1);
    expect(list.skipped[0].why).toContain("8802-1000003");
    const plan = reconcileOpenList({ ...list, wholeList: true }, [], "a");
    expect(plan.complete).toMatchObject({ ok: false, overridable: false });
  });

  it("reads a statement's balance, not its original amount, when it prints both", () => {
    const text = `STATEMENT\nACCOUNT\n55-0192\nDATE\n09/25/26\nDATE\n09-01-26\n09-02-26\nREFERENCE\nL-20417\nL-20455\nAMOUNT\n512.40\n88.15\nBALANCE\n212.40\n88.15\nTOTAL DUE\n$300.55\n`;
    const list = openListFromStatementText(text, "yard.pdf")!;
    expect(list.rows.map((r) => [r.reference, r.amount, r.openBalance])).toEqual([
      ["L-20417", 512.4, 212.4],
      ["L-20455", 88.15, 88.15],
    ]);
  });

  it("takes a scanned statement a model transcribed, dated by the newest paper when none is printed", () => {
    const list = openListFromReader(
      { total_due: 300.55, lines: [{ reference: "L-20417", date: "2026-08-28", amount: 512.4, open_balance: 212.4 }, { reference: "L-20455", date: "2026-09-02", amount: 88.15, open_balance: 88.15 }] },
      "scan.jpg",
    )!;
    expect(list.from).toBe("reader");
    expect(list.listDate).toBe("2026-09-02");
    expect(list.listDateFrom).toBe("newest");
    expect(reconcileOpenList(list, [], "a").complete.ok).toBe(true);
  });
});
