/**
 * TOOK FROM STOCK, AT THE DATABASE (Shop Stock, Phase 3; migration 0344), written once and run against
 * any Postgres. stock-take.integration.test.ts points it at production over ONE connection.
 *
 * EVERY CASE IS ITS OWN TRANSACTION, ALWAYS ROLLED BACK: begin, lock and statement timeouts, 0344
 * applied from supabase/migrations when the database does not have it yet, the case's fixtures, the
 * case, rollback. Nothing is ever written outside a transaction that is rolled back. Short
 * transactions on purpose: a claim takes the org's claim lock (0260) until its transaction ends, and
 * the office may be building an invoice in the live app while this runs.
 *
 * THE COMPANY IT SPEAKS IN: the one with the most active techs (it needs a tech and the office),
 * never "the first organization". Another company's office is the stranger. Fixtures are dated 2001
 * and named TEST.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shelfLotCost, type BillLine } from "./bill-itemisation";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const MIGRATION = "0344_a_piece_from_the_shelf_is_billed_once.sql";
const num = (v: unknown) => Number(v);
/** Every key stock_takes_for_job may hand anyone. A cost, a lot or a supplier is never one of them. */
const TAKE_KEYS = ["back", "billed_invoice_id", "billed_on", "can_undo", "draw_group", "item", "item_id", "mine", "qty", "short", "taken_at", "unit", "who"];

