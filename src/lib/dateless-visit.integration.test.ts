import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * A VISIT CAN WAIT FOR A DAY (0368), where the rule lives: the database, with the office's own
 * session. The visit page's Clear The Date (unscheduleAppointment) writes starts_at = null, and 0042
 * made the column NOT NULL, so on production every press failed (found 2026-09-27).
 *
 *   before 0368  the office's own write is refused with 23502, exactly the dead door (shown when this
 *                database doesn't have 0368 yet; unscheduleAppointment turns that code into words);
 *   after 0368   the same write lands (one row, the silent-write law's id back); the schedule rail's own
 *                read (no start, not cancelled or completed) lists the visit; the range readers (My
 *                Day, the calendar, the crew board) never draw it; the walk-throughs list, descending
 *                with nulls last, puts it after every dated visit; placing it again (the rail's
 *                rescheduleAppointment write) takes it off the rail; a completed visit's date is
 *                history and the door's status filter leaves it alone; a tech reads his own waiting
 *                visit (0227's policy, unchanged); and 0368 runs twice without complaint.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company
 * (lib/throwaway-org.db-fixture). 0368 is applied inside that transaction (the file on this branch,
 * so what is asserted is exactly what ships). People speak by planted request.jwt.claims under `set
 * local role authenticated`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0368 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0368_"))!), "utf8");

d("a visit can wait for a day (0368)", () => {
  let c: pg.Client;
  let ready = false;
  let had = false;
  /** Before 0368: the error code the office's Clear The Date got (null when the database already had it). */
  let refusedWith: string | null = null;
  let orgId = "";
  let ownerId = "";
  let techId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run as `uid` (a signed-in person), then back to the server. */
  const asPerson = async <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
    try {
      return await fn();
    } finally {
      await asServer();
    }
  };
  const visit = async (startsAt: string | null, over: { status?: string; assignedTo?: string | null; title?: string } = {}) =>
    (
      await c.query(
        `insert into public.appointments (org_id, type, title, starts_at, ends_at, status, assigned_to)
         values ($1, 'service_call', $2, $3::timestamptz, case when $3::timestamptz is null then null else $3::timestamptz + interval '1 hour' end, $4, $5)
         returning id::text as id`,
        [orgId, over.title ?? "TEST 0368 visit", startsAt, over.status ?? "scheduled", over.assignedTo ?? null],
      )
    ).rows[0].id as string;
  /** unscheduleAppointment's own write, as the office. */
  const clearTheDate = (id: string) =>
    asPerson(ownerId, async () =>
      (
        await c.query(
          "update public.appointments set starts_at = null, ends_at = null, updated_at = now() where id = $1 and status in ('scheduled', 'proposed') returning id::text as id",
          [id],
        )
      ).rows,
    );
  /** The schedule rail's read (schedule/page.tsx "a booking with no time on it yet"), as the office. */
  const railIds = () =>
    asPerson(ownerId, async () =>
      (await c.query("select id::text as id from public.appointments where starts_at is null and status not in ('cancelled', 'completed')")).rows.map(
        (r) => r.id as string,
      ),
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");

    const org = await mintThrowawayOrg(c, { label: "0368 dateless visit", techs: 1 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    techId = org.techs[0].id;

    had = (
      await c.query(
        "select is_nullable = 'YES' as yes from information_schema.columns where table_schema = 'public' and table_name = 'appointments' and column_name = 'starts_at'",
      )
    ).rows[0]?.yes === true;
    if (!had) {
      // THE DEAD DOOR, shown: the office's own Clear The Date, refused by 0042's NOT NULL. By hand,
      // not through asPerson: after a refused statement the transaction takes nothing but the
      // rollback to the savepoint (which also undoes the SET LOCAL role and claims).
      const id = await visit("2026-10-05T16:00:00Z");
      await c.query("savepoint before_0368");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
      await c.query("set local role authenticated");
      try {
        await c.query(
          "update public.appointments set starts_at = null, ends_at = null, updated_at = now() where id = $1 and status in ('scheduled', 'proposed') returning id",
          [id],
        );
        refusedWith = "none";
      } catch (e) {
        refusedWith = String((e as { code?: string }).code ?? "unknown");
      }
      await c.query("rollback to savepoint before_0368");
      await asServer();
    }
    await c.query(M0368);
    console.warn(`[dateless-visit] 0368 ${had ? "was already on this database; ran it again" : "applied"} inside the test's own transaction, which is rolled back.`);
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("before 0368 the office's Clear The Date was refused with 23502 (the dead door); after it the column takes a missing start", async () => {
    if (!had) expect(refusedWith).toBe("23502");
    const nullable = (
      await c.query("select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'appointments' and column_name = 'starts_at'")
    ).rows[0]?.is_nullable;
    expect(nullable).toBe("YES");
  });

  it("Clear The Date lands (its id comes back), and the visit waits on the schedule's rail", async () => {
    const id = await visit("2026-10-06T16:00:00Z");
    expect(await clearTheDate(id)).toEqual([{ id }]);
    const row = (await c.query("select starts_at, ends_at, status from public.appointments where id = $1", [id])).rows[0];
    expect(row).toEqual({ starts_at: null, ends_at: null, status: "scheduled" });
    expect(await railIds()).toContain(id);
  });

  it("the range readers (My Day, the calendar, the crew board) never draw a visit with no day", async () => {
    const waiting = await visit("2026-10-07T16:00:00Z");
    await clearTheDate(waiting);
    const dated = await visit("2026-10-07T18:00:00Z");
    const inRange = await asPerson(ownerId, async () =>
      (
        await c.query("select id::text as id from public.appointments where starts_at >= $1 and starts_at < $2 and org_id = $3", [
          "2026-10-07T00:00:00Z",
          "2026-10-08T00:00:00Z",
          orgId,
        ])
      ).rows.map((r) => r.id as string),
    );
    expect(inRange).toContain(dated);
    expect(inRange).not.toContain(waiting);
  });

  it("the walk-throughs list, newest first, puts a waiting visit after every dated one", async () => {
    const waiting = await visit("2026-10-08T16:00:00Z", { title: "TEST 0368 waiting" });
    await clearTheDate(waiting);
    await visit("2026-10-09T16:00:00Z", { title: "TEST 0368 dated" });
    const order = await asPerson(ownerId, async () =>
      (await c.query("select id::text as id from public.appointments where org_id = $1 order by starts_at desc nulls last", [orgId])).rows.map((r) => r.id as string),
    );
    const firstNull = order.indexOf(waiting);
    const dates = (await c.query("select id::text as id, starts_at from public.appointments where id = any($1::uuid[])", [order])).rows;
    const lastDated = Math.max(...order.map((id, i) => (dates.find((r) => r.id === id)?.starts_at ? i : -1)));
    expect(firstNull).toBeGreaterThan(lastDated);
  });

  it("placing it again takes it off the rail; a completed visit's date is history and is never cleared", async () => {
    const id = await visit("2026-10-10T16:00:00Z");
    await clearTheDate(id);
    const placed = await asPerson(ownerId, async () =>
      (await c.query("update public.appointments set starts_at = $2, ends_at = $3 where id = $1 returning id::text as id", [id, "2026-10-12T16:00:00Z", "2026-10-12T17:00:00Z"])).rows,
    );
    expect(placed).toEqual([{ id }]);
    expect(await railIds()).not.toContain(id);

    const done = await visit("2026-09-20T16:00:00Z", { status: "completed" });
    expect(await clearTheDate(done)).toEqual([]);
    expect((await c.query("select starts_at from public.appointments where id = $1", [done])).rows[0].starts_at).not.toBeNull();
  });

  it("a tech still reads his own visit while it waits for a day (0227's policy is unchanged)", async () => {
    const id = await visit("2026-10-11T16:00:00Z", { assignedTo: techId });
    await clearTheDate(id);
    const seen = await asPerson(techId, async () => (await c.query("select id::text as id, starts_at from public.appointments where id = $1", [id])).rows);
    expect(seen).toEqual([{ id, starts_at: null }]);
  });

  it("0368 runs twice without complaint", async () => {
    await c.query("savepoint again_0368");
    await expect(c.query(M0368)).resolves.toBeTruthy();
    await c.query("release savepoint again_0368");
  });
});
