import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * THE ERROR SINK TRIAGES ITSELF (0399, cn-v1136). error_events is the app's own error log; this
 * proves the writer, the marker, the broom and the one read policy on the test database:
 *
 *   record_app_error      a first sighting inserts (payload = the first, last_payload null, the
 *                         company kept); a repeat counts, takes last_payload, keeps payload and the
 *                         company, never lowers the level (blocker promotes), and moves status ONE
 *                         way: fixed → new (a regression, said as reopened); new, triaged and
 *                         ignored stay. Service role only: a signed-in person is refused.
 *   platform_set_error_status  North's own team (platform_admins, 0176) marks any error; anyone
 *                         else is refused in words; a status the sink does not know is refused.
 *   sweep_error_events    fixed/ignored rows ninety days after their last sighting and trace rows
 *                         after fourteen go; a new or triaged error never does.
 *   error_events_platform_read  a platform admin reads; a company's owner reads nothing.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company,
 * with 0399 applied inside it when the database does not carry it yet (the file on this branch, so
 * what is asserted is what ships; CI rebuilds the test database from the folder, so there it is
 * already present). Every key this suite writes carries one random prefix, so rows never collide
 * with anything else on the database. Each seat is played the way PostgREST plays it:
 * request.jwt.claims under `set local role authenticated`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith(prefix))!), "utf8");
const M0399 = migration("0399_");

const SIX = "public.record_app_error(text,text,text,text,jsonb,uuid)";
const FIVE = "public.record_app_error(text,text,text,text,jsonb)";
const NOT_ADMIN = "Only North's own team can mark an error.";
const BAD_STATUS = "That isn't an error status.";

type Answer = { id: string; inserted: boolean; reopened: boolean; escalated: boolean; event_count: number; level: string; status: string };
type Row = {
  id: string;
  issue_id: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  event_count: number;
  payload: unknown;
  last_payload: unknown;
  org_id: string | null;
};

