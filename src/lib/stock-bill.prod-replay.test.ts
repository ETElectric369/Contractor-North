import { describe, it, expect } from "vitest";
import pg from "pg";
import { assertReadOnlyReplay } from "@/lib/db-guard";
import { billItemisation, type BillLine } from "./bill-itemisation";
import { markupReading } from "./invoice-markup";
import { stockImportRows, stockTakesOnJob, stockTotals, type StockItemRow, type StockMoveRow } from "./stock-billing";
import { computeJobProgress } from "./job-progress-math";

/**
 * THE INV-078 / INV-079 REPLAY (Shop Stock, Phase 3): what the materials import would hand the RPC
 * for ET's two live drafts today, with the stock half switched on and off - WITHOUT WRITING. Inside
 * a READ ONLY transaction it reads each invoice, its job's receipts and the job's takes from stock,
 * runs the importer's own pure planners (billItemisation at the markup the invoice's lines already
 * carry - INV-078's 11% - and stockImportRows), and proves the offer is identical: the shelf is
 * empty, so no take exists to add a line, no figure moves, and no line on either invoice is a
 * stock line. Opt-in (STOCK_BILL_REPLAY=1) as well as creds-gated, because it reads live data that
 * stops matching the day a piece is taken.
 */
// A PRODUCTION REPLAY (db-guard.ts): REPLAY_DB_* creds, opt-in, never in CI, read-only session.
//   REPLAY_DB_HOST=… REPLAY_DB_USER=… REPLAY_DBPW=… STOCK_BILL_REPLAY=1 npx vitest run <this file>
const { REPLAY_DBPW, REPLAY_DB_HOST, REPLAY_DB_USER, STOCK_BILL_REPLAY } = process.env;
const d = REPLAY_DBPW && REPLAY_DB_HOST && REPLAY_DB_USER && STOCK_BILL_REPLAY === "1" && !process.env.CI ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";

d("INV-078 and INV-079, replayed read-only: an empty shelf changes nothing", () => {
  for (const number of ["INV-078", "INV-079"]) {
    it(`${number}: the materials offer, Unbilled and work to date are identical with the stock half on`, async () => {
      const c = new pg.Client({ host: REPLAY_DB_HOST, port: 5432, user: REPLAY_DB_USER, password: REPLAY_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
      await c.connect();
      await assertReadOnlyReplay(c);
      try {
        await c.query("begin transaction read only");
        const inv = (
          await c.query("select id, job_id, status, invoice_kind, subtotal::text, total::text from public.invoices where org_id = $1 and invoice_number = $2", [ET, number])
        ).rows[0];
        expect(inv, `${number} is not in ET's books`).toBeTruthy();
        const job = inv.job_id as string;

        // The job's takes from stock, read exactly as readJobStock reads them, org-pinned.
        const moves = (
          await c.query(
            `select id, item_id, draw_group, kind, qty, cost, created_at::text as created_at, returns_move_id, settled_by
               from public.stock_moves where org_id = $1 and job_id = $2 and undone_at is null and kind in ('draw', 'job_return', 'short')`,
            [ET, job],
          )
        ).rows as StockMoveRow[];
        const items = (await c.query("select id, name, unit from public.inventory_items where org_id = $1", [ET])).rows as StockItemRow[];
        const { takes, shorts } = stockTakesOnJob(moves, items);
        expect(moves).toEqual([]);
        expect(takes).toEqual([]);
        expect(shorts).toEqual([]);

        // The receipts and the markup the invoice's own lines carry (the keepInvoiceMarkup read).
        const bills = (
          await c.query("select id, supplier, bill_number, amount::text, po_id from public.bills where org_id = $1 and job_id = $2 and superseded_by_bill_id is null order by created_at", [ET, job])
        ).rows;
        const lines = (
          await c.query(
            "select id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount from public.bill_line_items where org_id = $1 and bill_id = any($2::uuid[]) order by sort_order",
            [ET, bills.map((b) => b.id)],
          )
        ).rows as (BillLine & { bill_id: string })[];
        const byBill = new Map<string, BillLine[]>();
        for (const l of lines) byBill.set(l.bill_id, [...(byBill.get(l.bill_id) ?? []), l]);
        const invLines = (
          await c.query("select import_key, source_ids::text[] as source_ids, line_total, edited from public.invoice_items where invoice_id = $1 and import_source = 'costs'", [inv.id])
        ).rows;
        const tomb = (await c.query("select dismissed_import_keys from public.invoices where id = $1", [inv.id])).rows[0]?.dismissed_import_keys ?? [];
        const reading = markupReading({ lines: invLines, dismissed: new Set(tomb), bills: bills.map((b) => ({ id: b.id, amount: b.amount })), linesByBill: byBill, pos: [] });
        const markup = reading.kind === "one" ? reading.pct : 15;

        const billRows = bills.filter((b) => Number(b.amount) > 0).flatMap((b) => billItemisation(b, byBill.get(b.id) ?? [], markup).map((r) => ({ ...r, source_ids: [b.id] })));
        const stock = stockImportRows(takes, markup);
        const before = billRows;
        const after = [...billRows, ...stock.rows];
        expect(after).toEqual(before);
        expect(stock.zeroCost).toEqual([]);
        expect(stockTotals(takes, markup)).toEqual({ count: 0, cost: 0, billed: 0 });

        // Work to date: the stock half adds nothing.
        const p = { billingTypeRaw: "tm", quotes: [], invoices: [], billableLabor: 0, pos: [], bills: bills.map((b) => ({ ...b, bill_line_items: byBill.get(b.id) ?? [] })), markupPercent: markup };
        expect(computeJobProgress({ ...p, stockTakes: takes })).toEqual(computeJobProgress(p));

        // And nothing on the invoice is, or claims, a piece from the shelf.
        expect(invLines.filter((l) => String(l.import_key ?? "").startsWith("stock:"))).toEqual([]);
        console.warn(
          `[stock-bill replay] ${number} (${inv.status}, ${inv.invoice_kind}): subtotal ${inv.subtotal}, total ${inv.total}; markup read off its lines ${reading.kind === "one" ? `${reading.pct}%` : reading.kind}; ${billRows.length} materials rows offered either way; 0 takes, 0 shorts.`,
        );
      } finally {
        await c.query("rollback").catch(() => undefined);
        await c.end();
      }
    });
  }
});
