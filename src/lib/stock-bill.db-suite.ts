/**
 * BILLING THE PIECES, WHERE THE RULES LIVE (Shop Stock, Phase 3; migration 0343).
 *
 * One scenario, the plan's own: job A files a 250 ft roll of 12/2 on its own ticket and uses none
 * of it, so the whole roll goes on the shelf ($180.17); A then takes 60 ft back off the shelf
 * (the office), and job B takes 20 ft (a tech). Each job's invoice is built the way
 * importCostsIntoInvoice builds it - the same pure planner (stock-billing.ts) fed the same read, and
 * the same RPC - and then every door around a claimed piece is tried: a second import, a second
 * invoice, a second line, a short, an undone take, another job's take, a jobless invoice, an Undo
 * and a carry-back while billed, a void that releases, and the way back from void. Costs are checked to the cent and the shelf's
 * reconcile view must stay empty.
 *
 * Written once and run against any Postgres, inside ONE transaction that is always rolled back, so
 * nothing it creates survives. It speaks as office staff and as a tech exactly as PostgREST does
 * (request.jwt.claims + role authenticated). Every fixture is named TEST.
 *
 * WHOSE BOOKS IT WRITES IN (review of this branch). It used to pick "the first org with an active
 * tech and office staff" - a live tenant (ET Electric, or Tahoe Deck on the day it was checked) -
 * and while it ran it held that company's invoice-claim lock (cn.invoice_claim:<org>) and row locks,
 * so every import and un-void in the real books waited on the test. It now writes ONLY in a company
 * of its own: right after BEGIN it mints a TEST organization with an owner and a tech inside the
 * same transaction (throwaway-org.db-fixture.ts), so no sandbox org has to exist and the rollback
 * takes the company with it. It never picks a tenant by query and refuses the three live companies
 * by id. statement_timeout bounds every statement as lock_timeout bounds a wait.
 *
 * 0343 NOT APPLIED YET: the case says so on the console and returns. Applying it here is allowed
 * ONLY when `allowDdl` is set, which the caller refuses for the production database: the triggers'
 * DDL takes table locks on invoices and invoice_items that stop every company's invoicing for as
 * long as the test's transaction is open (on 2026-09-25 at 8:35 PM that blanked the lines on a live
 * invoice). Never apply DDL to production inside a test transaction.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { billItemisation, excludedReceiptCost, shelfLotCost, type BillLine } from "./bill-itemisation";
import { stockImportRows, stockShortsSentence, stockTakesOnJob, unclaimedTakes, type StockItemRow, type StockMoveRow } from "./stock-billing";
import { jobMaterialCostFrom } from "./job-cost";
import { LIVE_ORGS, mintThrowawayOrg } from "./throwaway-org.db-fixture";
import { notOnThisDatabase } from "@/lib/db-guard";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const MIGRATION = "0343_a_piece_is_billed_once.sql";
const num = (v: unknown) => Number(v);
const cents = (n: number) => Math.round(n * 100) / 100;

export type StockBillSuiteOptions = {
  /** May the suite apply 0343 inside its own transaction? Only ever on a non-production database. */
  allowDdl: boolean;
};

