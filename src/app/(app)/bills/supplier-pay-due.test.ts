import { describe, it, expect } from "vitest";
import { loadSupplierDesk, supplierDocumentRows } from "./supplier-papers";
import { supplierPayDue, PAY_CARD_WINDOW_DAYS } from "./supplier-pay-due";
import { supplierBalance, supplierNetIfPaidBy, type SupplierAccountRow } from "./supplier-balance";
import { claimableDiscounts } from "./supplier-reconcile";
import { supplierPayActionItems, supplierPayHref } from "@/lib/action-items/supplier-pay-item";

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
    expect(due[0]).toMatchObject({ accountId: CED, supplier: "CED", owed: 5174.62, saves: 35.5, invoices: 7, payBy: "2026-10-10", daysLeft: 14 });
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
    expect(due.saves).toBe(claim.total);
    expect(due.invoices).toBe(claim.rows.length);
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
    for (const t of ["supplier_invoices", "bills", "bill_supplier_invoices", "supplier_aliases", "jobs", "supplier_accounts"])
      expect(filters).toContain(`${t}.org_id=${ORG}`);
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
  });
});
