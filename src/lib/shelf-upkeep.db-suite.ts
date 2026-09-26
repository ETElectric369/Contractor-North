/**
 * SHELF UPKEEP, AT THE DATABASE (Shop Stock, Phase 4; migration 0350), written once and run against
 * any Postgres over ONE connection.
 *
 * EVERY CASE IS ITS OWN TRANSACTION, ALWAYS ROLLED BACK, in companies of its own: right after BEGIN
 * it mints a TEST company (an owner and a tech) and a stranger's (throwaway-org.db-fixture.ts), and
 * the rollback takes both with it. No company is picked by query; the live ones are refused by id.
 * No DDL: 0350 must already be on this database (node scripts/test-db/rebuild.cjs), or every case
 * says so through notOnThisDatabase (which fails in CI).
 *
 * THE LAWS IT HOLDS THE DATABASE TO:
 *   · money is never invented or lost: after a take, a write-off and a return, every roll still adds
 *     up to what was paid (drawn + lost + returned + left = cost), to the cent;
 *   · a write-off has a reason and no job (the company eats it; no customer is charged);
 *   · a return is tied only to a credit filed to the shelf, never one on a job (that would come off a
 *     customer's bill), and a tied credit can't be moved onto a job or deleted until the return is
 *     undone;
 *   · only the office writes these, and only in its own company;
 *   · what an accountant download carried can't be undone after (Undo while unexported).
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { shelfLotCost, type BillLine } from "./bill-itemisation";
import { LIVE_ORGS, mintThrowawayOrg } from "./throwaway-org.db-fixture";
import { notOnThisDatabase } from "@/lib/db-guard";
import { isMissingExportRecord } from "@/lib/accountant-lists";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const num = (v: unknown) => Number(v);
const c2 = (n: number) => Math.round(n * 100);

export function defineShelfUpkeepSuite(connect: () => Promise<SqlClient>) {
  let c: SqlClient;
  let ready = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherOrgId = "";
  let otherStaffId = "";
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
  const refusal = async (fn: () => Promise<unknown>): Promise<{ message: string; code: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("release savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return { message: String(e?.message ?? e), code: String(e?.code ?? "") };
    }
  };

  const tx = async (fn: () => Promise<void>) => {
    await c.query("begin");
    try {
      await c.query("set local lock_timeout = '3s'");
      await c.query("set local statement_timeout = '15s'");
      const ours = await mintThrowawayOrg(c, { label: "shelf upkeep", techs: 1 });
      const theirs = await mintThrowawayOrg(c, { label: "shelf upkeep stranger", techs: 0 });
      if (LIVE_ORGS.has(ours.orgId) || LIVE_ORGS.has(theirs.orgId)) throw new Error("shelf-upkeep: refusing to write in a live company's org.");
      orgId = ours.orgId;
      staffId = ours.owner.id;
      techId = ours.techs[0].id;
      otherOrgId = theirs.orgId;
      otherStaffId = theirs.owner.id;
      const job = async (n: string) =>
        (await one(`insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, $2, $3, 'scheduled', 'tm') returning id`, [orgId, `TEST upkeep job ${n}`, `TEST-UPK-${n}-${++seq}`])).id as string;
      jobA = await job("A");
      jobB = await job("B");
      await fn();
    } finally {
      await c.query("rollback");
    }
  };

  // ── fixtures, as the server ──
  type Line = { description: string; amount: number; quantity?: number; category?: string; billable?: boolean; billed_amount?: number | null };
  const bill = async (job: string | null, date: string, lines: Line[], extra: { on_shelf?: boolean; org?: string } = {}) => {
    const amount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const org = extra.org ?? orgId;
    const b = await one(
      `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status, on_shelf) values ($1, $2, 'TEST CED', $3, $4, $5, 'unpaid', $6) returning id`,
      [org, job, `TEST-UPK-${++seq}`, amount, date, extra.on_shelf ?? false],
    );
    const ids: string[] = [];
    for (const [i, l] of lines.entries()) {
      const r = await one(
        `insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [org, b.id, l.description, l.quantity ?? 1, l.amount, l.amount, l.category ?? "Electrical", l.billable ?? true, l.billed_amount ?? null, i],
      );
      ids.push(r.id);
    }
    return { id: b.id as string, lineIds: ids, lines: lines.map((l, i) => ({ id: ids[i], ...l })) as BillLine[] };
  };
  /** Herringbone's 8/19 CED ticket, the coil at 0 used: its roll costs $180.17. */
  const coilTicket = () =>
    bill(jobA, "2001-08-19", [
      { description: "TEST Flexbox BH bar hanger ground", amount: 8.82 },
      { description: "TEST NMB 12/2 w/gnd wire 250 ft coil", amount: 165.29, quantity: 250, billed_amount: 0 },
      { description: "TEST Flexbox single gang 16 cu in", amount: 8.9, quantity: 2 },
      { description: "TEST Tax at 9.000 percent", amount: 16.47, category: "Tax" },
    ]);
  /** A roll of 250 ft on the shelf, off the coil ticket. */
  const shelved = async () => {
    const itemId = (await one(`insert into public.inventory_items (org_id, name, unit) values ($1, $2, 'ft') returning id`, [orgId, `TEST 12/2 NM-B ${++seq}`])).id as string;
    const t = await coilTicket();
    const cost = shelfLotCost(t.lines[1], t.lines);
    await as(staffId);
    const lot = (await one(`insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, 250, 'ft', $4) returning id`, [orgId, itemId, t.lineIds[1], cost])).id as string;
    await asServer();
    return { itemId, lotId: lot, cost, billId: t.id };
  };
  const shelfCredit = async (amount: number, onShelf = true, job: string | null = null) =>
    (await bill(job, "2001-09-15", [{ description: "TEST return 12/2 coil", amount, quantity: 1 }], { on_shelf: onShelf })).id;
  /** The office writes an upkeep move directly (0303's staff insert policy), as the app does. */
  const move = async (who: string, row: Record<string, unknown>) => {
    await as(who);
    const cols = Object.keys(row);
    const r = await one(
      `insert into public.stock_moves (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id, cost, job_id`,
      cols.map((k) => row[k]),
    );
    await asServer();
    return r as { id: string; cost: string; job_id: string | null };
  };
  const balance = async (lotId: string) =>
    one(`select pieces, cost, pieces_left, cost_left, drawn_cost, lost_cost, returned_cost from public.stock_lot_balance where lot_id = $1`, [lotId]);
  const addsUp = (b: any) => c2(num(b.drawn_cost)) + c2(num(b.lost_cost)) + c2(num(b.returned_cost)) + c2(num(b.cost_left)) === c2(num(b.cost));
  const problems = async () => (await c.query(`select problem, detail from public.stock_reconcile_problems where org_id = $1`, [orgId])).rows;

  beforeAll(async () => {
    c = await connect();
    const has = await one(
      `select to_regclass('public.accountant_exports') is not null as exports,
              to_regprocedure('public.stock_move_names_its_credit()') is not null as credit,
              to_regprocedure('public.stock_recount(uuid, numeric, text)') is not null as recount`,
    );
    ready = !!has?.exports && !!has?.credit && !!has?.recount;
  });

  afterAll(async () => {
    await c?.end();
  });

  const needs = () => ready || notOnThisDatabase("[shelf-upkeep] 0350 is not on this database (run node scripts/test-db/rebuild.cjs); nothing to exercise.");

  it("a write-off: stamped off the roll, no job, a reason required, and the roll still adds up to what was paid", async () => {
    if (!needs()) return;
    await tx(async () => {
      const s = await shelved();
      expect(s.cost).toBe(180.17);
      await as(staffId);
      const take = (await one("select public.stock_draw($1, $2, 60, 'TEST take', null) as r", [s.itemId, jobB])).r;
      await asServer();
      expect(num(take.cost)).toBe(43.24);
      const wo = await move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "write_off", qty: 10, source: "office", note: "TEST ruined in the rain", cost: 999 });
      expect(num(wo.cost)).toBe(7.21); // the database's figure, never the client's $999
      expect(wo.job_id).toBeNull();
      const b = await balance(s.lotId);
      expect(num(b.pieces_left)).toBe(180);
      expect(num(b.lost_cost)).toBe(7.21);
      expect(addsUp(b)).toBe(true);
      expect(await problems()).toEqual([]);
      // No reason, no write-off.
      const bare = await refusal(() => move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "write_off", qty: 1, source: "office", note: " " }));
      expect(bare?.message).toMatch(/stock_moves_write_off_has_a_reason/);
      // A write-off never lands on a job: no customer is charged for it.
      const onJob = await refusal(() => move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, job_id: jobB, kind: "write_off", qty: 1, source: "office", note: "TEST" }));
      expect(onJob?.message).toMatch(/stock_moves_job_shape/);
      // The crew never writes one.
      const tech = await refusal(() => move(techId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "write_off", qty: 1, source: "office", note: "TEST" }));
      expect(tech?.code).toBe("42501");
      // Undo, while nothing has gone to the accountant: the pieces and the dollars come back.
      await as(staffId);
      await c.query("update public.stock_moves set undone_at = now() where id = $1", [wo.id]);
      await asServer();
      const after = await balance(s.lotId);
      expect(num(after.pieces_left)).toBe(190);
      expect(num(after.lost_cost)).toBe(0);
      expect(addsUp(after)).toBe(true);
    });
  });

  it("a return to CED tied to a credit filed to the shelf: the roll drops, the credit stays the shelf's, and it all adds up", async () => {
    if (!needs()) return;
    await tx(async () => {
      const s = await shelved();
      // A job-less credit the return itself files to the shelf, as Return To CED does, and says so.
      const credit = await shelfCredit(-30, false);
      await as(staffId);
      await c.query("update public.bills set on_shelf = true where id = $1 and job_id is null", [credit]);
      await asServer();
      const r = await move(staffId, {
        org_id: orgId,
        item_id: s.itemId,
        lot_id: s.lotId,
        kind: "supplier_return",
        qty: 50,
        source: "office",
        credit_bill_id: credit,
        credit_filed_by_return: true,
      });
      expect(num(r.cost)).toBe(36.03);
      expect(r.job_id).toBeNull();
      const b = await balance(s.lotId);
      expect(num(b.returned_cost)).toBe(36.03);
      expect(num(b.pieces_left)).toBe(200);
      expect(addsUp(b)).toBe(true);
      expect(await problems()).toEqual([]);
      // The credit is on no job, so no job's materials can ever credit a customer with it...
      const cr = await one("select job_id, on_shelf, amount from public.bills where id = $1", [credit]);
      expect(cr).toMatchObject({ job_id: null, on_shelf: true });
      // ...and while the return is live it can't be moved onto one, taken off the shelf, or deleted.
      await as(staffId);
      const toJob = await refusal(() => c.query("update public.bills set on_shelf = false, job_id = $2 where id = $1", [credit, jobA]));
      expect(toJob?.message).toMatch(/tied to pieces returned from the shelf/);
      const gone = await refusal(() => c.query("delete from public.bills where id = $1", [credit]));
      expect(gone?.message).toMatch(/tied to pieces returned from the shelf/);
      // Undo the return: the credit is free again. The return filed it, so the app takes it back
      // off the shelf (untieShelfCredit's exact write), and then it can go on a job.
      await c.query("update public.stock_moves set undone_at = now() where id = $1", [r.id]);
      const filed = await one("select bool_or(credit_filed_by_return) as filed, count(*) filter (where undone_at is null)::int as live from public.stock_moves where credit_bill_id = $1", [credit]);
      expect(filed).toMatchObject({ filed: true, live: 0 });
      const off = (await c.query("update public.bills set on_shelf = false where id = $1 and org_id = $2 and job_id is null and on_shelf returning id", [credit, orgId])).rows;
      expect(off).toHaveLength(1);
      const moved = await refusal(() => c.query("update public.bills set job_id = $2 where id = $1", [credit, jobA]));
      expect(moved).toBeNull();
      await asServer();
      expect(addsUp(await balance(s.lotId))).toBe(true);
    });
  });

  it("a return is never tied to a credit on a job, another company's credit, or a charge", async () => {
    if (!needs()) return;
    await tx(async () => {
      const s = await shelved();
      const onJob = await shelfCredit(-51.58, false, jobA);
      const refusedJob = await refusal(() =>
        move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "supplier_return", qty: 4, source: "office", credit_bill_id: onJob }),
      );
      expect(refusedJob?.message).toMatch(/filed on a job, where it would come off the customer's bill/);
      const theirs = (await bill(null, "2001-09-15", [{ description: "TEST their credit", amount: -10 }], { on_shelf: true, org: otherOrgId })).id;
      const refusedTheirs = await refusal(() =>
        move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "supplier_return", qty: 4, source: "office", credit_bill_id: theirs }),
      );
      expect(refusedTheirs?.code).toBe("42501");
      const charge = (await bill(null, "2001-09-15", [{ description: "TEST not a credit", amount: 10 }], { on_shelf: true })).id;
      const refusedCharge = await refusal(() =>
        move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "supplier_return", qty: 4, source: "office", credit_bill_id: charge }),
      );
      expect(refusedCharge?.message).toMatch(/isn't a credit/);
      // "The return filed the credit" needs a credit to have filed.
      const filedNothing = await refusal(() =>
        move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "supplier_return", qty: 1, source: "office", credit_filed_by_return: true }),
      );
      expect(filedNothing?.message).toMatch(/stock_moves_filed_names_its_credit/);
      // Only a return names a credit.
      const credit = await shelfCredit(-5);
      const onWriteOff = await refusal(() =>
        move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "write_off", qty: 1, source: "office", note: "TEST", credit_bill_id: credit }),
      );
      expect(onWriteOff).not.toBeNull();
      // The stranger's office can't return this company's pieces.
      const stranger = await refusal(() => move(otherStaffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "supplier_return", qty: 1, source: "office" }));
      expect(stranger?.code).toBe("42501");
      expect(num((await balance(s.lotId)).pieces_left)).toBe(250);
    });
  });

  it("undo while unexported: an On Hand download that carried a write-off freezes it; one that did not carry it does not", async () => {
    if (!needs()) return;
    await tx(async () => {
      const s = await shelved();
      const wo = await move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "write_off", qty: 5, source: "office", note: "TEST lost" });
      const at = (await one("select created_at from public.stock_moves where id = $1", [wo.id])).created_at as Date;
      await as(staffId);
      // A download of a window that ended before the write-off: it isn't in it.
      await c.query("insert into public.accountant_exports (org_id, list, from_at, to_at, row_count) values ($1, 'stock_used', $2, $3, 0)", [
        orgId,
        new Date(at.getTime() - 86_400_000 * 30).toISOString(),
        new Date(at.getTime() - 1000).toISOString(),
      ]);
      // A Tools download never freezes shelf moves.
      await c.query("insert into public.accountant_exports (org_id, list, from_at, to_at, row_count) values ($1, 'tools', null, $2, 0)", [orgId, new Date(at.getTime() + 86_400_000).toISOString()]);
      // Still undoable: proven inside a savepoint that is then rolled back, so the write-off stands.
      expect(
        await refusal(async () => {
          await c.query("update public.stock_moves set undone_at = now() where id = $1", [wo.id]);
          throw Object.assign(new Error("probe ok"), { code: "PROBE" });
        }),
      ).toMatchObject({ code: "PROBE" });
      // An On Hand download as of a day after it, taken after it (the database stamps a download
      // with the wall clock): the write-off is carried, and stays. Count It is the way forward.
      await c.query("insert into public.accountant_exports (org_id, list, from_at, to_at, row_count) values ($1, 'on_hand', null, $2, 1)", [
        orgId,
        new Date(at.getTime() + 86_400_000).toISOString(),
      ]);
      const frozen = await refusal(() => c.query("update public.stock_moves set undone_at = now() where id = $1", [wo.id]));
      expect(frozen?.message).toMatch(/already went to your accountant in the On Hand list, so it stays.*Count It/);
      await asServer();
      // Nothing moved: the roll still adds up.
      expect(addsUp(await balance(s.lotId))).toBe(true);
    });
  });

  it("a Stock Used download covering its day freezes a return the same way", async () => {
    if (!needs()) return;
    await tx(async () => {
      const s = await shelved();
      const r = await move(staffId, { org_id: orgId, item_id: s.itemId, lot_id: s.lotId, kind: "supplier_return", qty: 5, source: "office" });
      const at = (await one("select created_at from public.stock_moves where id = $1", [r.id])).created_at as Date;
      await as(staffId);
      await c.query("insert into public.accountant_exports (org_id, list, from_at, to_at, row_count) values ($1, 'stock_used', $2, $3, 1)", [
        orgId,
        new Date(at.getTime() - 86_400_000).toISOString(),
        new Date(at.getTime() + 86_400_000).toISOString(),
      ]);
      const frozen = await refusal(() => c.query("update public.stock_moves set undone_at = now() where id = $1", [r.id]));
      expect(frozen?.message).toMatch(/already went to your accountant in the Stock Used list/);
      await asServer();
      expect(num((await balance(s.lotId)).returned_cost)).toBeGreaterThan(0);
    });
  });

  it("accountant downloads are the office's, and stay on the record", async () => {
    if (!needs()) return;
    await tx(async () => {
      await as(techId);
      const tech = await refusal(() => c.query("insert into public.accountant_exports (org_id, list, to_at) values ($1, 'stock_used', now())", [orgId]));
      expect(tech).not.toBeNull();
      // Postgres names the table in this refusal: it must never read as "0350 isn't applied" (the
      // route would then hand the file over unrecorded).
      expect(tech!.message).toMatch(/accountant_exports/);
      expect(isMissingExportRecord(tech)).toBe(false);
      expect((await c.query("select count(*)::int as n from public.accountant_exports")).rows[0].n).toBe(0);
      await as(staffId);
      const row = await one("insert into public.accountant_exports (org_id, list, to_at, created_by, created_at) values ($1, 'tools', now(), $2, '2001-01-01') returning id, created_by, created_at", [orgId, otherStaffId]);
      expect(row.created_by).toBe(staffId); // who is the database's, not the client's
      expect(new Date(row.created_at).getUTCFullYear()).not.toBe(2001);
      const upd = await refusal(() => c.query("update public.accountant_exports set list = 'on_hand' where id = $1", [row.id]));
      expect(upd).not.toBeNull();
      const del = await refusal(() => c.query("delete from public.accountant_exports where id = $1", [row.id]));
      expect(del).not.toBeNull();
      // Another company's office doesn't see it.
      await as(otherStaffId);
      expect((await c.query("select count(*)::int as n from public.accountant_exports where id = $1", [row.id])).rows[0].n).toBe(0);
      await asServer();
    });
  });
}
