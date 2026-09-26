/**
 * THE SHOP SHELF DATABASE SUITE (migrations 0302, 0303, 0304), written once and run against any
 * Postgres: stock-ledger.integration.test.ts points it at the production database inside ONE
 * transaction that is always rolled back (the billing test's pattern), so nothing it creates, and
 * no migration it has to apply, survives.
 *
 * BEFORE THE MIGRATIONS ARE APPLIED, each case says so on the console and returns (loud, not a green
 * lie), exactly as split-into-entries.db-suite does - UNLESS the run sets SHELF_SUITE_APPLY=1, in
 * which case the suite applies 0302-0304 itself, from the files in supabase/migrations, inside the
 * same rolled-back transaction, so the rules can be exercised the day they are written. That is
 * opt-in on purpose: adding bills.on_shelf takes an ACCESS EXCLUSIVE lock on `bills` for as long as
 * the suite runs (about a minute), which a live app reading bills would wait on. After the
 * migrations are applied the suite simply finds them there. Either way nothing it does survives.
 *
 * It speaks as the people the rules bind - office staff, a tech, and staff of ANOTHER company - by
 * planting request.jwt.claims and `set local role authenticated`, exactly as PostgREST does. Every
 * fixture is dated 2001 and named TEST, and each case runs in its own savepoint.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintOrgAndStranger } from "./throwaway-org.db-fixture";
import { shelfLotCost, type BillLine } from "./bill-itemisation";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const MIGRATIONS = ["0302_techs_see_the_shelf_not_its_prices.sql", "0303_a_shelf_is_a_ledger.sql", "0304_used_stock_stays_put.sql"];
const num = (v: unknown) => Number(v);

export function defineStockLedgerSuite(connect: () => Promise<SqlClient>) {
  let c: SqlClient;
  let appliedHere = false;
  let ready = false;
  /** Every case starts here: false (with a console line) when the migrations are not on this database. */
  const needs = () => {
    if (!ready) console.warn("[stock-ledger] 0302-0304 are not on this database yet; set SHELF_SUITE_APPLY=1 to apply them inside the test's rolled-back transaction.");
    return ready;
  };
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherStaffId = "";
  let otherOrgId = "";
  let otherJobId = "";
  let jobA = "";
  let jobB = "";
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
  /** A statement that should be refused: its message (and SQLSTATE), or null if it went through. */
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

  // ── fixture writers, as the server ──
  type Line = { description: string; amount: number; quantity?: number; category?: string; billable?: boolean; billed_amount?: number | null };
  /** A bill on a job with its lines; returns the ids and the lines as bill-itemisation reads them. */
  const bill = async (job: string | null, date: string, lines: Line[]) => {
    const amount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const b = await one(
      `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status)
       values ($1, $2, 'TEST CED', $3, $4, $5, 'unpaid') returning id`,
      [orgId, job, `TEST-SHELF-${++seq}`, amount, date],
    );
    const ids: string[] = [];
    for (const [i, l] of lines.entries()) {
      const r = await one(
        `insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [orgId, b.id, l.description, l.quantity ?? 1, l.amount, l.amount, l.category ?? "Electrical", l.billable ?? true, l.billed_amount ?? null, i],
      );
      ids.push(r.id);
    }
    const asLines: BillLine[] = lines.map((l, i) => ({ id: ids[i], ...l }));
    return { id: b.id as string, amount, lineIds: ids, lines: asLines };
  };
  /** Herringbone's 8/19 CED ticket shape, the coil at 0 used: its lot costs $180.17. */
  const coilTicket = (job: string | null, date: string) =>
    bill(job, date, [
      { description: "TEST Flexbox BH bar hanger ground", amount: 8.82 },
      { description: "TEST NMB 12/2 w/gnd wire 250 ft coil", amount: 165.29, quantity: 250, billed_amount: 0 },
      { description: "TEST Flexbox single gang 16 cu in", amount: 8.9, quantity: 2 },
      { description: "TEST Tax at 9.000 percent", amount: 16.47, category: "Tax" },
    ]);
  const item = async (name = "TEST 12/2 NM-B", unit = "ft") =>
    (await one(`insert into public.inventory_items (org_id, name, unit) values ($1, $2, $3) returning id`, [orgId, `${name} ${++seq}`, unit])).id as string;
  /** Put a line's share on the shelf, AS STAFF, costed by the one TypeScript copy of the arithmetic. */
  const lot = async (itemId: string, t: { lineIds: string[]; lines: BillLine[] }, lineIndex: number, pieces: number, unit = "ft") => {
    const cost = shelfLotCost(t.lines[lineIndex], t.lines);
    await as(staffId);
    const r = await one(
      `insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost)
       values ($1, $2, 'line', $3, $4, $5, $6) returning id, cost, bought_on`,
      [orgId, itemId, t.lineIds[lineIndex], pieces, unit, cost],
    );
    await asServer();
    return { id: r.id as string, cost: num(r.cost), bought_on: r.bought_on };
  };
  const draw = async (who: string, itemId: string, job: string, qty: number) => {
    await as(who);
    const r = (await one("select public.stock_draw($1, $2, $3, 'TEST take', null) as r", [itemId, job, qty])).r;
    await asServer();
    return r;
  };
  const lotLeft = async (lotId: string) => one("select pieces_left, cost_left from public.stock_lot_balance where lot_id = $1", [lotId]);
  const shelfNet = async (job: string) =>
    (await one("select off_shelf, from_shelf from public.job_shelf_net where job_id = $1", [job])) ?? { off_shelf: 0, from_shelf: 0 };
  const onHand = async (itemId: string) => num((await one("select quantity_on_hand from public.inventory_items where id = $1", [itemId])).quantity_on_hand);
  const invoice = async (job: string, number: string) =>
    (
      await one(
        `insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid)
         values ($1, $2, $3, 'draft', 0, 0) returning id`,
        [orgId, job, number],
      )
    ).id as string;
  const claim = async (invoiceId: string, ids: string[]) =>
    one(
      `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids, import_source)
       values ($1, $2, 'TEST 12/2 NM-B cable', 1, 1, $3::uuid[], 'costs') returning id`,
      [orgId, invoiceId, ids],
    );

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    const has = (await one("select to_regclass('public.stock_lots') is not null as yes, to_regprocedure('public.shelf_for_crew()') is not null as crew")) as {
      yes: boolean;
      crew: boolean;
    };
    ready = has.yes && has.crew;
    if (!ready && process.env.SHELF_SUITE_APPLY === "1") {
      // Not applied yet: apply them HERE, inside the transaction that is rolled back at the end.
      for (const f of MIGRATIONS) {
        if (f.startsWith("0302") && has.crew) continue;
        if (!f.startsWith("0302") && has.yes) continue;
        const sql = readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${f}`, import.meta.url)), "utf8");
        await c.query(sql);
      }
      appliedHere = true;
      ready = true;
      console.warn("[stock-ledger] 0302-0304 are not on this database yet; applied inside the test's own transaction, which is rolled back.");
    }
    if (!ready) return;

    // A TEST company (owner + tech) and a stranger company, minted here and rolled back (never a live one).
    const fx = await mintOrgAndStranger(c, "stock-ledger");
    orgId = fx.orgId;
    techId = fx.techId;
    staffId = fx.staffId;
    otherStaffId = fx.otherStaffId;
    otherOrgId = fx.otherOrgId;
    const job = async (org: string, n: string) =>
      (
        await one(
          `insert into public.jobs (org_id, name, job_number, status, billing_type)
           values ($1, $2, $3, 'scheduled', 'tm') returning id`,
          [org, `TEST shelf job ${n}`, `TEST-SHELF-${n}`],
        )
      ).id as string;
    jobA = await job(orgId, "A");
    jobB = await job(orgId, "B");
    otherJobId = await job(otherOrgId, "X");
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("ran against the shelf's own migrations (applied here only when the database did not have them)", async () => {
    if (!needs()) return;
    const r = await one("select to_regclass('public.stock_moves') is not null as moves, to_regclass('public.job_shelf_net') is not null as net");
    expect(r).toEqual({ moves: true, net: true });
    expect(typeof appliedHere).toBe("boolean");
  });

  // ── 0302: a tech sees the shelf, not its prices ─────────────────────────────────────────────
  it("a tech reads no rows of inventory_items, stock_lots, stock_moves or job_shelf_net, and shelf_for_crew carries no cost", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      await lot(it1, t, 1, 250);
      await draw(staffId, it1, jobB, 10);
      await as(techId);
      for (const table of ["inventory_items", "stock_lots", "stock_moves", "job_shelf_net", "stock_lot_balance"]) {
        expect((await one(`select count(*)::int as n from public.${table}`)).n, table).toBe(0);
      }
      const shelf = (await c.query("select * from public.shelf_for_crew()")).rows;
      const mine = shelf.find((r) => r.id === it1);
      expect(mine).toBeTruthy();
      expect(Object.keys(mine).sort()).toEqual(["id", "name", "on_hand", "takeable", "unit"]);
      expect(num(mine.on_hand)).toBe(240);
      await asServer();
      // A stranger's session reads no one's shelf.
      await as(otherStaffId);
      expect((await c.query("select * from public.shelf_for_crew() where id = $1", [it1])).rows).toHaveLength(0);
    });
  });

  // ── 0303: the lot ────────────────────────────────────────────────────────────────────────────
  it("a lot is capped at its paper, refuses a $0.00 extension, tax and a unit the item does not count in", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const zero = await bill(jobA, "2001-08-19", [{ description: "TEST back-ordered plate", amount: 0, billed_amount: null }]);
      const ins = (lineId: string, cost: number, unit = "ft") => async () => {
        await as(staffId);
        await c.query(
          "insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, 250, $4, $5)",
          [orgId, it1, lineId, unit, cost],
        );
      };
      // The line is $165.29 and the bill's tax $16.47: the paper holds $181.76, never more.
      expect((await refusal(ins(t.lineIds[1], 181.77)))?.message).toContain("can't be worth more than its receipt");
      expect((await refusal(ins(zero.lineIds[0], 0)))?.message).toContain("$0.00");
      expect((await refusal(ins(t.lineIds[3], 1)))?.message).toContain("tax");
      expect((await refusal(ins(t.lineIds[1], 180.17, "ea")))?.message).toContain("counted in");
      // And the one written the TypeScript way goes through, dated by its ticket.
      const l = await lot(it1, t, 1, 250);
      expect(l.cost).toBe(180.17);
      expect(new Date(l.bought_on).toISOString().slice(0, 10)).toBe("2001-08-19");
    });
  });

  it("is_stock is a mirror of a live roll, and on hand is the ledger's, never typed", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const bare = await coilTicket(jobA, "2001-08-20");
      await lot(it1, t, 1, 250);
      expect((await one("select is_stock from public.bill_line_items where id = $1", [t.lineIds[1]])).is_stock).toBe(true);
      expect(await onHand(it1)).toBe(250);
      await as(staffId);
      expect((await refusal(() => c.query("update public.bill_line_items set is_stock = false where id = $1", [t.lineIds[1]])))?.message).toContain("Take it off the shelf first");
      expect((await refusal(() => c.query("update public.bill_line_items set is_stock = true where id = $1", [bare.lineIds[1]])))?.message).toContain("only while a roll");
      expect((await refusal(() => c.query("update public.inventory_items set quantity_on_hand = 999 where id = $1", [it1])))?.message).toContain("kept by the shelf");
      expect((await refusal(() => c.query("insert into public.inventory_items (org_id, name, quantity_on_hand) values ($1, 'TEST typed', 5)", [orgId])))?.message).toContain("starts with none on hand");
      await asServer();
      expect((await refusal(() => c.query("delete from public.stock_lots")))?.message).toContain("never deleted");
    });
  });

  // ── 0303: the take ───────────────────────────────────────────────────────────────────────────
  it("a take walks FIFO across two rolls under one draw group, at exactly what those pieces cost", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const older = await lot(it1, await coilTicket(jobA, "2001-07-31"), 1, 250);
      const newer = await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const first = await draw(staffId, it1, jobB, 240);
      expect(first.moves).toHaveLength(1);
      expect(num(first.moves[0].cost)).toBe(172.96); // 240 x 180.17 / 250 = 172.963
      const second = await draw(staffId, it1, jobB, 30);
      // The 10 ft left on the older coil at its exact remaining $7.21, then 20 ft of the newer.
      expect(second.moves.map((m: any) => [m.lot_id, num(m.qty), num(m.cost)])).toEqual([
        [older.id, 10, 7.21],
        [newer.id, 20, 14.41],
      ]);
      const groups = await one("select count(distinct draw_group)::int as g, count(*)::int as n from public.stock_moves where draw_group = $1", [second.draw_group]);
      expect(groups).toEqual({ g: 1, n: 2 });
      // The older coil is empty to the cent; the newer has exactly what was not taken.
      const emptied = await lotLeft(older.id);
      expect([num(emptied.pieces_left), num(emptied.cost_left)]).toEqual([0, 0]);
      expect(num((await lotLeft(newer.id)).cost_left)).toBe(165.76);
      // Job B carries what it took; job A no longer carries what went on the shelf.
      expect(num((await shelfNet(jobB)).from_shelf)).toBe(194.58);
      expect(num((await shelfNet(jobA)).off_shelf)).toBe(360.34);
      expect(await onHand(it1)).toBe(230);
    });
  });

  it("a tech takes through stock_draw and hears quantities, never a cost; a direct write is refused", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const l = await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const r = await draw(techId, it1, jobB, 60);
      expect(r.cost).toBeUndefined();
      expect(r.moves.every((m: any) => m.cost === undefined)).toBe(true);
      expect(num(r.on_hand)).toBe(190);
      // The database stamped the real cost all the same: $43.24.
      expect(num((await one("select cost from public.stock_moves where draw_group = $1", [r.draw_group])).cost)).toBe(43.24);
      expect(num((await lotLeft(l.id)).cost_left)).toBe(136.93);
      await as(techId);
      const direct = await refusal(() =>
        c.query("insert into public.stock_moves (org_id, item_id, lot_id, kind, qty) values ($1, $2, $3, 'write_off', 1)", [orgId, it1, l.id]),
      );
      expect(direct?.code).toBe("42501");
      await asServer();
      // Staff may not write a draw directly either: stock_draw is the only way pieces are taken.
      await as(staffId);
      const staffDraw = await refusal(() =>
        c.query("insert into public.stock_moves (org_id, item_id, lot_id, job_id, draw_group, kind, qty) values ($1, $2, $3, $4, gen_random_uuid(), 'draw', 1)", [
          orgId,
          it1,
          l.id,
          jobB,
        ]),
      );
      expect(staffDraw?.code).toBe("42501");
    });
  });

  it("a take past the shelf still saves, as a $0 short; settling it once a roll is filed writes real draws", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const r = await draw(staffId, it1, jobB, 270);
      expect(num(r.short)).toBe(20);
      const short = await one("select id, cost, lot_id, settled_by from public.stock_moves where id = $1", [r.short_id]);
      expect(num(short.cost)).toBe(0);
      expect(short.lot_id).toBeNull();
      expect(await onHand(it1)).toBe(-20);
      // Nothing to settle it from yet: refused with the way out.
      await as(staffId);
      expect((await refusal(() => c.query("select public.settle_short($1)", [r.short_id])))?.message).toContain("File the roll");
      await asServer();
      // The next roll is filed; the short is settled from it at that roll's real cost.
      await lot(it1, await coilTicket(jobA, "2001-09-04"), 1, 250);
      await as(staffId);
      const s = (await one("select public.settle_short($1) as r", [r.short_id])).r;
      await asServer();
      expect(num(s.cost)).toBe(14.41); // 20 x 180.17 / 250
      expect((await one("select settled_by from public.stock_moves where id = $1", [r.short_id])).settled_by).toBe(s.draw_group);
      expect(await onHand(it1)).toBe(230);
      // Settled once: a second settle is refused, and a tech never settles.
      await as(staffId);
      expect((await refusal(() => c.query("select public.settle_short($1)", [r.short_id])))?.message).toContain("already settled");
      await asServer();
      await as(techId);
      expect((await refusal(() => c.query("select public.settle_short($1)", [r.short_id])))?.code).toBe("42501");
    });
  });

  // ── claims: a piece is billed once, and a billed piece stays on the job ──────────────────────
  it("a second invoice claiming a take is refused, and the take cannot be undone while an invoice bills it", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const r = await draw(staffId, it1, jobB, 60);
      const moveIds = r.moves.map((m: any) => m.move_id);
      const inv1 = await invoice(jobB, "TEST-SHELF-INV-1");
      await claim(inv1, moveIds);
      const inv2 = await invoice(jobB, "TEST-SHELF-INV-2");
      expect((await refusal(() => claim(inv2, moveIds)))?.message).toContain("already billed on TEST-SHELF-INV-1");
      await as(staffId);
      expect((await refusal(() => c.query("select public.stock_undo($1)", [r.draw_group])))?.message).toContain(
        "TEST-SHELF-INV-1 already bills these pieces. Take them off TEST-SHELF-INV-1 first",
      );
      // The table itself refuses the same undo, however it is attempted.
      expect((await refusal(() => c.query("update public.stock_moves set undone_at = now() where id = $1", [moveIds[0]])))?.message).toContain("already bills these pieces");
      await asServer();
      // Void the invoice and the undo goes through; the pieces are back on the shelf.
      await c.query("update public.invoices set status = 'void' where id = $1", [inv1]);
      await as(staffId);
      const u = (await one("select public.stock_undo($1) as r", [r.draw_group])).r;
      await asServer();
      expect(u.undone).toBe(1);
      expect(await onHand(it1)).toBe(250);
      expect(num((await shelfNet(jobB)).from_shelf)).toBe(0);
    });
  });

  it("the shelf's record is append-only: no delete, no edit, an undo once", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const r = await draw(staffId, it1, jobB, 5);
      const id = r.moves[0].move_id;
      expect((await refusal(() => c.query("delete from public.stock_moves where id = $1", [id])))?.message).toContain("never deleted");
      expect((await refusal(() => c.query("update public.stock_moves set qty = 1 where id = $1", [id])))?.message).toContain("only undone");
      expect((await refusal(() => c.query("update public.stock_moves set cost = 0 where id = $1", [id])))?.message).toContain("only undone");
      await as(staffId);
      await c.query("select public.stock_undo($1)", [r.draw_group]);
      await asServer();
      // A second undo (a later time, a different person) is refused; the first one stands.
      expect((await refusal(() => c.query("update public.stock_moves set undone_at = now() + interval '1 minute' where id = $1", [id])))?.message).toContain(
        "already undone",
      );
    });
  });

  it("pieces carried back to the shelf reverse the take's stamped cost, pro rata", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const l = await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const r = await draw(staffId, it1, jobB, 60); // $43.24
      await as(staffId);
      await c.query(
        "insert into public.stock_moves (org_id, item_id, returns_move_id, kind, qty, source) values ($1, $2, $3, 'job_return', 15, 'office')",
        [orgId, it1, r.moves[0].move_id],
      );
      await asServer();
      const back = await one("select cost, job_id, lot_id from public.stock_moves where kind = 'job_return' and returns_move_id = $1", [r.moves[0].move_id]);
      expect(num(back.cost)).toBe(10.81); // 15 x 43.24 / 60
      expect(back.job_id).toBe(jobB);
      expect(back.lot_id).toBe(l.id);
      expect(num((await shelfNet(jobB)).from_shelf)).toBe(32.43);
      expect(await onHand(it1)).toBe(205);
      // A take with pieces brought back cannot be undone until the return is.
      await as(staffId);
      expect((await refusal(() => c.query("select public.stock_undo($1)", [r.draw_group])))?.message).toContain("brought back");
    });
  });

  // ── 0304: used stock stays put ───────────────────────────────────────────────────────────────
  it("once pieces of a roll are on a job, no line of its ticket can change, and the ticket stays put", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const l = await lot(it1, t, 1, 250);
      await draw(staffId, it1, jobB, 60);
      await as(staffId);
      const refused = async (sql: string, params: unknown[]) => (await refusal(() => c.query(sql, params)))?.message ?? null;
      // A SIBLING line, and the untouched tax line, both move the roll's tax share: frozen.
      expect(await refused("update public.bill_line_items set amount = 9.99 where id = $1", [t.lineIds[0]])).toContain("Undo the take from this roll first");
      expect(await refused("update public.bill_line_items set amount = 20 where id = $1", [t.lineIds[3]])).toContain("Undo the take");
      expect(await refused("update public.bill_line_items set category = 'Tax' where id = $1", [t.lineIds[2]])).toContain("Undo the take");
      expect(await refused("update public.bill_line_items set billed_amount = 10 where id = $1", [t.lineIds[1]])).toContain("Undo the take");
      expect(
        await refused(
          "insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount) values ($1, $2, 'TEST late line', 1, 1, 1)",
          [orgId, t.id],
        ),
      ).toContain("Undo the take");
      expect(await refused("delete from public.bill_line_items where id = $1", [t.lineIds[0]])).toContain("Undo the take");
      expect(await refused("delete from public.bills where id = $1", [t.id])).toContain("can't be deleted");
      expect(await refused("update public.bills set job_id = $2 where id = $1", [t.id, jobB])).toContain("stays where it is");
      expect(await refused("update public.stock_lots set unshelved_at = now() where id = $1", [l.id])).toContain("Undo the take");
      expect(await refused("update public.stock_lots set cost = 1 where id = $1", [l.id])).toContain("Undo the take");
      // A description is words, not money: it still saves.
      await c.query("update public.bill_line_items set description = 'TEST renamed' where id = $1", [t.lineIds[0]]);
    });
  });

  it("with no takes yet, a receipt edit marks the roll stale (nothing silent), and a restamp clears it", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const l = await lot(it1, t, 1, 250);
      await as(staffId);
      await c.query("update public.bill_line_items set amount = 20.00 where id = $1", [t.lineIds[3]]); // the tax was mis-scanned
      await asServer();
      expect((await one("select cost_stale from public.stock_lots where id = $1", [l.id])).cost_stale).toBe(true);
      const problems = (await c.query("select problem from public.stock_reconcile_problems where lot_id = $1", [l.id])).rows.map((r) => r.problem);
      expect(problems).toContain("lot_cost_stale");
      // restampLotsForBill's write: the cost the paper gives now, and the flag cleared.
      const lines = t.lines.map((x, i) => (i === 3 ? { ...x, amount: 20 } : x));
      const want = shelfLotCost(lines[1], lines);
      await as(staffId);
      await c.query("update public.stock_lots set cost = $2, cost_stale = false where id = $1", [l.id, want]);
      await asServer();
      expect(num((await one("select cost from public.stock_lots where id = $1", [l.id])).cost)).toBe(want);
      expect((await c.query("select * from public.stock_reconcile_problems where lot_id = $1", [l.id])).rows).toEqual([]);
    });
  });

  it("deleting a line whose roll has no takes takes the roll off the shelf and keeps its history", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const l = await lot(it1, t, 1, 250);
      await as(staffId);
      await c.query("delete from public.bills where id = $1", [t.id]);
      await asServer();
      const after = await one("select unshelved_at, bill_line_id from public.stock_lots where id = $1", [l.id]);
      expect(after.unshelved_at).not.toBeNull();
      expect(after.bill_line_id).toBeNull();
      expect(await onHand(it1)).toBe(0);
      expect((await refusal(() => c.query("delete from public.inventory_items where id = $1", [it1])))?.message).toContain("Mark it inactive");
    });
  });

  // ── the tenant line ──────────────────────────────────────────────────────────────────────────
  it("a take across companies is refused, both ways", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      await as(otherStaffId);
      expect((await refusal(() => c.query("select public.stock_draw($1, $2, 5)", [it1, otherJobId])))?.code).toBe("42501");
      await asServer();
      await as(staffId);
      expect((await refusal(() => c.query("select public.stock_draw($1, $2, 5)", [it1, otherJobId])))?.code).toBe("42501");
      await asServer();
      expect(await onHand(it1)).toBe(250);
    });
  });

  // ── the whole story, to the cent ─────────────────────────────────────────────────────────────
  it("two jobs, one box: A uses 60 of its own box, B takes 20 from the shelf; each bills once and the costs add to the paper", async () => {
    if (!needs()) return;
    await step(async () => {
      // The Waldow shape: a 500-count Twister box on job A's CED ticket, A used 60 ($9.29).
      const t = await bill(jobA, "2001-09-15", [
        { description: "TEST ITE 125A load center", amount: 119.26 },
        { description: "TEST IDEAL 30641 Twister 500", amount: 77.39, quantity: 500, billed_amount: 9.29 },
        { description: "TEST Sales Tax", amount: 59.39, category: "Tax" },
      ]);
      const nuts = await item("TEST Twister 341-Tan", "ea");
      const l = await lot(nuts, t, 1, 440, "ea");
      // Job A's invoice bills the ticket itself, once (the importer's claim on the bill id).
      const invA = await invoice(jobA, "TEST-SHELF-INV-A");
      await claim(invA, [t.id]);
      // Job B takes 20 nuts and its invoice bills the take, once.
      const r = await draw(staffId, nuts, jobB, 20);
      const invB = await invoice(jobB, "TEST-SHELF-INV-B");
      await claim(invB, r.moves.map((m: any) => m.move_id));
      // Another job's invoice may not bill B's take at all (0343), and B's second invoice may not bill it twice.
      expect((await refusal(() => claim(invA, r.moves.map((m: any) => m.move_id))))?.message).toContain("taken for TEST-SHELF-B");
      const invB2 = await invoice(jobB, "TEST-SHELF-INV-B2");
      expect((await refusal(() => claim(invB2, r.moves.map((m: any) => m.move_id))))?.message).toContain("already billed on TEST-SHELF-INV-B");
      expect((await refusal(() => claim(invB, [t.id])))?.message).toContain("already billed on TEST-SHELF-INV-A");
      // Job cost = bills - off_shelf + from_shelf, for each job.
      const a = await shelfNet(jobA);
      const b = await shelfNet(jobB);
      const costA = Math.round((t.amount - num(a.off_shelf) + num(a.from_shelf)) * 100) / 100;
      const costB = Math.round((0 - num(b.off_shelf) + num(b.from_shelf)) * 100) / 100;
      const left = num((await lotLeft(l.id)).cost_left);
      expect(num(a.off_shelf)).toBe(l.cost);
      expect(costB).toBe(Math.round((20 * l.cost) / 440 * 100) / 100);
      // THE IDENTITY: what A carries + what B carries + what is still on the shelf = the paper.
      expect(Math.round((costA + costB + left) * 100)).toBe(Math.round(t.amount * 100));
      expect((await c.query("select * from public.stock_reconcile_problems where org_id = $1 and (lot_id = $2 or item_id = $3)", [orgId, l.id, nuts])).rows).toEqual([]);
    });
  });

  // ── review of Phase 1: the holes the first cut left ──────────────────────────────────────────
  it("a used ticket's total is frozen with its lines; an unused one may change, never below its rolls", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19"); // $199.48, the coil's roll $180.17
      await lot(it1, t, 1, 250);
      await as(staffId);
      // Job A's cost is bills - off_shelf: a $19.31 ticket would carry -$160.86.
      expect((await refusal(() => c.query("update public.bills set amount = 19.31 where id = $1", [t.id])))?.message).toContain("more than a $19.31 ticket");
      await c.query("update public.bills set amount = 199.50 where id = $1", [t.id]);
      await asServer();
      await draw(staffId, it1, jobB, 60);
      await as(staffId);
      expect((await refusal(() => c.query("update public.bills set amount = 199.48 where id = $1", [t.id])))?.message).toContain(
        "its total can't change. Undo the take from this roll first",
      );
      // The date is not money on a job: a re-dated ticket carries its shelf part to the new month.
      await c.query("update public.bills set bill_date = '2001-08-20', notes = 'TEST re-dated' where id = $1", [t.id]);
    });
  });

  it("a roll comes off what the job does not bill, and the rolls off one ticket never add up past it", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item("TEST breaker", "ea");
      const t = await bill(jobA, "2001-08-19", [
        { description: "TEST breaker box A", amount: 100, billed_amount: 0 },
        { description: "TEST breaker box B", amount: 100, billed_amount: 0 },
        { description: "TEST panel, billed in full", amount: 50 },
        { description: "TEST Sales Tax", amount: 16, category: "Tax" },
      ]);
      const ins = (lineId: string, cost: number) => async () => {
        await as(staffId);
        return one(
          "insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, 10, 'ea', $4) returning id",
          [orgId, it1, lineId, cost],
        );
      };
      // Each $116 roll is under its own line plus the tax; the two together ($232) are over the $216
      // the ticket holds that the job doesn't bill.
      await ins(t.lineIds[0], 116)();
      await asServer();
      const second = await refusal(ins(t.lineIds[1], 116));
      expect(second?.message).toContain("the rolls from this ticket would come to $232.00");
      expect(second?.message).toContain("$216.00");
      // A line the customer is billed for in full has nothing for a shelf.
      expect((await refusal(ins(t.lineIds[2], 1)))?.message).toContain("still billed to the job");
      await asServer();
      // A later edit of what the job used (no takes yet) marks the roll stale AND names it over its paper.
      await as(staffId);
      await c.query("update public.bill_line_items set billed_amount = 90 where id = $1", [t.lineIds[0]]);
      await asServer();
      const problems = (await c.query("select problem from public.stock_reconcile_problems where bill_id = $1", [t.id])).rows.map((r) => r.problem);
      expect(problems).toEqual(expect.arrayContaining(["lot_cost_stale", "lot_over_its_paper"]));
    });
  });

  it("a stale roll is never priced from: a direct take is refused, and Took From Stock steps over it to a short", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const l = await lot(it1, t, 1, 250);
      await as(staffId);
      await c.query("update public.bill_line_items set amount = 6.47 where id = $1", [t.lineIds[3]]); // the tax was mis-scanned
      expect((await refusal(() => c.query("insert into public.stock_moves (org_id, item_id, lot_id, kind, qty) values ($1, $2, $3, 'write_off', 1)", [orgId, it1, l.id])))?.message).toContain(
        "Restamp it",
      );
      await asServer();
      const r = await draw(techId, it1, jobB, 10);
      expect(r.moves).toEqual([]);
      expect(num(r.short)).toBe(10);
      expect((await one("select count(*)::int as n from public.stock_moves where lot_id = $1", [l.id])).n).toBe(0);
    });
  });

  it("a short is settled, and a take undone, only through their functions", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const r = await draw(staffId, it1, jobB, 270);
      await as(staffId);
      // A made-up settlement would take 20 ft out of on hand and out of the reconcile view.
      expect((await refusal(() => c.query("update public.stock_moves set settled_by = gen_random_uuid() where id = $1", [r.short_id])))?.message).toContain(
        "settled with Settle",
      );
      await asServer();
      await lot(it1, await coilTicket(jobA, "2001-09-04"), 1, 250);
      await as(staffId);
      const s = (await one("select public.settle_short($1) as r", [r.short_id])).r;
      // The settlement's draws can't be undone on their own, however it is attempted.
      expect((await refusal(() => c.query("update public.stock_moves set undone_at = now() where draw_group = $1", [s.draw_group])))?.message).toContain(
        "undone with Undo",
      );
      expect((await refusal(() => c.query("select public.stock_undo($1)", [s.draw_group])))?.message).toContain("settle an earlier take");
      // Who undid it is whoever is signed in, never what the client says.
      const u = (await one("select public.stock_undo($1) as r", [r.draw_group])).r;
      expect(u.undone).toBeGreaterThan(0);
      await asServer();
      const who = await one("select count(*) filter (where undone_by = $2)::int as mine, count(*)::int as n from public.stock_moves where draw_group in ($1, $3)", [
        r.draw_group,
        staffId,
        s.draw_group,
      ]);
      expect(who.mine).toBe(who.n);
      // And a settlement that points at nothing is named (written here as the server, past the guard).
      const r2 = await draw(staffId, it1, jobB, 600);
      await c.query("update public.stock_moves set settled_by = gen_random_uuid() where id = $1", [r2.short_id]);
      const named = (await c.query("select problem from public.stock_reconcile_problems where move_id = $1", [r2.short_id])).rows.map((x) => x.problem);
      expect(named).toContain("short_settled_by_nothing");
    });
  });

  it("a tech undoes their own take, but not once the office has settled part of it", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      const mine = await draw(techId, it1, jobB, 5);
      await as(techId);
      expect((await one("select public.stock_undo($1) as r", [mine.draw_group])).r.undone).toBe(1);
      await asServer();
      const r = await draw(techId, it1, jobB, 270);
      await lot(it1, await coilTicket(jobA, "2001-09-04"), 1, 250);
      await as(staffId);
      await c.query("select public.settle_short($1)", [r.short_id]);
      await asServer();
      await as(techId);
      expect((await refusal(() => c.query("select public.stock_undo($1)", [r.draw_group])))?.code).toBe("42501");
      await asServer();
      await as(staffId);
      expect((await one("select public.stock_undo($1) as r", [r.draw_group])).r.undone).toBe(2);
    });
  });

  it("undoing a found piece can't strand cents on an empty roll; counting it down can", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item("TEST 3-pack", "ea");
      const t = await bill(jobA, "2001-08-19", [{ description: "TEST 3-pack", amount: 10, quantity: 3, billed_amount: 0 }]);
      const l = await lot(it1, t, 0, 3, "ea");
      await as(staffId);
      const found = await one("insert into public.stock_moves (org_id, item_id, lot_id, kind, qty) values ($1, $2, $3, 'recount_up', 3) returning id", [orgId, it1, l.id]);
      await asServer();
      for (let i = 0; i < 3; i++) await draw(staffId, it1, jobB, 1); // $3.33 each
      const left = await lotLeft(l.id);
      expect([num(left.pieces_left), num(left.cost_left)]).toEqual([3, 0.01]);
      await as(staffId);
      expect((await refusal(() => c.query("update public.stock_moves set undone_at = now() where id = $1", [found.id])))?.message).toContain("empty with $0.01");
      await c.query("insert into public.stock_moves (org_id, item_id, lot_id, kind, qty) values ($1, $2, $3, 'recount_down', 3)", [orgId, it1, l.id]);
      await asServer();
      const after = await lotLeft(l.id);
      expect([num(after.pieces_left), num(after.cost_left)]).toEqual([0, 0]);
    });
  });

  it("who may write the shelf is settled before any receipt figure is read; a price link stays in the company", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      const t = await coilTicket(jobA, "2001-08-19");
      const direct = (uid: string) => async () => {
        await as(uid);
        await c.query(
          "insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, 1, 'ft', 999999)",
          [orgId, it1, t.lineIds[1]],
        );
      };
      for (const who of [techId, otherStaffId]) {
        const r = await refusal(direct(who));
        expect(r?.code).toBe("42501");
        expect(r?.message).not.toContain("$");
        await asServer();
      }
      // The stranger company's own price-book item (minted, rolled back with the rest).
      const foreign = await one(
        "insert into public.price_list_items (org_id, code, description, unit, buy_price) values ($1, 'TEST-SHELF-X', 'TEST shelf stranger item', 'ea', 1) returning id",
        [otherOrgId],
      );
      await as(staffId);
      expect((await refusal(() => c.query("update public.inventory_items set price_item_id = $2 where id = $1", [it1, foreign.id])))?.code).toBe("42501");
      await asServer();
    });
  });

  it("on hand holds what the ledger holds, to the thousandth", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 12.125);
      expect(await onHand(it1)).toBe(12.125);
      await draw(staffId, it1, jobB, 0.5);
      expect(await onHand(it1)).toBe(11.625);
      expect((await c.query("select * from public.stock_reconcile_problems where item_id = $1", [it1])).rows).toEqual([]);
    });
  });

  it("stock_reconcile_problems is empty for every fixture this suite leaves standing", async () => {
    if (!needs()) return;
    await step(async () => {
      const it1 = await item();
      await lot(it1, await coilTicket(jobA, "2001-07-31"), 1, 250);
      await lot(it1, await coilTicket(jobA, "2001-08-19"), 1, 250);
      await draw(staffId, it1, jobB, 300);
      await draw(techId, it1, jobA, 200);
      expect((await c.query("select * from public.stock_reconcile_problems where org_id = $1 and item_id = $2", [orgId, it1])).rows).toEqual([]);
      expect(await onHand(it1)).toBe(0);
    });
  });
}

