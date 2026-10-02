import { describe, expect, it } from "vitest";
import pg from "pg";
import { assertReadOnlyReplay } from "@/lib/db-guard";
import { parseCSV } from "@/lib/csv";
import { planHeadline, readOpenListTable, reconcileOpenList, discountLine } from "@/lib/supplier-open-list";
import { paperOf, resolveAccount, type SupplierAccountLite } from "./open-list-core";
import { supplierNetIfPaidBy, type SupplierInvoiceRow } from "./supplier-balance";

/**
 * A SUPPLIER'S OPEN LIST, REPLAYED READ-ONLY ON ET's BOOKS (2026-09-26): CED's portal Open tab of
 * 9/26 (11 documents, Total Balance $3,273.94) against the papers the app holds on that account,
 * through the same engine and the same account match the card uses, WITHOUT WRITING (the session is
 * read-only before its first statement). Prints the plan and the Pay figure after it.
 */
// A PRODUCTION REPLAY (db-guard.ts): REPLAY_DB_* creds, opt-in, never in CI, read-only session.
//   REPLAY_DB_HOST=… REPLAY_DB_USER=… REPLAY_DBPW=… OPEN_LIST_REPLAY=1 npx vitest run <this file>
const { REPLAY_DBPW, REPLAY_DB_HOST, REPLAY_DB_USER, OPEN_LIST_REPLAY } = process.env;
const d = REPLAY_DBPW && REPLAY_DB_HOST && REPLAY_DB_USER && OPEN_LIST_REPLAY === "1" && !process.env.CI ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";

const CED_OPEN_TAB_2026_09_26 = `Reference #,Account #,Type,PO Number,Inv Date,Due Date,Inv Amt,Disc Amt,Disc Date,Open Balance
8802-1107338,AC-10427,Invoice,ARR106,09/03/2026,10/15/2026,223.29,4.10,10/10/2026,223.29
8802-1106969,AC-10427,Invoice,13897 HONEYSUCKLE,09/04/2026,10/15/2026,301.81,5.54,10/10/2026,301.81
8802-1107695,AC-10427,Invoice,41 LARKSPUR,09/16/2026,10/15/2026,1062.18,8.47,10/10/2026,1062.18
8802-1107820,AC-10427,Invoice,41 LARKSPUR,09/16/2026,10/15/2026,187.64,1.77,10/10/2026,187.64
8802-1108330,AC-10427,Invoice,518 CINDER LAKE,09/17/2026,10/15/2026,653.25,,,653.25
8802-1108534,AC-10427,Invoice,13897 HONEYSUCKLE,09/22/2026,10/15/2026,873.66,10.02,10/10/2026,873.66
8802-1108540,AC-10427,Credit Memo,518 CINDER LAKE,09/22/2026,10/15/2026,-82.10,,,-82.10
8802-1108541,AC-10427,Credit Memo,518 CINDER LAKE,09/22/2026,10/15/2026,-115.33,,,-115.33
8802-1108647,AC-10427,Invoice,13897 HONEY,09/23/2026,10/15/2026,103.99,,,103.99
8802-1108648,AC-10427,Credit Memo,13897 HONEYSUCKLE,09/23/2026,10/15/2026,-51.58,-0.47,10/10/2026,-51.58
8802-1108649,AC-10427,Invoice,ARR99,09/23/2026,10/15/2026,147.92,1.36,10/10/2026,147.92
`;

d("A supplier's open list, ET's CED account, replayed read-only", () => {
  it("closes 16, adds 3, and lands on CED's own figures", async () => {
    const c = new pg.Client({ host: REPLAY_DB_HOST, port: 5432, user: REPLAY_DB_USER, password: REPLAY_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertReadOnlyReplay(c);
    let accounts: SupplierAccountLite[];
    let rows: any[];
    try {
      await c.query("begin transaction read only");
      accounts = (await c.query("select id::text, name, account_number, on_account from public.supplier_accounts where org_id = $1", [ET])).rows;
      rows = (
        await c.query(
          `select id::text, invoice_number, kind, invoice_date::text, due_date::text, total::float8 as total, open_balance::float8 as open_balance,
                  closed, discount_amount::float8 as discount_amount, discount_by::text, job_name_raw, supplier_account_id::text
             from public.supplier_invoices where org_id = $1`,
          [ET],
        )
      ).rows;
      await c.query("rollback");
    } finally {
      await c.end();
    }
    const papers = rows.map(paperOf);
    const read = readOpenListTable({ table: parseCSV(CED_OPEN_TAB_2026_09_26), from: "file", name: "CED Open tab", listDate: "2026-09-26", listDateFrom: "file", printedTotal: 3273.94, printedCount: 11 });
    if (!read.ok) throw new Error("the fixture did not read");
    const who = resolveAccount(read.list, null, accounts, papers);
    expect(who?.from).toBe("number");
    const account = accounts.find((a) => a.id === who!.id)!;
    const plan = reconcileOpenList(read.list, papers, who!.id);

    // What Apply would leave, as the Pay card reads it.
    const closed = new Set(plan.close.map((x) => x.id));
    const after: SupplierInvoiceRow[] = [
      ...papers
        .filter((p) => p.supplierAccountId === who!.id)
        .map((p) => ({ ...p, closed: p.closed || closed.has(p.id), openBalance: closed.has(p.id) ? 0 : p.openBalance, jobId: null })),
      ...plan.add.map((a, i) => ({
        id: `new-${i}`, invoiceNumber: a.number, kind: a.row.kind, invoiceDate: a.row.invoiceDate, dueDate: a.row.dueDate, jobNameRaw: a.row.po, jobId: null,
        total: a.row.amount ?? a.row.openBalance, openBalance: a.row.openBalance, closed: false, discountAmount: a.row.discountAmount, discountBy: a.row.discountBy,
      })),
    ];
    const pay = supplierNetIfPaidBy(after, "2026-10-10", "2026-09-26");

    console.log(planHeadline(plan, read.list, account.name, "2026-09-26"));
    console.log(discountLine(plan));
    console.log(plan.complete.said);
    console.log("marked paid:", plan.close.map((x) => `${x.number} ${x.date} ${x.open}`).join("; "));
    console.log("new:", plan.add.map((x) => `${x.number} ${x.row.openBalance}`).join("; "));
    console.log("changed:", plan.update.map((u) => `${u.number}: ${u.said}`).join("; ") || "none");
    console.log("left open:", [...plan.keepNewer, ...plan.keepUndated].map((x) => x.number).join("; ") || "none");
    console.log(`before ${plan.totals.before}, after ${plan.totals.after}; Pay by 10/10: gross ${pay.gross}, discount ${pay.discount}, net ${pay.net}`);

    expect(plan.close).toHaveLength(16);
    expect(plan.add).toHaveLength(3);
    expect(plan.update).toHaveLength(0);
    expect(plan.complete).toMatchObject({ ok: true, how: "total_net" });
    expect(plan.totals.after).toBe(3304.73);
    expect(pay.gross).toBe(3304.73);
  });
});