export function defineStockBillSuite(connect: () => Promise<SqlClient>, opts: StockBillSuiteOptions) {
  let c: SqlClient;
  let shelfReady = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
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

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    shelfReady = (await one("select to_regclass('public.stock_moves') is not null and to_regprocedure('public.stock_draw(uuid, uuid, numeric, text, text)') is not null as ok")).ok;
    if (!shelfReady) return;
    // ITS OWN COMPANY, in this transaction, rolled back with it: an owner (the office) and a tech.
    const fx = await mintThrowawayOrg(c, { label: "stock bill", techs: 1 });
    if (LIVE_ORGS.has(fx.orgId)) throw new Error("stock-bill: refusing to write in a live company's org.");
    orgId = fx.orgId;
    techId = fx.techs[0].id;
    staffId = fx.owner.id;
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("a 250 ft roll on job A's ticket, 60 ft taken back by A and 20 ft by B: each billed once at its markup, costs exact, every other door refused", async () => {
    if (!shelfReady) {
      notOnThisDatabase("[stock-bill] the shelf (0303) is not on this database; nothing to test.");
      return;
    }
    // ── fixtures, as the server (no table-level locks beyond rows) ──
    const cust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST Stock Bill Customer') returning id", [orgId])).id as string;
    const job = async (n: string) =>
      (
        await one(
          `insert into public.jobs (org_id, customer_id, name, job_number, status, billing_type)
           values ($1, $2, $3, $4, 'in_progress', 'tm') returning id`,
          [orgId, cust, `TEST stock bill ${n}`, `TEST-SB-${n}`],
        )
      ).id as string;
    const jobA = await job("A");
    const jobB = await job("B");
    // Job A's own ticket: the coil billed to A at $0 (0 used), everything else billed in full.
    const lines = [
      { description: "TEST Flexbox BH bar hanger ground", amount: 8.82, quantity: 1, billed_amount: null as number | null, category: "Electrical" },
      { description: "TEST NMB 12/2 w/gnd wire 250 ft coil", amount: 165.29, quantity: 250, billed_amount: 0, category: "Electrical" },
      { description: "TEST Flexbox single gang 16 cu in", amount: 8.9, quantity: 2, billed_amount: null, category: "Electrical" },
      { description: "TEST Tax at 9.000 percent", amount: 16.47, quantity: 1, billed_amount: null, category: "Tax" },
    ];
    const billAmount = cents(lines.reduce((s, l) => s + l.amount, 0));
    const bill = (
      await one(
        `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status)
         values ($1, $2, 'TEST CED', $3, $4, '2001-08-19', 'unpaid') returning id`,
        [orgId, jobA, `TEST-SB-${++seq}`, billAmount],
      )
    ).id as string;
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      lineIds.push(
        (
          await one(
            `insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, sort_order)
             values ($1, $2, $3, $4, $5, $5, $6, true, $7, $8) returning id`,
            [orgId, bill, l.description, l.quantity, l.amount, l.category, l.billed_amount, i],
          )
        ).id,
      );
    }
    const billLines: (BillLine & { id: string })[] = lines.map((l, i) => ({ id: lineIds[i], ...l }));
    const item = (await one("insert into public.inventory_items (org_id, name, unit) values ($1, $2, 'ft') returning id", [orgId, `TEST 12/2 NM-B ${++seq}`])).id as string;
    const bare = (await one("insert into public.inventory_items (org_id, name, unit) values ($1, $2, 'ea') returning id", [orgId, `TEST Twister ${++seq}`])).id as string;
    const lotCost = shelfLotCost(billLines[1], billLines);
    expect(lotCost).toBe(180.17);
    await as(staffId);
    await c.query("insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, 250, 'ft', $4)", [orgId, item, lineIds[1], lotCost]);
    const takeA = (await one("select public.stock_draw($1, $2, 60, 'TEST take', null) as r", [item, jobA])).r;
    await asServer();
    await as(techId);
    const takeB = (await one("select public.stock_draw($1, $2, 20, 'TEST take', null) as r", [item, jobB])).r;
    // Taken past a shelf with nothing on it: a short, $0, never billed.
    const shortB = (await one("select public.stock_draw($1, $2, 12, 'TEST past the shelf', null) as r", [bare, jobB])).r;
    await asServer();
    expect(takeB.cost).toBeUndefined(); // a tech hears quantities, never a cost
    expect(num(shortB.short)).toBe(12);
    await as(staffId);
    const undone = (await one("select public.stock_draw($1, $2, 5, 'TEST undone', null) as r", [item, jobB])).r;
    await c.query("select public.stock_undo($1)", [undone.draw_group]);
    await asServer();

    const invoice = async (jobId: string, n: string) =>
      (
        await one(
          `insert into public.invoices (org_id, job_id, customer_id, invoice_number, status, total, amount_paid)
           values ($1, $2, $3, $4, 'draft', 0, 0) returning id`,
          [orgId, jobId, cust, n],
        )
      ).id as string;
    const invA = await invoice(jobA, "TEST-SB-INV-A");
    const invB = await invoice(jobB, "TEST-SB-INV-B");
    const invA2 = await invoice(jobA, "TEST-SB-INV-A2");

    // ── the importer's read and plan, exactly as readJobStock + importCostsCore do them ──
    const plan = async (jobId: string, invoiceId: string, markup: number) => {
      const moves = (
        await c.query(
          `select id, item_id, draw_group, kind, qty, cost, created_at::text as created_at, returns_move_id, settled_by
             from public.stock_moves
            where job_id = $1 and org_id = $2 and undone_at is null and kind in ('draw', 'job_return', 'short')`,
          [jobId, orgId],
        )
      ).rows as StockMoveRow[];
      const items = (await c.query("select id, name, unit from public.inventory_items where org_id = $1 and id = any($2::uuid[])", [orgId, [...new Set(moves.map((m) => m.item_id))]]))
        .rows as StockItemRow[];
      const { takes, shorts } = stockTakesOnJob(moves, items);
      const claimed = new Set<string>(
        (
          await c.query(
            `select unnest(it.source_ids)::text as id from public.invoice_items it join public.invoices i on i.id = it.invoice_id
              where i.org_id = $1 and i.status <> 'void' and it.invoice_id <> $2`,
            [orgId, invoiceId],
          )
        ).rows.map((r) => r.id),
      );
      const split = unclaimedTakes(takes, claimed);
      return { ...stockImportRows(split.free, markup), held: split.held, shorts, takes };
    };
    const importRows = async (invoiceId: string, rows: unknown[]) => {
      await as(staffId);
      const r = (await one("select public.upsert_imported_invoice_items($1, 'costs', $2::jsonb) as r", [invoiceId, JSON.stringify(rows)])).r;
      await asServer();
      return r;
    };
    const planA = await plan(jobA, invA, 11);
    const planB = await plan(jobB, invB, 15);
    expect(planB.shorts).toHaveLength(1);
    expect(stockShortsSentence(planB.shorts)).toContain("12 ea of TEST Twister");
    const billRows = billItemisation({ id: bill, supplier: "TEST CED", amount: billAmount }, billLines, 11).map((r) => ({ ...r, source_ids: [bill] }));

    // ── 0343, applied here when the database does not have it yet (after every fixture) ──
    const has0343 = (await one("select to_regprocedure('public.guard_stock_piece_claim()') is not null as ok")).ok;
    if (!has0343) {
      if (!opts.allowDdl) {
        notOnThisDatabase("[stock-bill] 0343 is not on this database yet, and this run may not apply DDL (never on production); nothing to test.");
        return;
      }
      const t0 = Date.now();
      await c.query(readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url)), "utf8"));
      console.warn(`[stock-bill] 0343 applied inside the test's own transaction (rolled back at the end) in ${Date.now() - t0} ms.`);
    }
    const lockedAt = Date.now();

    // ── each job billed once, at its own markup ──
    await importRows(invA, [...billRows, ...planA.rows]);
    await importRows(invB, planB.rows);
    const stockLine = async (invoiceId: string) =>
      one(
        `select description, quantity, unit, unit_price, line_total, source_ids::text[] as source_ids, line_kind, import_key
           from public.invoice_items where invoice_id = $1 and import_key like 'stock:%'`,
        [invoiceId],
      );
    const moveA = takeA.moves.map((m: any) => m.move_id);
    const moveB = takeB.moves.map((m: any) => m.move_id);
    const lineA = await stockLine(invA);
    expect([lineA.description, num(lineA.quantity), lineA.unit, num(lineA.unit_price), num(lineA.line_total)]).toEqual([
      expect.stringMatching(/^TEST 12\/2 NM-B \d+, 60 ft$/),
      60,
      "ft",
      0.8,
      48, // $43.24 x 1.11
    ]);
    expect(lineA.source_ids).toEqual(moveA);
    expect(lineA.import_key).toBe(`stock:${takeA.draw_group}`);
    const lineB = await stockLine(invB);
    expect([num(lineB.quantity), lineB.unit, num(lineB.line_total)]).toEqual([1, "ea", 16.57]); // $14.41 x 1.15
    expect(lineB.source_ids).toEqual(moveB);
    // A's receipt bills its own lines exactly as before: the coil is off it (0 used), the rest marked up.
    const billed = num(
      (await one("select coalesce(sum(line_total), 0) as t from public.invoice_items where invoice_id = $1 and import_key not like 'stock:%'", [invA])).t,
    );
    expect(billed).toBe(cents((billAmount - excludedReceiptCost(billLines)) * 1.11));

    // Costs exact: A carries its ticket less the roll plus its 60 ft; B carries exactly its 20 ft.
    const net = async (jobId: string) => {
      const r = await one("select off_shelf, from_shelf from public.job_shelf_net where org_id = $1 and job_id = $2", [orgId, jobId]);
      return { offShelf: num(r?.off_shelf ?? 0), fromShelf: num(r?.from_shelf ?? 0) };
    };
    expect(await net(jobA)).toEqual({ offShelf: 180.17, fromShelf: 43.24 });
    expect(await net(jobB)).toEqual({ offShelf: 0, fromShelf: 14.41 });
    expect(jobMaterialCostFrom(billAmount, await net(jobA))).toBe(cents(billAmount - 180.17 + 43.24));

    // ── a second import claims nothing new; a second invoice finds nothing to bill ──
    const again = await plan(jobA, invA, 11);
    expect(again.rows).toEqual(planA.rows);
    const second = await importRows(invA, [...billRows, ...again.rows]);
    expect([num(second.inserted), num(second.removed)]).toEqual([0, 0]);
    const onA2 = await plan(jobA, invA2, 11);
    expect(onA2.rows).toEqual([]);
    expect(onA2.held.map((t) => t.group)).toEqual([takeA.draw_group]);

    // ── every other door, refused in words ──
    const jobless = (
      await one(
        `insert into public.invoices (org_id, job_id, customer_id, invoice_number, status, total, amount_paid)
         values ($1, null, $2, 'TEST-SB-INV-NOJOB', 'draft', 0, 0) returning id`,
        [orgId, cust],
      )
    ).id as string;
    await as(staffId);
    const claimLine = (invoiceId: string, ids: string[]) => () =>
      c.query(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids, import_source)
         values ($1, $2, 'TEST pieces', 1, 1, $3::uuid[], 'costs')`,
        [orgId, invoiceId, ids],
      );
    expect((await refusal(claimLine(invA2, moveA)))?.message).toBe("materials already billed on TEST-SB-INV-A");
    expect((await refusal(claimLine(invA, moveA)))?.message).toContain("already on another line of this invoice");
    expect((await refusal(claimLine(invA2, moveB)))?.message).toContain("were taken for TEST-SB-B");
    expect((await refusal(claimLine(invB, [shortB.short_id])))?.message).toContain("Pieces taken past the shelf aren't billed");
    expect((await refusal(claimLine(invB, undone.moves.map((m: any) => m.move_id))))?.message).toContain("That take was undone");
    // A billed take can't be undone: the refusal names the invoice to take it off first.
    expect((await refusal(() => c.query("select public.stock_undo($1)", [takeB.draw_group])))?.message).toContain(
      "TEST-SB-INV-B already bills these pieces",
    );
    // Nor carried back to the shelf: its pieces would go back on the roll and be billed again on
    // another job under new move ids.
    const carryBack = (drawId: string) => () =>
      c.query(
        `insert into public.stock_moves (org_id, item_id, kind, qty, returns_move_id)
         select m.org_id, m.item_id, 'job_return', 1, m.id from public.stock_moves m where m.id = $1`,
        [drawId],
      );
    expect((await refusal(carryBack(moveB[0])))?.message).toContain(
      "TEST-SB-INV-B already bills these pieces. Take them off TEST-SB-INV-B first, then bring them back",
    );
    // A take is billed on its own job's invoice, never on one with no job.
    expect((await refusal(claimLine(jobless, moveB)))?.message).toContain("billed on their job's invoice");
    await asServer();

    // ── the customer's page: the take has a date, and nothing else from the shelf ──
    const token = (await one("select token from public.customer_portal_access where customer_id = $1 and org_id = $2", [cust, orgId]))?.token as string | undefined;
    if (token) {
      const page = (await one("select public.portal_job_view($1, $2) as v", [token, jobA])).v;
      const stockLines = (page?.lines ?? []).filter((l: any) => /, 60 ft$/.test(String(l.description)));
      expect(stockLines).toHaveLength(1);
      expect(stockLines[0].sources).toHaveLength(moveA.length);
      for (const s of stockLines[0].sources) {
        expect(Object.keys(s).sort()).toEqual(["at", "date"]);
        expect(s.at).toBeNull();
        expect(String(s.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(JSON.stringify(page)).not.toMatch(/180\.17|43\.24|TEST CED/);
    } else {
      console.warn("[stock-bill] the TEST customer got no portal link, so the portal date was not checked.");
    }

    // ── a take's line deleted by hand stays off (tombstoned); Start It Over brings it back ──
    await as(staffId);
    // The importer's "this is me" flag is transaction-local, and this whole suite is ONE
    // transaction; in the app every request is its own. Cleared, so the delete reads as a person's.
    await c.query("select set_config('cn.importing', '', true)");
    await c.query("delete from public.invoice_items where invoice_id = $1 and import_key = $2", [invA, `stock:${takeA.draw_group}`]);
    const tombs = async () => ((await one("select dismissed_import_keys from public.invoices where id = $1", [invA])).dismissed_import_keys ?? []) as string[];
    expect(await tombs()).toContain(`stock:${takeA.draw_group}`);
    await asServer();
    await importRows(invA, [...billRows, ...(await plan(jobA, invA, 11)).rows]);
    expect(await stockLine(invA)).toBeUndefined(); // the office's delete is a decision
    await as(staffId);
    await c.query("select public.reset_import_source($1, 'costs')", [invA]);
    expect(await tombs()).not.toContain(`stock:${takeA.draw_group}`);
    await asServer();
    await importRows(invA, [...billRows, ...(await plan(jobA, invA, 11)).rows]);
    expect((await stockLine(invA)).source_ids).toEqual(moveA);

    // ── void releases, the way back is guarded ──
    await as(staffId);
    await c.query("update public.invoices set status = 'void' where id = $1", [invB]);
    expect(num((await one("select public.stock_undo($1) as r", [takeB.draw_group])).r.undone)).toBe(1);
    expect((await refusal(() => c.query("update public.invoices set status = 'draft' where id = $1", [invB])))?.message).toContain(
      "went back on the shelf, so it can't come back from void",
    );
    await c.query("update public.invoices set status = 'void' where id = $1", [invA]);
    await claimLine(invA2, moveA)(); // released: A2 may bill A's 60 ft now
    expect((await refusal(() => c.query("update public.invoices set status = 'draft' where id = $1", [invA])))?.message).toContain(
      "already billed on TEST-SB-INV-A2",
    );
    await asServer();

    // ── the shelf still adds up ──
    const problems = (await c.query("select problem, detail from public.stock_reconcile_problems where org_id = $1 and item_id = any($2::uuid[])", [orgId, [item, bare]])).rows;
    expect(problems).toEqual([]);
    console.warn(`[stock-bill] assertions after 0343 held its locks for ${Date.now() - lockedAt} ms.`);
  });
}
