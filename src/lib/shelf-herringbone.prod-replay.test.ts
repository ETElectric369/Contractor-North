import { describe, it, expect } from "vitest";
import pg from "pg";
import { assertReadOnlyReplay } from "@/lib/db-guard";
import { billItemisation, excludedReceiptCost, type BillLine } from "./bill-itemisation";
import { planShelving, shelfCountGuess } from "./shelf-plan";
import { jobMaterialCostFrom } from "./job-cost";

/**
 * THE HERRINGBONE 8/19 REPLAY (Shop Stock, Phase 2): exactly what Put The Rest On The Shelf would do
 * to ET's live 8/19 CED ticket (bill 11e96fc3) - WITHOUT WRITING. It reads the ticket, the job and
 * the draft that bills it inside a READ ONLY transaction, runs the same pure plan shelveLines runs
 * (planShelving), and prints the payload shelve_bill_lines would receive and every figure that
 * would move. Opt-in (SHELF_REPLAY=1) as well as creds-gated, because it reads live data that
 * stops matching the moment the roll is really put on the shelf.
 *
 * The plan's numbers: the lot is $180.17 for 250 ft (the $165.29 coil plus its $14.88 share of the
 * 9% tax), about 72 cents a foot, and Herringbone's cost drops by exactly that.
 */
// A PRODUCTION REPLAY (db-guard.ts): REPLAY_DB_* creds, opt-in, never in CI, read-only session.
//   REPLAY_DB_HOST=… REPLAY_DB_USER=… REPLAY_DBPW=… SHELF_REPLAY=1 npx vitest run <this file>
const { REPLAY_DBPW, REPLAY_DB_HOST, REPLAY_DB_USER, SHELF_REPLAY } = process.env;
const d = REPLAY_DBPW && REPLAY_DB_HOST && REPLAY_DB_USER && SHELF_REPLAY === "1" && !process.env.CI ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const BILL = "11e96fc3-5bdf-421f-9fa8-e8763427bf93";

