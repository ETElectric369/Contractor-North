import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg, type ThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { OPEN_BUGS_FILTER } from "@/lib/bug-watch-count";
import { LINK_OFFER_WINDOW_MS } from "@/lib/actions/link-offer";

/**
 * THE SHELL'S TWO NEW READS, WHERE THEIR BOUNDARIES LIVE: the database (Wave 1, lane 1b).
 *
 *   · BUG WATCH · N (lib/bug-watch-count): one head count of bug_reports under the viewer's own RLS,
 *     by the Bugs page's rule (status null or 'open'). A platform admin counts every company's open
 *     reports — exactly the Bugs page's list — and a company's staff would count only their own.
 *   · THE LINK OFFER'S CANDIDATES (customer.create / customer.update → recentCustomerlessVisits):
 *     visits THIS person booked lately, still customer-less, scheduled or proposed, never another
 *     company's. Every column and status value the read names is checked to exist here, because a
 *     missing one would make the offer fail quietly (the handler swallows it: best-effort).
 *
 * PostgREST turns `.or("status.is.null,status.eq.open")` and the chained filters into the SQL below,
 * so these run that SQL as the person, under RLS. Everything happens inside ONE transaction that is
 * always rolled back, on throwaway companies; platform_admins gets a TEST row that rolls back too.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run src/lib/shell-reads.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** The Bugs page's open rule, as the SQL PostgREST makes of OPEN_BUGS_FILTER. */
const OPEN_BUGS_SQL = "select count(*)::int as n from public.bug_reports where (status is null or status = 'open')";

d("the shell's new reads: Bug Watch's open count and the link offer's candidates", () => {
  let c: pg.Client;
  let a: ThrowawayOrg;
  let b: ThrowawayOrg;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** Run as `uid` (a real sign-in under RLS), always back to the server after. */
  const asPerson = async <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
    try {
      return await fn();
    } finally {
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
    }
  };
  const openBugsAs = (uid: string) => asPerson(uid, async () => Number((await one(OPEN_BUGS_SQL)).n));
  const bug = (org: string, status: string) =>
    c.query("insert into public.bug_reports (org_id, note, page, status) values ($1, 'TEST shell reads, rolled back', '/planner', $2)", [org, status]);

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '30s'");
    a = await mintThrowawayOrg(c, { label: "shell reads", techs: 1 });
    b = await mintThrowawayOrg(c, { label: "shell reads admin", techs: 0 });
    // North's own team, for this transaction only: company B's owner stands in for a platform admin.
    await c.query("insert into public.platform_admins (user_id, note) values ($1, 'TEST shell reads, rolled back')", [b.owner.id]);
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("bug_reports.status is never null (default 'open'), so the null arm of the rule is only a guard", async () => {
    expect(OPEN_BUGS_FILTER).toBe("status.is.null,status.eq.open");
    const col = await one(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'bug_reports' and column_name = 'status'`,
    );
    expect(col.is_nullable).toBe("NO");
    expect(String(col.column_default)).toContain("'open'");
  });

  it("a platform admin counts every company's OPEN reports; a fixed one never counts", async () => {
    const before = await openBugsAs(b.owner.id);
    await bug(a.orgId, "open");
    await bug(a.orgId, "open");
    await bug(a.orgId, "fixed");
    await bug(b.orgId, "open");
    await bug(b.orgId, "wontfix");
    expect(await openBugsAs(b.owner.id)).toBe(before + 3);
  });

  it("a company's own staff would count only their own (the layout never asks for them anyway)", async () => {
    const mine = await asPerson(a.owner.id, async () =>
      Number((await one(`${OPEN_BUGS_SQL} and org_id <> $1`, [a.orgId])).n),
    );
    expect(mine).toBe(0);
    expect(await openBugsAs(a.owner.id)).toBeGreaterThanOrEqual(2);
    // A tech reads no bug reports at all.
    expect(await openBugsAs(a.techs[0].id)).toBe(0);
  });

  it("the link offer reads only visits THIS person booked lately that still have no customer and are still to happen", async () => {
    const owner = a.owner.id;
    const tech = a.techs[0].id;
    const cust = String((await one("insert into public.customers (org_id, name) values ($1, 'TEST Tom Goodman') returning id", [a.orgId])).id);
    const visit = async (title: string, over: { status?: string; customer?: string | null; by?: string; org?: string; ageHours?: number } = {}) =>
      String(
        (
          await one(
            `insert into public.appointments (org_id, title, type, starts_at, location, status, customer_id, created_by, created_at)
             values ($1, $2, 'inspection', now() + interval '1 day', '3245 W. Garnet Blvd', $3, $4, $5, now() - make_interval(hours => $6))
             returning id`,
            [over.org ?? a.orgId, title, over.status ?? "scheduled", over.customer ?? null, over.by ?? owner, over.ageHours ?? 0],
          )
        ).id,
      );
    const booked = await visit("Inspection: Tom Goodman");
    const offered = await visit("Walk — Tom Goodman", { status: "proposed" });
    await visit("Linked already — Tom Goodman", { customer: cust });
    await visit("Done — Tom Goodman", { status: "completed" });
    await visit("Cancelled — Tom Goodman", { status: "cancelled" });
    await visit("Someone else's — Tom Goodman", { by: tech });
    await visit("Too old — Tom Goodman", { ageHours: 4 });
    await visit("Another company's — Tom Goodman", { org: b.orgId, by: b.owner.id });

    // The handler's read (recentCustomerlessVisits), as the person, under RLS.
    const since = new Date(Date.now() - LINK_OFFER_WINDOW_MS).toISOString();
    const rows = await asPerson(owner, async () =>
      (
        await c.query(
          `select id, title, location, starts_at from public.appointments
            where customer_id is null and created_by = $1 and status in ('scheduled', 'proposed') and created_at >= $2
            order by created_at desc limit 10`,
          [owner, since],
        )
      ).rows,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([booked, offered].sort());
    // The columns it selects are plain: no inspection answers (0366 revokes those, not these).
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "location", "starts_at", "title"]);
    // Another company's visit is invisible to him whatever the filters say.
    const theirs = await asPerson(owner, async () => Number((await one("select count(*)::int as n from public.appointments where org_id = $1", [b.orgId])).n));
    expect(theirs).toBe(0);
  });
});