export function defineStockTakeSuite(connect: () => Promise<SqlClient>) {
  let c: SqlClient;
  let ready = false;
  let applied0344 = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let tech2Id = "";
  let techName = "";
  let otherStaffId = "";
  let otherOrgId = "";
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

  /** ONE CASE, ONE TRANSACTION, ROLLED BACK whatever happens. */
  const tx = async (fn: () => Promise<void>) => {
    await c.query("begin");
    try {
      await c.query("set local lock_timeout = '3s'");
      await c.query("set local statement_timeout = '15s'");
      if (!applied0344) await c.query(readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${MIGRATION}`, import.meta.url)), "utf8"));
      const job = async (n: string) =>
        (
          await one(
            `insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, $2, $3, 'scheduled', 'tm') returning id`,
            [orgId, `TEST take job ${n}`, `TEST-TAKE-${n}-${++seq}`],
          )
        ).id as string;
      jobA = await job("A");
      jobB = await job("B");
      await fn();
    } finally {
      await c.query("rollback");
    }
  };

  // ── fixtures, as the server ──
  type Line = { description: string; amount: number; quantity?: number; category?: string; billable?: boolean; billed_amount?: number | null };
  const bill = async (job: string | null, date: string, lines: Line[]) => {
    const amount = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const b = await one(
      `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status) values ($1, $2, 'TEST CED', $3, $4, $5, 'unpaid') returning id`,
      [orgId, job, `TEST-TAKE-${++seq}`, amount, date],
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
    return { id: b.id as string, lineIds: ids, lines: lines.map((l, i) => ({ id: ids[i], ...l })) as BillLine[] };
  };
  /** Herringbone's 8/19 CED ticket shape, the coil at 0 used: its roll costs $180.17. */
  const coilTicket = (job: string | null, date: string) =>
    bill(job, date, [
      { description: "TEST Flexbox BH bar hanger ground", amount: 8.82 },
      { description: "TEST NMB 12/2 w/gnd wire 250 ft coil", amount: 165.29, quantity: 250, billed_amount: 0 },
      { description: "TEST Flexbox single gang 16 cu in", amount: 8.9, quantity: 2 },
      { description: "TEST Tax at 9.000 percent", amount: 16.47, category: "Tax" },
    ]);
  const item = async () =>
    (await one(`insert into public.inventory_items (org_id, name, unit) values ($1, $2, 'ft') returning id`, [orgId, `TEST 12/2 NM-B ${++seq}`])).id as string;
  const lot = async (itemId: string, t: { lineIds: string[]; lines: BillLine[] }, pieces = 250) => {
    const cost = shelfLotCost(t.lines[1], t.lines);
    await as(staffId);
    const r = await one(
      `insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, $4, 'ft', $5) returning id`,
      [orgId, itemId, t.lineIds[1], pieces, cost],
    );
    await asServer();
    return r.id as string;
  };
  const shelved = async () => {
    const it1 = await item();
    await lot(it1, await coilTicket(jobA, "2001-08-19"));
    return it1;
  };
  const draw = async (who: string, itemId: string, job: string, qty: number) => {
    await as(who);
    const r = (await one("select public.stock_draw($1, $2, $3, 'TEST take', null) as r", [itemId, job, qty])).r;
    await asServer();
    return r as { draw_group: string; moves: { move_id: string }[]; short: number; short_id: string | null };
  };
  const takes = async (who: string, job: string) => {
    await as(who);
    const r = (await one("select public.stock_takes_for_job($1) as r", [job])).r as any[];
    await asServer();
    return r;
  };
  const invoice = async (job: string | null, number: string, org = orgId) =>
    (await one(`insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid) values ($1, $2, $3, 'draft', 0, 0) returning id`, [org, job, number])).id as string;
  const claim = async (invoiceId: string, ids: string[], org = orgId) =>
    one(
      `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids, import_source, import_key, line_kind)
       values ($1, $2, 'TEST 12/2 NM-B cable, 60 ft', 1, 1, $3::uuid[], 'costs', 'stock:test', 'materials') returning id`,
      [org, invoiceId, ids],
    );
  const moveIds = (r: { moves: { move_id: string }[] }) => r.moves.map((m) => m.move_id);

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    try {
      const has = await one(
        "select to_regclass('public.stock_moves') is not null as ledger, to_regprocedure('public.stock_takes_for_job(uuid)') is not null as takes",
      );
      ready = !!has?.ledger;
      applied0344 = !!has?.takes;
      if (!ready) return;
      // The company with the most active techs, and a stranger's office from any other company.
      const fx = await one(
        `select p.org_id,
                (array_agg(p.id order by p.id) filter (where p.role = 'tech'))[1] as tech_id,
                (array_agg(p.id order by p.id) filter (where p.role = 'tech'))[2] as tech2_id,
                (array_agg(p.full_name order by p.id) filter (where p.role = 'tech'))[1] as tech_name,
                (array_agg(p.id order by (p.role = 'owner') desc, p.id) filter (where p.role in ('owner', 'admin', 'office')))[1] as staff_id
           from public.profiles p
          where p.org_id is not null and coalesce(p.active, true)
          group by p.org_id
         having count(*) filter (where p.role = 'tech') > 0 and count(*) filter (where p.role in ('owner', 'admin', 'office')) > 0
          order by count(*) filter (where p.role = 'tech') desc, p.org_id
          limit 1`,
      );
      if (!fx) throw new Error("take suite fixture: no company has both an active tech and active office staff.");
      orgId = fx.org_id;
      techId = fx.tech_id;
      tech2Id = fx.tech2_id ?? "";
      techName = String(fx.tech_name ?? "").trim();
      staffId = fx.staff_id;
      const other = await one(
        `select p.id, p.org_id from public.profiles p
          where p.org_id is not null and p.org_id <> $1 and p.role in ('owner', 'admin', 'office') and coalesce(p.active, true)
          order by (select count(*) from public.profiles t where t.org_id = p.org_id and t.role = 'tech') asc, p.id
          limit 1`,
        [orgId],
      );
      if (!other) throw new Error("take suite fixture: no office staff in a second company, so the stranger cannot be tested.");
      otherStaffId = other.id;
      otherOrgId = other.org_id;
    } finally {
      await c.query("rollback");
    }
    if (!applied0344) console.warn("[stock-take] 0344 is not on this database yet; each case applies it inside its own rolled-back transaction.");
  });

  afterAll(async () => {
    await c?.end();
  });

  const needs = () => {
    if (!ready) console.warn("[stock-take] the shelf's ledger (0303) is not on this database; nothing to exercise.");
    return ready;
  };

  it("a tech's take shows on the job for the crew with no cost, and only he (or the office) may undo it", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const r = await draw(techId, it1, jobB, 60);
      const mine = await takes(techId, jobB);
      expect(mine).toHaveLength(1);
      expect(Object.keys(mine[0]).sort()).toEqual(TAKE_KEYS);
      expect(JSON.stringify(mine)).not.toMatch(/cost|lot|supplier|price/i);
      expect(mine[0]).toMatchObject({ draw_group: r.draw_group, item_id: it1, unit: "ft", mine: true, can_undo: true, billed_on: null, billed_invoice_id: null });
      expect(num(mine[0].qty)).toBe(60);
      expect(num(mine[0].short)).toBe(0);
      if (techName) expect(mine[0].who).toBe(techName);
      // The office sees the same row and may undo anyone's take.
      const office = await takes(staffId, jobB);
      expect(office[0]).toMatchObject({ mine: false, can_undo: true });
      // Another tech sees it, and may not undo it (0303's stock_undo says the same).
      if (tech2Id) {
        const theirs = await takes(tech2Id, jobB);
        expect(theirs[0]).toMatchObject({ mine: false, can_undo: false });
        await as(tech2Id);
        expect((await refusal(() => c.query("select public.stock_undo($1)", [r.draw_group])))?.code).toBe("42501");
        await asServer();
      }
      // A stranger's office reads nothing of this job.
      await as(otherStaffId);
      expect((await refusal(() => c.query("select public.stock_takes_for_job($1)", [jobB])))?.code).toBe("42501");
      await asServer();
      // Nobody signed in reads nothing at all.
      expect((await one("select has_function_privilege('anon', 'public.stock_takes_for_job(uuid)', 'execute') as yes")).yes).toBe(false);
      // His own Undo goes through, and the job's list is empty again.
      await as(techId);
      expect((await one("select public.stock_undo($1) as r", [r.draw_group])).r.undone).toBe(1);
      await asServer();
      expect(await takes(techId, jobB)).toEqual([]);
    });
  });

  it("a billed take reads Take It Off INV First: the crew gets the number, the office the door, nobody the Undo", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const r = await draw(techId, it1, jobB, 60);
      const inv = await invoice(jobB, `TEST-TAKE-INV-${++seq}`);
      await claim(inv, moveIds(r));
      const number = (await one("select invoice_number from public.invoices where id = $1", [inv])).invoice_number;
      const crew = await takes(techId, jobB);
      expect(crew[0]).toMatchObject({ billed_on: number, billed_invoice_id: null, can_undo: false });
      const office = await takes(staffId, jobB);
      expect(office[0]).toMatchObject({ billed_on: number, billed_invoice_id: inv, can_undo: false });
      await as(techId);
      expect((await refusal(() => c.query("select public.stock_undo($1)", [r.draw_group])))?.message).toContain(`${number} already bills these pieces`);
      await asServer();
    });
  });

  it("a piece is claimed by one live invoice, and the refusal calls it materials", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const r = await draw(staffId, it1, jobB, 60);
      const n1 = `TEST-TAKE-INV-${++seq}`;
      await claim(await invoice(jobB, n1), moveIds(r));
      const second = await refusal(async () => claim(await invoice(jobB, `TEST-TAKE-INV-${++seq}`), moveIds(r)));
      expect(second?.message).toBe(`materials already billed on ${n1}`);
      // One piece of the take is enough to be refused (a partial re-claim is still a double bill).
      const partial = await refusal(async () => claim(await invoice(jobA, `TEST-TAKE-INV-${++seq}`), [moveIds(r)[0]]));
      expect(partial?.message).toBe(`materials already billed on ${n1}`);
    });
  });

  it("an undone take, a short, a count and another company's piece cannot be billed", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const inv = await invoice(jobB, `TEST-TAKE-INV-${++seq}`);
      // Undone: the pieces are back on the shelf.
      const u = await draw(staffId, it1, jobB, 10);
      await as(staffId);
      await c.query("select public.stock_undo($1)", [u.draw_group]);
      await asServer();
      expect((await refusal(() => claim(inv, moveIds(u))))?.message).toContain("was undone");
      // A short: taken past the shelf, $0 until settled.
      const s = await draw(staffId, it1, jobB, 300);
      expect(num(s.short)).toBe(50);
      expect((await refusal(() => claim(inv, [s.short_id!])))?.message).toContain("no cost yet");
      // A count is never a customer's.
      await as(staffId);
      await c.query("select public.stock_undo($1)", [s.draw_group]);
      const count = (await one("select public.stock_recount($1, 240, 'TEST count') as r", [it1])).r;
      await asServer();
      const countId = count.moves[0].move_id;
      expect((await refusal(() => claim(inv, [countId])))?.message).toContain("only pieces taken for a job");
      // Another company's invoice cannot name this company's piece.
      const d = await draw(staffId, it1, jobB, 5);
      const strangers = await invoice(null, `TEST-TAKE-X-${++seq}`, otherOrgId);
      expect((await refusal(() => claim(strangers, moveIds(d), otherOrgId)))?.code).toBe("42501");
      // And the live take itself bills fine.
      expect(await refusal(() => claim(inv, moveIds(d)))).toBeNull();
    });
  });

  it("voiding releases a take; undone while void, the invoice stays void (and one that wasn't comes back)", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const kept = await draw(staffId, it1, jobB, 20);
      const gone = await draw(staffId, it1, jobB, 30);
      const invKept = await invoice(jobB, `TEST-TAKE-INV-${++seq}`);
      const invGone = await invoice(jobB, `TEST-TAKE-INV-${++seq}`);
      await claim(invKept, moveIds(kept));
      await claim(invGone, moveIds(gone));
      await c.query("update public.invoices set status = 'void' where id = any ($1::uuid[])", [[invKept, invGone]]);
      // Void released it, so the take can be undone.
      await as(staffId);
      expect((await one("select public.stock_undo($1) as r", [gone.draw_group])).r.undone).toBe(1);
      await asServer();
      const back = await refusal(() => c.query("update public.invoices set status = 'draft' where id = $1", [invGone]));
      expect(back?.message).toContain("were taken back off the job after it was voided");
      // Nothing undone behind the other one: it comes back from void as it always could.
      expect(await refusal(() => c.query("update public.invoices set status = 'draft' where id = $1", [invKept]))).toBeNull();
    });
  });

  it("a short settled from a roll reads as ONE take, and only the office can undo it after", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const r = await draw(techId, it1, jobB, 270);
      expect(num(r.short)).toBe(20);
      let rows = await takes(techId, jobB);
      expect(rows).toHaveLength(1);
      expect(num(rows[0].qty)).toBe(270);
      expect(num(rows[0].short)).toBe(20);
      await lot(it1, await coilTicket(jobA, "2001-09-04"));
      await as(staffId);
      await c.query("select public.settle_short($1)", [r.short_id]);
      await asServer();
      rows = await takes(techId, jobB);
      expect(rows).toHaveLength(1);
      expect(num(rows[0].qty)).toBe(270);
      expect(num(rows[0].short)).toBe(0);
      expect(rows[0].can_undo).toBe(false); // the office settled part of it (0303)
      expect((await takes(staffId, jobB))[0].can_undo).toBe(true);
      // The settlement's pieces bill; the take's short id still never does.
      const settledIds = (await c.query("select id from public.stock_moves where draw_group = (select settled_by from public.stock_moves where id = $1)", [r.short_id])).rows.map((x) => x.id);
      const inv = await invoice(jobB, `TEST-TAKE-INV-${++seq}`);
      expect(await refusal(() => claim(inv, [...moveIds(r), ...settledIds]))).toBeNull();
      expect((await refusal(() => claim(inv, [r.short_id!])))?.message).toContain("no cost yet");
      expect((await takes(techId, jobB))[0].billed_on).toBeTruthy();
    });
  });

  it("shelf_for_crew says what a take can reach: counted pieces with no roll are on hand but not takeable", async () => {
    if (!needs()) return;
    await tx(async () => {
      const it1 = await shelved();
      const shelfRow = async () => {
        await as(techId);
        const r = await one("select * from public.shelf_for_crew() where id = $1", [it1]);
        await asServer();
        return r;
      };
      let row = await shelfRow();
      expect(Object.keys(row).sort()).toEqual(["id", "name", "on_hand", "takeable", "unit"]);
      expect([num(row.on_hand), num(row.takeable)]).toEqual([250, 250]);
      // Count It finds 50 ft more than the roll holds: a recount_up with no roll behind it.
      await as(staffId);
      await c.query("select public.stock_recount($1, 300, 'TEST count') as r", [it1]);
      await asServer();
      row = await shelfRow();
      expect([num(row.on_hand), num(row.takeable)]).toEqual([300, 250]);
      // A take of 280 saves a 30 ft short: exactly what takeable predicted, not on_hand.
      const r = await draw(techId, it1, jobB, 280);
      expect(num(r.short)).toBe(30);
    });
  });

  it("the guard still names hours and bills the way it did before 0344", async () => {
    if (!needs()) return;
    await tx(async () => {
      const t = await coilTicket(jobA, "2001-08-19");
      const n1 = `TEST-TAKE-INV-${++seq}`;
      await claim(await invoice(jobA, n1), [t.id]);
      expect((await refusal(async () => claim(await invoice(jobA, `TEST-TAKE-INV-${++seq}`), [t.id])))?.message).toBe(`materials already billed on ${n1}`);
      const e = await one(
        `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1, $2, $3, '2001-08-20T15:00:00Z', '2001-08-20T19:00:00Z', 'closed') returning id`,
        [orgId, techId, jobA],
      );
      const n2 = `TEST-TAKE-INV-${++seq}`;
      await claim(await invoice(jobA, n2), [e.id]);
      expect((await refusal(async () => claim(await invoice(jobA, `TEST-TAKE-INV-${++seq}`), [e.id])))?.message).toBe(`hours already billed on ${n2}`);
    });
  });
}