d("Herringbone 8/19: Put The Rest On The Shelf, replayed read-only against ET's live books", () => {
  it("would bill Herringbone $0 of the coil, put 250 ft on the shelf at $180.17, and take $180.17 off the job - writing nothing", async () => {
    const c = new pg.Client({ host: REPLAY_DB_HOST, port: 5432, user: REPLAY_DB_USER, password: REPLAY_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertReadOnlyReplay(c);
    try {
      await c.query("begin transaction read only");
      const bill = (
        await c.query("select id, job_id, supplier, amount, bill_date::text as bill_date, superseded_by_bill_id from public.bills where id = $1 and org_id = $2", [BILL, ET])
      ).rows[0];
      expect(bill).toBeTruthy();
      const lines = (
        await c.query(
          "select id, description, quantity, unit_price, amount, category, billable, billed_amount from public.bill_line_items where bill_id = $1 and org_id = $2 order by sort_order",
          [BILL, ET],
        )
      ).rows.map((r) => ({
        ...r,
        quantity: Number(r.quantity),
        unit_price: Number(r.unit_price),
        amount: Number(r.amount),
        billed_amount: r.billed_amount == null ? null : Number(r.billed_amount),
      })) as (BillLine & { id: string })[];
      const coil = lines.find((l) => /12\/2/.test(String(l.description)))!;
      expect(coil).toBeTruthy();
      const guess = shelfCountGuess(coil);
      const plan = planShelving(lines, [{ lineId: coil.id, pieces: guess.pieces ?? 0, used: 0, unit: guess.unit ?? "ft", bought: guess.bought, newItemName: "12/2 NM-B" }]);
      if (!plan.ok) throw new Error(plan.error);
      const lot = plan.lots[0];

      const job = (await c.query("select id, job_number, name from public.jobs where id = $1 and org_id = $2", [bill.job_id, ET])).rows[0];
      const billsTotal = Number(
        (
          await c.query(
            "select coalesce(sum(amount), 0) as t from public.bills where org_id = $1 and job_id = $2 and superseded_by_bill_id is null",
            [ET, bill.job_id],
          )
        ).rows[0].t,
      );
      const net = (await c.query("select off_shelf, from_shelf from public.job_shelf_net where org_id = $1 and job_id = $2", [ET, bill.job_id])).rows[0];
      const before = jobMaterialCostFrom(billsTotal, { offShelf: Number(net?.off_shelf ?? 0), fromShelf: Number(net?.from_shelf ?? 0) });
      const after = jobMaterialCostFrom(billsTotal, { offShelf: Number(net?.off_shelf ?? 0) + lot.cost, fromShelf: Number(net?.from_shelf ?? 0) });
      const claims = (
        await c.query(
          `select i.invoice_number, i.status, it.description, it.quantity, it.unit_price, it.line_total
             from public.invoice_items it join public.invoices i on i.id = it.invoice_id
            where i.org_id = $1 and i.status <> 'void' and (it.source_ids @> array[$2::uuid] or it.import_key = 'bill:' || $2)
            order by i.created_at`,
          [ET, BILL],
        )
      ).rows;
      const liveLots = Number((await c.query("select count(*)::int as n from public.stock_lots where org_id = $1 and unshelved_at is null and bill_line_id = $2", [ET, coil.id])).rows[0].n);

      const replay = {
        ticket: { bill: BILL, supplier: bill.supplier, date: bill.bill_date, amount: Number(bill.amount), job: `${job.job_number} ${job.name}` },
        coil: { line: coil.id, description: coil.description, amount: coil.amount, billed_amount_now: coil.billed_amount, count_suggested: `${guess.pieces} ${guess.unit} (${guess.why})` },
        shelve_bill_lines_payload: {
          p_bill: BILL,
          p_lines: [{ line_id: lot.lineId, billed_amount: lot.billedAmount, pieces: lot.pieces, unit: lot.unit, cost: lot.cost, item_id: null, item_name: lot.newItemName, key_part: null }],
          p_restamp: [],
        },
        roll: { pieces: lot.pieces, unit: lot.unit, cost: lot.cost, tax_share: Math.round((lot.cost - Number(coil.amount)) * 100) / 100, per_foot: Math.round((lot.cost / lot.pieces) * 100) / 100 },
        job_material_cost: { before, after, drops_by: Math.round((before - after) * 100) / 100 },
        ticket_split: { job_keeps: Math.round((Number(bill.amount) - lot.cost) * 100) / 100, roll: lot.cost, equals_ticket: Math.round((Number(bill.amount) - lot.cost + lot.cost) * 100) / 100 },
        owner_money_august: { materials: -lot.cost, put_on_the_shelf: +lot.cost, month_total_moves: 0 },
        invoices_billing_this_ticket: claims.map((r) => ({ invoice: r.invoice_number, status: r.status, line: r.description, qty: Number(r.quantity), unit_price: Number(r.unit_price), total: Number(r.line_total) })),
        rolls_already_on_this_line: liveLots,
        // What INV-078's materials would import for this ticket at Andrew's 15%, before and after:
        // the $190.00 coil row comes off and the supplies-and-tax row carries only the boxes' tax.
        inv078_rows_at_15pct: {
          before: billItemisation({ id: BILL, supplier: bill.supplier, amount: bill.amount }, lines, 15).map((r) => `${r.description}: ${r.quantity} x ${r.unit_price}`),
          after: billItemisation({ id: BILL, supplier: bill.supplier, amount: bill.amount }, plan.patched, 15).map((r) => `${r.description}: ${r.quantity} x ${r.unit_price}`),
        },
      };
      console.log(`[shelf-replay] ${JSON.stringify(replay, null, 2)}`);

      expect(lot).toMatchObject({ billedAmount: 0, pieces: 250, unit: "ft", cost: 180.17 });
      expect(replay.roll.tax_share).toBe(14.88);
      expect(replay.roll.per_foot).toBe(0.72);
      expect(replay.job_material_cost.drops_by).toBe(180.17);
      expect(lot.cost).toBe(excludedReceiptCost(plan.patched));
      expect(replay.inv078_rows_at_15pct.before.some((r) => /12\/2/.test(r))).toBe(true);
      expect(replay.inv078_rows_at_15pct.after.some((r) => /12\/2/.test(r))).toBe(false);
      // Nothing was written: the transaction was read only and is rolled back below.
      const ro = (await c.query("show transaction_read_only")).rows[0].transaction_read_only;
      expect(ro).toBe("on");
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
  });
});