d("the error sink triages itself (0399)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let officeId = "";
  /** One random prefix per run: no key this suite writes can meet another's. */
  const run = randomUUID();
  const key = (name: string) => `${run}:${name}`;

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });

  /** PostgREST's own mechanism: the person's claims under the authenticated role. */
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  /** Someone with the anon key and no session. */
  const asAnon = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
  };
  /** The server: no claims at all, the pooler's own role (the functions' owner). */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };

  /** One sighting, as the server. Six arguments unless `five` (the call the app makes until cn-v1136). */
  const record = async (
    name: string,
    o: { title?: string | null; where?: string; level?: string | null; payload?: unknown; org?: string | null; five?: boolean } = {},
  ): Promise<Answer> => {
    const args = [key(name), o.title === undefined ? `TEST ${name}` : o.title, o.where ?? "test/0399", o.level === undefined ? "error" : o.level, JSON.stringify(o.payload ?? { n: 1 })];
    const { rows } = o.five
      ? await c.query("select public.record_app_error($1, $2, $3, $4, $5::jsonb) as r", args)
      : await c.query("select public.record_app_error($1, $2, $3, $4, $5::jsonb, $6::uuid) as r", [...args, o.org === undefined ? orgId : o.org]);
    return rows[0].r as Answer;
  };

  /** The row as the server sees it. */
  const row = async (name: string): Promise<Row | undefined> => {
    const { rows } = await c.query(
      "select id::text as id, issue_id, title, culprit, level, status, event_count, payload, last_payload, org_id::text as org_id from public.error_events where issue_id = $1",
      [key(name)],
    );
    return rows[0];
  };

  /** One attempt that is expected to be refused: its SQLSTATE and message, always undone. */
  const refused = async (who: string | "anon", sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> => {
    await c.query("savepoint attempt");
    try {
      if (who === "anon") await asAnon();
      else await as(who);
      await c.query(sql, params);
      return null;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { code: err.code, message: String(err.message ?? e) };
    } finally {
      await c.query("rollback to savepoint attempt");
      await asServer();
    }
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    const have = (await c.query(`select to_regprocedure('${SIX}') is not null as ok`)).rows[0]?.ok === true;
    if (!have) await c.query(M0399); // the sink as it ships, inside the transaction that is rolled back
    // Twice-safe, proven: the file runs again on top of itself (on CI, where the rebuild already
    // applied it, this is the second run), and its own self-check must still pass.
    await c.query(M0399);
    const org = await mintThrowawayOrg(c, { label: "0399 error sink", techs: 1 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    officeId = org.techs[0].id;
    // An office seat, promoted by the owner (0225: only an owner or admin changes roles).
    await as(ownerId);
    const promoted = (await c.query("update public.profiles set role = 'office' where id = $1 and org_id = $2 returning role::text as role", [officeId, orgId])).rows[0];
    await asServer();
    if (promoted?.role !== "office") throw new Error("0399 test: the office seat did not land.");
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("a first sighting inserts: the first payload kept, no last_payload, the company named", async () => {
    const a = await record("first", { payload: { n: 1 } });
    expect(a).toMatchObject({ inserted: true, reopened: false, escalated: false, event_count: 1, level: "error", status: "new" });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    const r = await row("first");
    expect(r).toMatchObject({ title: "TEST first", culprit: "test/0399", level: "error", status: "new", event_count: 1, payload: { n: 1 }, last_payload: null, org_id: orgId });
  });

  it("a repeat counts, takes last_payload, keeps the first payload and the company (p_org null)", async () => {
    const a = await record("first", { payload: { n: 2 }, org: null, title: "TEST first again" });
    expect(a).toMatchObject({ inserted: false, reopened: false, event_count: 2, level: "error", status: "new" });
    const r = await row("first");
    expect(r).toMatchObject({ title: "TEST first", event_count: 2, payload: { n: 1 }, last_payload: { n: 2 }, org_id: orgId });
  });

  it("a fixed error that returns is a regression: status new, said as reopened", async () => {
    await record("fixed");
    await c.query("update public.error_events set status = 'fixed' where issue_id = $1", [key("fixed")]);
    const a = await record("fixed");
    expect(a).toMatchObject({ inserted: false, reopened: true, event_count: 2, status: "new" });
    expect((await row("fixed"))?.status).toBe("new");
    // Once reopened it is new; the next repeat is not a reopen.
    expect((await record("fixed")).reopened).toBe(false);
  });

  it("an ignored error stays ignored; a triaged one stays triaged", async () => {
    await record("ignored");
    await c.query("update public.error_events set status = 'ignored' where issue_id = $1", [key("ignored")]);
    expect(await record("ignored")).toMatchObject({ inserted: false, reopened: false, event_count: 2, status: "ignored" });
    expect((await row("ignored"))?.status).toBe("ignored");
    await record("triaged");
    await c.query("update public.error_events set status = 'triaged' where issue_id = $1", [key("triaged")]);
    expect(await record("triaged")).toMatchObject({ inserted: false, reopened: false, event_count: 2, status: "triaged" });
    expect((await row("triaged"))?.status).toBe("triaged");
  });

  it("the level never goes down: blocker promotes and stays; an unknown level is error; trace lands as trace", async () => {
    expect((await record("level")).level).toBe("error");
    expect((await record("level", { level: "blocker" })).level).toBe("blocker");
    expect((await record("level", { level: "error" })).level).toBe("blocker");
    expect((await row("level"))?.level).toBe("blocker");
    expect((await record("unknown", { level: "fatal" })).level).toBe("error");
    expect((await record("nolevel", { level: null })).level).toBe("error");
    expect((await record("trace", { level: "trace" })).level).toBe("trace");
    expect((await row("trace"))?.level).toBe("trace");
  });

  it("ESCALATED (skeptic #42, S2): a triaged error repeated as a blocker is said so once — level blocker, status still triaged — and the next blocker repeat is not", async () => {
    await record("escalate");
    await c.query("update public.error_events set status = 'triaged' where issue_id = $1", [key("escalate")]);
    const first = await record("escalate", { level: "blocker" });
    expect(first).toMatchObject({ inserted: false, reopened: false, escalated: true, level: "blocker", status: "triaged", event_count: 2 });
    expect(await row("escalate")).toMatchObject({ level: "blocker", status: "triaged" });
    const again = await record("escalate", { level: "blocker" });
    expect(again).toMatchObject({ inserted: false, reopened: false, escalated: false, level: "blocker", status: "triaged", event_count: 3 });
    // A first sighting at blocker is inserted, not escalated; an error repeat on a blocker row is neither.
    expect(await record("born-blocker", { level: "blocker" })).toMatchObject({ inserted: true, escalated: false, level: "blocker" });
    expect(await record("born-blocker", { level: "error" })).toMatchObject({ inserted: false, escalated: false, level: "blocker" });
    // A fixed error returning as a blocker is both: reopened (fixed → new) and escalated (error → blocker).
    await record("fixed-then-blocker");
    await c.query("update public.error_events set status = 'fixed' where issue_id = $1", [key("fixed-then-blocker")]);
    expect(await record("fixed-then-blocker", { level: "blocker" })).toMatchObject({ inserted: false, reopened: true, escalated: true, level: "blocker", status: "new" });
  });

  it("the row read before the upsert is locked FOR UPDATE (S3): the function's own body on the database says so", async () => {
    const def = (await c.query(`select pg_get_functiondef('${SIX}'::regprocedure) as d`)).rows[0].d as string;
    expect(def).toContain("for update");
    expect(def).toContain("'escalated'");
  });

  it("a p_org that names no organization lands as null (S5): the row is kept, never lost to the foreign key", async () => {
    const stranger = randomUUID();
    const a = await record("unknown-org", { org: stranger });
    expect(a).toMatchObject({ inserted: true, event_count: 1, status: "new" });
    const r = await row("unknown-org");
    expect(r).toBeDefined();
    expect(r?.org_id).toBeNull();
    // Kept once known: a later repeat with the real company fills it; a later unknown one does not blank it.
    await record("unknown-org", { org: orgId });
    expect((await row("unknown-org"))?.org_id).toBe(orgId);
    await record("unknown-org", { org: randomUUID() });
    expect((await row("unknown-org"))?.org_id).toBe(orgId);
  });

  it("the five-argument writer is gone, the six-argument one stands, and a five-argument call lands (p_org defaulted)", async () => {
    const sig = (await c.query(`select to_regprocedure('${FIVE}') is not null as five, to_regprocedure('${SIX}') is not null as six`)).rows[0];
    expect(sig).toEqual({ five: false, six: true });
    const a = await record("fivearg", { five: true });
    expect(a).toMatchObject({ inserted: true, event_count: 1, status: "new" });
    expect((await row("fivearg"))?.org_id).toBeNull();
  });

  it("a company's owner reads nothing and cannot call the writer or the broom", async () => {
    await c.query("savepoint owner_reads");
    try {
      await as(ownerId);
      const { rows } = await c.query("select id from public.error_events where issue_id like $1", [`${run}:%`]);
      expect(rows).toEqual([]);
    } finally {
      await c.query("rollback to savepoint owner_reads");
      await asServer();
    }
    const write = await refused(ownerId, "select public.record_app_error($1, 'TEST', 'test/0399', 'error', '{}'::jsonb, $2::uuid)", [key("owner-writes"), orgId]);
    expect(write?.code).toBe("42501");
    const sweep = await refused(ownerId, "select public.sweep_error_events()");
    expect(sweep?.code).toBe("42501");
    expect(await row("owner-writes")).toBeUndefined();
  });

  it("North's own team reads every row and marks any error; anyone else is refused in words", async () => {
    await c.query("insert into public.platform_admins (user_id, note) values ($1, 'TEST 0399, rolled back')", [ownerId]);
    const planted = (await c.query("select count(*)::int as n from public.error_events where issue_id like $1", [`${run}:%`])).rows[0].n;
    expect(planted).toBeGreaterThan(5);
    const first = await row("first");
    await c.query("savepoint admin");
    try {
      await as(ownerId);
      const { rows } = await c.query("select id from public.error_events where issue_id like $1", [`${run}:%`]);
      expect(rows.length).toBe(planted);
      const marked = (await c.query("select public.platform_set_error_status($1::uuid, 'triaged') as ok", [first!.id])).rows[0].ok;
      expect(marked).toBe(true);
      const read = (await c.query("select status from public.error_events where issue_id = $1", [key("first")])).rows[0];
      expect(read?.status).toBe("triaged");
      const missing = (await c.query("select public.platform_set_error_status($1::uuid, 'fixed') as ok", [randomUUID()])).rows[0].ok;
      expect(missing).toBe(false);
    } finally {
      await c.query("rollback to savepoint admin");
      await asServer();
    }
    const bad = await refused(ownerId, "select public.platform_set_error_status($1::uuid, 'resolved')", [first!.id]);
    expect(bad).toMatchObject({ code: "22023", message: BAD_STATUS });
    const office = await refused(officeId, "select public.platform_set_error_status($1::uuid, 'triaged')", [first!.id]);
    expect(office).toMatchObject({ code: "42501", message: NOT_ADMIN });
    const anon = await refused("anon", "select public.platform_set_error_status($1::uuid, 'triaged')", [first!.id]);
    expect(anon?.code).toBe("42501");
    // Nothing of that landed.
    expect((await row("first"))?.status).toBe("new");
  });

  it("the broom: fixed and ignored rows after ninety days, trace rows after fourteen; new and triaged never", async () => {
    // Rows nobody in this suite planted that the broom would also take (there may be some on a
    // shared database): counted first, so the answer is asserted exactly.
    const baseline = (
      await c.query(
        `select count(*) filter (where status in ('fixed', 'ignored') and last_seen < now() - interval '90 days')::int as closed,
                count(*) filter (where level = 'trace' and last_seen < now() - interval '14 days'
                                   and not (status in ('fixed', 'ignored') and last_seen < now() - interval '90 days'))::int as trace
           from public.error_events where issue_id is null or issue_id not like $1`,
        [`${run}:%`],
      )
    ).rows[0];
    const plant = async (name: string, status: string, level: string, daysAgo: number) => {
      await record(name, { level });
      await c.query("update public.error_events set status = $2, last_seen = now() - make_interval(days => $3::int) where issue_id = $1", [key(name), status, daysAgo]);
    };
    await plant("old-fixed", "fixed", "error", 91);
    await plant("old-ignored", "ignored", "error", 100);
    await plant("old-trace", "new", "trace", 15);
    await plant("old-new", "new", "error", 400);
    await plant("old-triaged", "triaged", "error", 200);
    await plant("young-fixed", "fixed", "error", 89);
    await plant("young-trace", "new", "trace", 13);
    const swept = (await c.query("select public.sweep_error_events() as r")).rows[0].r;
    expect(swept).toEqual({ closed_deleted: baseline.closed + 2, trace_deleted: baseline.trace + 1 });
    expect(await row("old-fixed")).toBeUndefined();
    expect(await row("old-ignored")).toBeUndefined();
    expect(await row("old-trace")).toBeUndefined();
    expect((await row("old-new"))?.status).toBe("new");
    expect((await row("old-triaged"))?.status).toBe("triaged");
    expect((await row("young-fixed"))?.status).toBe("fixed");
    expect((await row("young-trace"))?.level).toBe("trace");
  });
});
