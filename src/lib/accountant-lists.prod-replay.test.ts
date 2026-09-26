import { describe, it, expect } from "vitest";
import pg from "pg";
import { assertReadOnlyReplay } from "@/lib/db-guard";
import { ACCOUNTANT_LISTS, accountantList, dataRowCount, toCsv, toolsBilledList, type AccountantInputs } from "./accountant-lists";

/**
 * EXPORT FOR ACCOUNTANT, REPLAYED READ-ONLY ON ET's BOOKS (Shop Stock, Phase 4): what each of the four
 * downloads would hold for this month, and the report-only tools list, printed - WITHOUT WRITING (no
 * download is recorded; the session is read-only before its first statement). It reads the same rows
 * readAccountantInputs reads, org-pinned, and runs the page's own pure builders.
 */
// A PRODUCTION REPLAY (db-guard.ts): REPLAY_DB_* creds, opt-in, never in CI, read-only session.
//   REPLAY_DB_HOST=… REPLAY_DB_USER=… REPLAY_DBPW=… ACCOUNTANT_REPLAY=1 [ACCOUNTANT_FROM=… ACCOUNTANT_TO=…] npx vitest run <this file>
const { REPLAY_DBPW, REPLAY_DB_HOST, REPLAY_DB_USER, ACCOUNTANT_REPLAY, ACCOUNTANT_FROM, ACCOUNTANT_TO } = process.env;
const d = REPLAY_DBPW && REPLAY_DB_HOST && REPLAY_DB_USER && ACCOUNTANT_REPLAY === "1" && !process.env.CI ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const TZ = "America/Los_Angeles";

d("Export For Accountant, ET, replayed read-only", () => {
  it("prints what each download would hold for the window", async () => {
    const c = new pg.Client({ host: REPLAY_DB_HOST, port: 5432, user: REPLAY_DB_USER, password: REPLAY_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertReadOnlyReplay(c);
    try {
      await c.query("begin transaction read only");
      const q = async (sql: string, params: unknown[] = [ET]) => (await c.query(sql, params)).rows;
      const bills = await q(
        `select id::text, supplier, bill_number, bill_date::text as bill_date, created_at::text as created_at, job_id::text, amount::text, category, on_shelf
           from public.bills where org_id = $1 and superseded_by_bill_id is null`,
      );
      const inputs: AccountantInputs = {
        items: await q("select id::text, name, unit from public.inventory_items where org_id = $1"),
        lots: await q(
          `select b.lot_id::text, b.item_id::text, b.kind, b.bill_id::text, b.pieces::text, b.unit, b.cost::text, b.bought_on::text, b.live, l.note
             from public.stock_lot_balance b join public.stock_lots l on l.id = b.lot_id where b.org_id = $1`,
        ),
        moves: await q(
          `select m.id::text, m.item_id::text, m.lot_id::text, m.job_id::text, m.kind, m.qty::text, m.cost::text, m.note, m.created_at::text,
                  m.undone_at::text, m.settled_by::text, to_jsonb(m)->>'credit_bill_id' as credit_bill_id
             from public.stock_moves m where m.org_id = $1`,
        ),
        bills: bills as AccountantInputs["bills"],
        lines: await q(
          `select l.id::text, l.bill_id::text, l.description, l.quantity::float8 as quantity, l.unit_price::float8 as unit_price, l.amount::float8 as amount,
                  l.category, l.billable, l.billed_amount::float8 as billed_amount
             from public.bill_line_items l join public.bills b on b.id = l.bill_id
            where l.org_id = $1 and b.superseded_by_bill_id is null order by l.sort_order`,
        ),
        jobs: await q("select id::text, job_number, name from public.jobs where org_id = $1"),
        claims: await q(
          `select it.source_ids::text[] as source_ids, it.import_key, i.invoice_number
             from public.invoice_items it join public.invoices i on i.id = it.invoice_id
            where it.org_id = $1 and i.status <> 'void' and it.source_ids is not null`,
        ),
      };
      await c.query("rollback");

      const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const w = { from: ACCOUNTANT_FROM || `${today.slice(0, 7)}-01`, to: ACCOUNTANT_TO || today };
      console.log(`\n=== ET Electric, ${w.from} to ${w.to} (On Hand as of ${w.to}) ===`);
      for (const l of ACCOUNTANT_LISTS) {
        const t = accountantList(l.key, inputs, w, TZ);
        console.log(`\n--- ${l.title}: ${dataRowCount(t)} row(s) ---\n${toCsv(t)}`);
        expect(t.header.length).toBeGreaterThan(0);
      }
      const billed = toolsBilledList(inputs, TZ);
      console.log(`\n--- Tools Billed To Customers (report only, on the page): ${billed.rows.length} row(s) ---\n${toCsv(billed)}`);
    } finally {
      await c.end();
    }
  });
});
