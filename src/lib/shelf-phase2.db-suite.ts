/**
 * PUTTING THINGS ON THE SHELF, WHERE THE RULES LIVE (Shop Stock, Phase 2; migration 0328).
 *
 * shelf-phase2.integration.test.ts points this at the production database inside ONE transaction
 * that is always rolled back (the stock-ledger suite's pattern). 0302-0304 must already be there
 * (they are applied in production); 0328 is only functions, so when it is not on the database yet
 * the suite applies it INSIDE that same rolled-back transaction, once, under a 3 s lock timeout and
 * a 15 s statement timeout. Creating a function takes no lock on bills, invoices or jobs.
 *
 * The costs handed to shelve_bill_lines here come from planShelving (src/lib/shelf-plan.ts), the
 * same pure call shelveLines makes before it calls the database, so what is proven is the server's
 * own arithmetic landing through the database's own guards. Every fixture is dated 2001 and named
 * TEST, each case runs in its own savepoint, and it speaks as office staff, a tech and another
 * company's office exactly as PostgREST does (request.jwt.claims + set local role authenticated).
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintOrgAndStranger } from "./throwaway-org.db-fixture";
import { excludedReceiptCost, type BillLine } from "./bill-itemisation";
import { planShelving, restampPayload, type ShelfPick, type StoredLineLot } from "./shelf-plan";
import { notOnThisDatabase } from "@/lib/db-guard";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const num = (v: unknown) => Number(v);

export function defineShelfPhase2Suite(connect: () => Promise<SqlClient>) {
  let c: SqlClient;
  let ready = false;
  let appliedHere = false;
  const needs = () => {
    return ready || notOnThisDatabase("[shelf-phase2] 0302-0304 are not on this database; nothing to test against.");
  };
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherStaffId = "";
  let jobA = "";
  let seq = 0;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const step = async (fn: () => Promise<void>) => {
    await c.query("savepoint step");
    try {
      await fn();
    } finally {
      await c.query("rollback to savepoint step");
      await asServer();
    }
  };
  const refusal = async (fn: () => Promise<unknown>): Promise<{ message: string; code: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return { message: String(e?.message ?? e), code: String(e?.code ?? "") };
    }
  };

  type Line = { description: string; amount: number; quantity?: number; unit_price?: number; category?: string; billable?: boolean; billed_amount?: number | null };
  const bill = async (job: string | null, date: string, lines: Line[], onShelf = false) => {
    const amount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const b = await one(
      `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status, on_shelf, category)
       values ($1, $2, 'TEST CED', $3, $4, $5, 'unpaid', $6, $7) returning id`,
      [orgId, job, `TEST-SHELF2-${++seq}`, amount, date, onShelf, onShelf ? "Shop Stock" : "Invoice"],
    );
    const ids: string[] = [];
    for (const [i, l] of lines.entries()) {
      const r = await one(
        `insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [orgId, b.id, l.description, l.quantity ?? 1, l.unit_price ?? l.amount, l.amount, l.category ?? "Electrical", l.billable ?? true, l.billed_amount ?? null, i],
      );
      ids.push(r.id);
    }
    return { id: b.id as string, amount, lineIds: ids };
  };
  /** The bill's lines as planShelving reads them, straight from the database. */
  const linesOf = async (billId: string): Promise<(BillLine & { id: string })[]> =>
    (
      await c.query(
        "select id, description, quantity, unit_price, amount, category, billable, billed_amount from public.bill_line_items where bill_id = $1 order by sort_order",
        [billId],
      )
    ).rows.map((r) => ({ ...r, quantity: num(r.quantity), unit_price: num(r.unit_price), amount: num(r.amount), billed_amount: r.billed_amount == null ? null : num(r.billed_amount) }));
  /** Herringbone's 8/19 CED ticket, line for line (bill 11e96fc3 in ET's books). */
  const herringbone819 = (job: string | null) =>
    bill(job, "2001-08-19", [
      { description: "TEST Flexbox BH bar hanger ground", amount: 8.82, unit_price: 8.82 },
      { description: "TEST NMB 12/2 w/gnd wire 250 ft coil", amount: 165.29, quantity: 250, unit_price: 0.66 },
      { description: "TEST Flexbox single gang 16 cu in", amount: 8.9, quantity: 2, unit_price: 4.45 },
      { description: "TEST Tax at 9.000 percent", amount: 16.47, unit_price: 16.47, category: "Tax" },
    ]);
  /** What shelveLines does, against the database: plan in TypeScript, then one RPC, as `who`. */
  const shelve = async (who: string, billId: string, picks: ShelfPick[]) => {
    const lines = await linesOf(billId);
    const plan = planShelving(lines, picks);
    if (!plan.ok) throw new Error(`plan refused: ${plan.error}`);
    const live = (
      await c.query(
        "select lot_id, bill_line_id, cost, live, live_moves from public.stock_lot_balance where bill_id = $1 and live",
        [billId],
      )
    ).rows as StoredLineLot[];
    const restamp = restampPayload(live, plan.patched);
    await as(who);
    const r = (
      await one("select public.shelve_bill_lines($1, $2::jsonb, $3::jsonb) as r", [
        billId,
        JSON.stringify(
          plan.lots.map((l) => ({
            line_id: l.lineId,
            billed_amount: l.billedAmount,
            pieces: l.pieces,
            unit: l.unit,
            cost: l.cost,
            item_id: l.itemId,
            item_name: l.newItemName,
            key_part: l.keyPart,
          })),
        ),
        JSON.stringify(restamp),
      ])
    ).r;
    await asServer();
    return { plan, r };
  };
  const problemsFor = async (billId: string) =>
    (await c.query("select problem, detail from public.stock_reconcile_problems where bill_id = $1", [billId])).rows;

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one(
      "select to_regclass('public.stock_lots') is not null as ledger, to_regprocedure('public.shelve_bill_lines(uuid, jsonb, jsonb)') is not null as rpc",
    );
    if (!has.ledger) return;
    if (!has.rpc) {
      // 0328 is functions only. Applied HERE, once, inside the transaction that is rolled back.
      const sql = readFileSync(fileURLToPath(new URL("../../supabase/migrations/0328_putting_things_on_the_shelf.sql", import.meta.url)), "utf8");
      await c.query(sql);
      appliedHere = true;
      console.warn("[shelf-phase2] 0328 is not on this database yet; applied inside the test's own transaction, which is rolled back.");
    }
    ready = true;

    // A TEST company (owner + tech) and a stranger company, minted here and rolled back (never a live one).
    const fx = await mintOrgAndStranger(c, "shelf2");
    orgId = fx.orgId;
    techId = fx.techId;
    staffId = fx.staffId;
    otherStaffId = fx.otherStaffId;
    jobA = (
      await one(
        `insert into public.jobs (org_id, name, job_number, status, billing_type)
         values ($1, 'TEST shelf2 job A', 'TEST-SHELF2-A', 'scheduled', 'tm') returning id`,
        [orgId],
      )
    ).id;
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("0328's functions are on the database, or were applied inside this rolled-back transaction", async () => {
    if (!needs()) return;
    const r = await one(
      "select to_regprocedure('public.shelve_bill_lines(uuid, jsonb, jsonb)') is not null as a, to_regprocedure('public.stock_recount(uuid, numeric, text)') is not null as b",
    );
    expect(r).toEqual({ a: true, b: true });
    expect(typeof appliedHere).toBe("boolean");
  });

  it("Put The Rest On The Shelf on Herringbone's 8/19 coil, 0 used: the job is billed $0, the shelf holds 250 ft at $180.17, and the job's cost drops by exactly that", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const { plan, r } = await shelve(staffId, t.id, [
        { lineId: t.lineIds[1], pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "TEST 12/2 NM-B" },
      ]);
      expect(plan.lots[0]).toMatchObject({ billedAmount: 0, pieces: 250, unit: "ft", cost: 180.17 });
      expect(r.lots).toHaveLength(1);
      const lot = await one("select pieces, unit, cost, kind, bill_line_id, bought_on::text as bought_on from public.stock_lots where id = $1", [r.lots[0].lot_id]);
      expect({ ...lot, pieces: num(lot.pieces), cost: num(lot.cost) }).toEqual({
        pieces: 250,
        unit: "ft",
        cost: 180.17,
        kind: "line",
        bill_line_id: t.lineIds[1],
        bought_on: "2001-08-19",
      });
      const line = await one("select billed_amount, is_stock from public.bill_line_items where id = $1", [t.lineIds[1]]);
      expect(num(line.billed_amount)).toBe(0);
      expect(line.is_stock).toBe(true);
      const net = await one("select off_shelf, from_shelf from public.job_shelf_net where job_id = $1", [jobA]);
      expect(num(net.off_shelf)).toBe(180.17);
      expect(num(net.from_shelf)).toBe(0);
      // The job keeps $199.48 - $180.17 = $19.31, which is its own two boxes and their tax.
      expect(Math.round((t.amount - num(net.off_shelf)) * 100) / 100).toBe(19.31);
      const item = await one("select name, unit, quantity_on_hand from public.inventory_items where id = $1", [r.lots[0].item_id]);
      expect({ ...item, quantity_on_hand: num(item.quantity_on_hand) }).toEqual({ name: "TEST 12/2 NM-B", unit: "ft", quantity_on_hand: 250 });
      expect(await problemsFor(t.id)).toEqual([]);
    });
  });

  it("used on this job 60, the rest to the shelf: the job is billed what it used, the shelf holds 190 ft, and job part + roll = the ticket to the cent", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const { plan } = await shelve(staffId, t.id, [
        { lineId: t.lineIds[1], pieces: 250, used: 60, unit: "ft", bought: 250, newItemName: "TEST 12/2 NM-B" },
      ]);
      const lines = await linesOf(t.id);
      expect(lines[1].billed_amount).toBe(plan.lots[0].billedAmount);
      expect(plan.lots[0].billedAmount).toBe(39.67); // 60 x $165.29 / 250
      expect(plan.lots[0].pieces).toBe(190);
      const net = await one("select off_shelf from public.job_shelf_net where job_id = $1", [jobA]);
      expect(num(net.off_shelf)).toBe(plan.lots[0].cost);
      expect(plan.lots[0].cost).toBe(excludedReceiptCost(lines));
      expect(await problemsFor(t.id)).toEqual([]);
    });
  });

  it("a second roll off the same ticket restamps the first in the same transaction: nothing stale, and the rolls add up to what the ticket does not bill", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await bill(jobA, "2001-07-31", [
        { description: "TEST NMB 12/2 W/GND (250 ft Coil)", amount: 165.29, quantity: 250, unit_price: 0.66 },
        { description: "TEST NMB 14/2 W/GND (250 ft Coil)", amount: 111.6, quantity: 250, unit_price: 0.45 },
        { description: "TEST breakers", amount: 161.09, unit_price: 161.09 },
        { description: "TEST Tax", amount: 39.42, unit_price: 39.42, category: "Tax" },
      ]);
      await shelve(staffId, t.id, [{ lineId: t.lineIds[0], pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "TEST 12/2 A" }]);
      await shelve(staffId, t.id, [{ lineId: t.lineIds[1], pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "TEST 14/2 A" }]);
      const lots = (await c.query("select cost, cost_stale from public.stock_lot_balance where bill_id = $1 and live", [t.id])).rows;
      expect(lots.every((l) => l.cost_stale === false)).toBe(true);
      const sum = Math.round(lots.reduce((s, l) => s + num(l.cost), 0) * 100) / 100;
      expect(sum).toBe(excludedReceiptCost(await linesOf(t.id)));
      expect(await problemsFor(t.id)).toEqual([]);
    });
  });

  it("a shelf ticket (STOCK in the PO box): no job, each counted line a roll at its full share, a Not Stock line stays on the ticket", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await bill(
        null,
        "2001-07-13",
        [
          { description: "TEST RED/YELLOW CONN (R/Y+JUG)", amount: 84.85, quantity: 500, unit_price: 0.17 },
          { description: "TEST PLSTC TAPE (33+)", amount: 20.1, quantity: 2, unit_price: 10.05 },
          { description: "TEST Sales Tax", amount: 9.45, unit_price: 9.45, category: "Tax" },
        ],
        true,
      );
      const { plan } = await shelve(staffId, t.id, [{ lineId: t.lineIds[0], pieces: 500, used: 0, unit: "ea", bought: 500, newItemName: "TEST R/Y connector", keyPart: "R/Y+JUG" }]);
      // 84.85 + its share of the tax (84.85 / 104.95 of 9.45 = 7.64).
      expect(plan.lots[0].cost).toBe(92.49);
      const item = await one("select key_part from public.inventory_items where id = (select item_id from public.stock_lots where bill_line_id = $1)", [t.lineIds[0]]);
      expect(item.key_part).toBe("RYJUG");
      const tape = await one("select billed_amount, is_stock from public.bill_line_items where id = $1", [t.lineIds[1]]);
      expect(tape).toEqual({ billed_amount: null, is_stock: false });
      // A shelf ticket has no job, so no job's cost moves: nothing in job_shelf_net comes off it.
      expect((await one("select count(*)::int as n from public.stock_lot_balance where bill_id = $1 and live", [t.id])).n).toBe(1);
      expect(await problemsFor(t.id)).toEqual([]);
    });
  });

  it("all or nothing: a roll the paper can't hold writes nothing at all, not even what the job used or a new item", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const before = (await one("select count(*)::int as n from public.inventory_items where org_id = $1", [orgId])).n;
      const bad = await refusal(async () => {
        await as(staffId);
        await c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [
          t.id,
          JSON.stringify([{ line_id: t.lineIds[1], billed_amount: 0, pieces: 250, unit: "ft", cost: 999, item_name: "TEST too dear" }]),
        ]);
      });
      await asServer();
      expect(bad?.message).toContain("can't be worth more than its receipt");
      expect((await one("select billed_amount from public.bill_line_items where id = $1", [t.lineIds[1]])).billed_amount).toBeNull();
      expect((await one("select count(*)::int as n from public.inventory_items where org_id = $1", [orgId])).n).toBe(before);
    });
  });

  it("only this company's office: a tech and another company's office are refused, and nothing moves", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const payload = JSON.stringify([{ line_id: t.lineIds[1], billed_amount: 0, pieces: 250, unit: "ft", cost: 180.17, item_name: "TEST x" }]);
      for (const who of [techId, otherStaffId]) {
        const r = await refusal(async () => {
          await as(who);
          await c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [t.id, payload]);
        });
        await asServer();
        expect(r?.code).toBe("42501");
      }
      expect((await one("select billed_amount from public.bill_line_items where id = $1", [t.lineIds[1]])).billed_amount).toBeNull();
    });
  });

  it("a ticket a customer is already holding (a sent invoice claims it) is refused by name; a draft claimant is not a wall", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const inv = await one(
        `insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid) values ($1, $2, 'TEST-INV-S2', 'draft', 0, 0) returning id`,
        [orgId, jobA],
      );
      await one(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids, import_source)
         values ($1, $2, 'TEST NMB 12/2', 250, 0.76, $3::uuid[], 'costs') returning id`,
        [orgId, inv.id, [t.id]],
      );
      // Draft: goes ahead.
      await c.query("savepoint draft_ok");
      const ok = await shelve(staffId, t.id, [{ lineId: t.lineIds[1], pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "TEST 12/2 D" }]);
      expect(ok.r.lots).toHaveLength(1);
      await c.query("rollback to savepoint draft_ok");
      await asServer();
      // Sent: refused, naming the invoice.
      await c.query("update public.invoices set status = 'sent' where id = $1", [inv.id]);
      const lines = await linesOf(t.id);
      const plan = planShelving(lines, [{ lineId: t.lineIds[1], pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "TEST 12/2 S" }]);
      if (!plan.ok) throw new Error(plan.error);
      const r = await refusal(async () => {
        await as(staffId);
        await c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [
          t.id,
          JSON.stringify(plan.lots.map((l) => ({ line_id: l.lineId, billed_amount: l.billedAmount, pieces: l.pieces, unit: l.unit, cost: l.cost, item_name: l.newItemName }))),
        ]);
      });
      await asServer();
      expect(r?.message).toContain("TEST-INV-S2 has gone to the customer");
    });
  });

  it("a receipt whose ORDER a sent invoice bills is refused too, and an itemised bill:<id>:... key counts as a claim (review of Phase 2)", async () => {
    if (!needs()) return;
    const tryShelve = async (billId: string, lineId: string, name: string) => {
      const plan = planShelving(await linesOf(billId), [{ lineId, pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: name }]);
      if (!plan.ok) throw new Error(plan.error);
      const r = await refusal(async () => {
        await as(staffId);
        await c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [
          billId,
          JSON.stringify(plan.lots.map((l) => ({ line_id: l.lineId, billed_amount: l.billedAmount, pieces: l.pieces, unit: l.unit, cost: l.cost, item_name: l.newItemName }))),
        ]);
      });
      await asServer();
      return r;
    };
    await step(async () => {
      // The order was billed on a sent invoice before its receipt arrived (po_number given, so no
      // sequence is touched).
      const t = await herringbone819(jobA);
      const po = await one(
        `insert into public.purchase_orders (org_id, job_id, po_number, vendor, status, total) values ($1, $2, 'TEST-PO-S2', 'TEST CED', 'sent', 199.48) returning id`,
        [orgId, jobA],
      );
      await c.query("update public.bills set po_id = $1 where id = $2", [po.id, t.id]);
      const inv = await one(
        `insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid) values ($1, $2, 'TEST-INV-PO', 'sent', 0, 0) returning id`,
        [orgId, jobA],
      );
      await one(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, import_key, source_ids, import_source)
         values ($1, $2, 'TEST Materials PO', 1, 199.48, $3, $4::uuid[], 'costs') returning id`,
        [orgId, inv.id, `po:${po.id}`, [po.id]],
      );
      const r = await tryShelve(t.id, t.lineIds[1], "TEST 12/2 PO");
      expect(r?.message).toContain("TEST-INV-PO has gone to the customer and already bills the order this ticket delivered");
    });
    await step(async () => {
      // An older itemised row: no source_ids, only the bill:<id>:remainder key.
      const t = await herringbone819(jobA);
      const inv = await one(
        `insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid) values ($1, $2, 'TEST-INV-KEY', 'paid', 0, 0) returning id`,
        [orgId, jobA],
      );
      await one(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, import_key, import_source)
         values ($1, $2, 'TEST Supplies & tax', 1, 16.47, $3, 'costs') returning id`,
        [orgId, inv.id, `bill:${t.id}:remainder`],
      );
      const r = await tryShelve(t.id, t.lineIds[1], "TEST 12/2 KEY");
      expect(r?.message).toContain("TEST-INV-KEY has gone to the customer");
    });
  });

  it("a roll landing on an item marked inactive makes it active again: no shelf money on a hidden item", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const item = await one(
        `insert into public.inventory_items (org_id, name, unit, quantity_on_hand, reorder_point, active) values ($1, 'TEST 12/2 INACTIVE', 'ft', 0, 0, false) returning id`,
        [orgId],
      );
      const lines = await linesOf(t.id);
      const plan = planShelving(lines, [{ lineId: t.lineIds[1], pieces: 250, used: 0, unit: "ft", bought: 250, itemId: item.id }]);
      if (!plan.ok) throw new Error(plan.error);
      await as(staffId);
      await c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [
        t.id,
        JSON.stringify(plan.lots.map((l) => ({ line_id: l.lineId, billed_amount: l.billedAmount, pieces: l.pieces, unit: l.unit, cost: l.cost, item_id: l.itemId }))),
      ]);
      await asServer();
      expect((await one("select active from public.inventory_items where id = $1", [item.id])).active).toBe(true);
    });
  });

  it("Count It: fewer than the record are written off oldest roll first at cost; more are found at $0; a tech can't count", async () => {
    if (!needs()) return;
    await step(async () => {
      const t = await herringbone819(jobA);
      const { r } = await shelve(staffId, t.id, [{ lineId: t.lineIds[1], pieces: 250, used: 0, unit: "ft", bought: 250, newItemName: "TEST 12/2 C" }]);
      const itemId = r.lots[0].item_id;
      await as(staffId);
      const down = (await one("select public.stock_recount($1, 240, 'TEST count') as r", [itemId])).r;
      await asServer();
      expect(num(down.on_hand)).toBe(240);
      const lost = await one("select kind, qty, cost from public.stock_moves where item_id = $1 and kind = 'recount_down'", [itemId]);
      expect({ kind: lost.kind, qty: num(lost.qty), cost: num(lost.cost) }).toEqual({ kind: "recount_down", qty: 10, cost: 7.21 });
      await as(staffId);
      const up = (await one("select public.stock_recount($1, 245, null) as r", [itemId])).r;
      await asServer();
      expect(num(up.on_hand)).toBe(245);
      const found = await one("select qty, cost, lot_id from public.stock_moves where item_id = $1 and kind = 'recount_up'", [itemId]);
      expect({ qty: num(found.qty), cost: num(found.cost), lot_id: found.lot_id }).toEqual({ qty: 5, cost: 0, lot_id: null });
      const tech = await refusal(async () => {
        await as(techId);
        await c.query("select public.stock_recount($1, 0, null)", [itemId]);
      });
      await asServer();
      expect(tech?.code).toBe("42501");
      expect(await problemsFor(t.id)).toEqual([]);
    });
  });
}
