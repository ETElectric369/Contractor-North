import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * WON'T HAPPEN, PUT IT BACK, FIVE KINDS AND THE LEAD'S TYPE (Wave 2 lane 4), where the rules meet
 * the database: the office's own session, under RLS.
 *
 *   Won't Happen's four facts   the office can see an invoice that points at its visit and a
 *                               pick-a-time link waiting on it (a read RLS hid would read as "nothing
 *                               there" and turn a cancel into a delete), and the answers come through
 *                               appointment_answers;
 *   why it never deletes then   deleting a visit a bill points at cuts the bill's link to it (0233's
 *                               ON DELETE SET NULL) and kills the customer's link (0052's cascade);
 *   the delete on the row read  keyed on the updated_at it read, the delete removes the row when
 *                               nothing changed and nothing once a capture save has touched it;
 *   Put It Back On The Schedule a cancelled visit whose day passed comes back scheduled and waiting
 *                               for a day (0368: applied inside this transaction when missing), on
 *                               the schedule rail's read; a day still ahead is kept; only cancelled;
 *   the five kinds              Other books (0232's check) and an old Client Meeting keeps its kind;
 *   the lead's type             the edit's type write skips an Industrial lead and still reaches one
 *                               with no type yet (`type is null or type <> 'industrial'`).
 *
 * ONE connection, BEGIN first, everything on a throwaway company, ROLLBACK at the end.
 *
 *   CI=true TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0368 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0368_"))!), "utf8");

d("a visit that won't happen, and one put back (Wave 2 lane 4)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const asOffice = async <T>(fn: () => Promise<T>): Promise<T> => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
    await c.query("set local role authenticated");
    try {
      return await fn();
    } finally {
      await asServer();
    }
  };
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const visit = async (over: { type?: string; status?: string; startsAt?: string | null; capture?: unknown } = {}) =>
    String(
      (
        await one(
          `insert into public.appointments (org_id, type, title, starts_at, status, capture)
           values ($1, $2, 'TEST lane 4 visit', $3::timestamptz, $4, $5::jsonb) returning id::text as id`,
          [orgId, over.type ?? "inspection", over.startsAt === undefined ? "2026-10-05T16:00:00Z" : over.startsAt, over.status ?? "scheduled", JSON.stringify(over.capture ?? null)],
        )
      ).id,
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const org = await mintThrowawayOrg(c, { label: "lane 4 visit header", techs: 0 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    const nullable = (
      await one("select is_nullable = 'YES' as yes from information_schema.columns where table_schema = 'public' and table_name = 'appointments' and column_name = 'starts_at'")
    )?.yes === true;
    if (!nullable) await c.query(M0368);
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("Won't Happen's facts, as the office: the invoice that points at the visit, the link waiting on it, the answers through the view", async () => {
    const v = await visit();
    await one("insert into public.invoices (org_id, invoice_number, status, invoice_kind, total, appointment_id) values ($1, 'TEST-L4-1', 'draft', 'standard', 0, $2) returning id", [orgId, v]);
    await one("insert into public.schedule_proposals (org_id, appointment_id, dates) values ($1, $2, $3::jsonb) returning id", [orgId, v, JSON.stringify([{ date: "2026-10-06", time: "09:00" }])]);
    await c.query("update public.appointments set inspection_answers = $2::jsonb where id = $1", [v, JSON.stringify({ work_type: "Lighting" })]);
    const facts = await asOffice(async () => ({
      invoices: Number((await one("select count(*)::int as n from public.invoices where appointment_id = $1 and org_id = $2", [v, orgId])).n),
      links: Number((await one("select count(*)::int as n from public.schedule_proposals where appointment_id = $1 and status = 'pending' and org_id = $2", [v, orgId])).n),
      answers: (await one("select inspection_answers from public.appointment_answers where id = $1", [v]))?.inspection_answers,
    }));
    expect(facts).toEqual({ invoices: 1, links: 1, answers: { work_type: "Lighting" } });
  });

  it("why it never deletes then: the delete would cut the bill's link to its visit and kill the customer's link", async () => {
    const v = await visit();
    const inv = String((await one("insert into public.invoices (org_id, invoice_number, status, invoice_kind, total, appointment_id) values ($1, 'TEST-L4-2', 'draft', 'standard', 0, $2) returning id::text as id", [orgId, v])).id);
    const link = String((await one("insert into public.schedule_proposals (org_id, appointment_id, dates) values ($1, $2, '[]'::jsonb) returning id::text as id", [orgId, v])).id);
    await c.query("savepoint the_delete_it_never_makes");
    await asOffice(() => c.query("delete from public.appointments where id = $1 and org_id = $2", [v, orgId]));
    expect((await one("select appointment_id from public.invoices where id = $1", [inv])).appointment_id).toBeNull();
    expect((await c.query("select id from public.schedule_proposals where id = $1", [link])).rows).toEqual([]);
    await c.query("rollback to savepoint the_delete_it_never_makes");
  });

  it("the delete lands only on the visit as it was read: a capture saved since leaves it standing (and Cancel is the path)", async () => {
    // The stamp as the app reads it: full precision, as text (what PostgREST hands back), never a
    // JavaScript Date, which would drop the microseconds and match nothing.
    const stampOf = async (id: string) => String((await asOffice(() => one("select updated_at::text as at from public.appointments where id = $1", [id]))).at);
    const deleteAsRead = (id: string, at: string) =>
      asOffice(async () =>
        (await c.query("delete from public.appointments where id = $1 and status = 'scheduled' and updated_at = $2::timestamptz and org_id = $3 returning id::text as id", [id, at, orgId])).rows,
      );

    const v = await visit();
    const read = await stampOf(v);
    // A capture saved in between (every capture writer stamps updated_at).
    await asOffice(() => c.query("update public.appointments set capture = $2::jsonb, updated_at = clock_timestamp() where id = $1", [v, JSON.stringify({ notes: "Panel is behind the heater" })]));
    expect(await deleteAsRead(v, read)).toEqual([]);
    expect((await c.query("select id from public.appointments where id = $1", [v])).rows).toHaveLength(1);

    // Untouched since the read: the same delete takes it.
    const clean = await visit();
    expect(await deleteAsRead(clean, await stampOf(clean))).toEqual([{ id: clean }]);
  });

  it("Put It Back On The Schedule: a passed day comes back waiting for a day, on the rail; a day ahead is kept; only a cancelled visit", async () => {
    const passed = await visit({ status: "cancelled", startsAt: "2026-01-05T17:00:00Z" });
    const back = await asOffice(async () =>
      (
        await c.query(
          "update public.appointments set status = 'scheduled', starts_at = null, ends_at = null, updated_at = now() where id = $1 and status = 'cancelled' and org_id = $2 returning id::text as id",
          [passed, orgId],
        )
      ).rows,
    );
    expect(back).toEqual([{ id: passed }]);
    const rail = await asOffice(async () =>
      (await c.query("select id::text as id from public.appointments where starts_at is null and status not in ('cancelled', 'completed') and org_id = $1", [orgId])).rows.map((r) => r.id),
    );
    expect(rail).toContain(passed);

    const ahead = await visit({ status: "cancelled", startsAt: "2031-10-05T17:00:00Z" });
    await asOffice(() => c.query("update public.appointments set status = 'scheduled', updated_at = now() where id = $1 and status = 'cancelled' and org_id = $2", [ahead, orgId]));
    expect(await one("select status, starts_at::text as starts from public.appointments where id = $1", [ahead])).toMatchObject({ status: "scheduled" });
    expect((await one("select starts_at from public.appointments where id = $1", [ahead])).starts_at).not.toBeNull();

    const live = await visit({ status: "scheduled" });
    const refused = await asOffice(async () =>
      (await c.query("update public.appointments set status = 'scheduled' where id = $1 and status = 'cancelled' and org_id = $2 returning id", [live, orgId])).rows,
    );
    expect(refused).toEqual([]);
  });

  it("the five kinds: Other books, and an old Client Meeting keeps its kind when its time moves", async () => {
    const other = await asOffice(async () =>
      (await c.query("insert into public.appointments (type, title, starts_at) values ('other', 'TEST lane 4 other', '2026-10-05T16:00:00Z') returning type")).rows[0],
    );
    expect(other).toEqual({ type: "other" });
    const meeting = await visit({ type: "meeting" });
    const moved = await asOffice(async () =>
      (await c.query("update public.appointments set type = 'meeting', starts_at = '2026-10-07T16:00:00Z' where id = $1 and org_id = $2 returning type", [meeting, orgId])).rows,
    );
    expect(moved).toEqual([{ type: "meeting" }]);
  });

  it("the lead's type: an edit's type write never demotes an Industrial lead and still reaches one with no type yet", async () => {
    const lead = async (type: string | null) =>
      String((await one("insert into public.inquiries (org_id, name, status, type) values ($1, 'TEST lane 4 lead', 'new', $2) returning id::text as id", [orgId, type])).id);
    const industrial = await lead("industrial");
    const untyped = await lead(null);
    const residential = await lead("residential");
    const write = (id: string) =>
      asOffice(async () =>
        (await c.query("update public.inquiries set type = 'commercial' where id = $1 and org_id = $2 and (type is null or type <> 'industrial') returning id::text as id", [id, orgId])).rows,
      );
    expect(await write(industrial)).toEqual([]);
    expect(await write(untyped)).toEqual([{ id: untyped }]);
    expect(await write(residential)).toEqual([{ id: residential }]);
    const types = (await c.query("select id::text as id, type from public.inquiries where id = any($1::uuid[])", [[industrial, untyped, residential]])).rows;
    expect(Object.fromEntries(types.map((r) => [r.id, r.type]))).toEqual({ [industrial]: "industrial", [untyped]: "commercial", [residential]: "commercial" });
  });
});
