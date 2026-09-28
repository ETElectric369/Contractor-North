import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * AN ENDLESS NEEDS YOU ROW WAITS UNTIL A DAY (0367 public.needs_you_waits), where the rule lives: the
 * database.
 *
 *   · the office of a company keeps its own waits: one row per row key (a second Snooze moves the
 *     day), with who snoozed it and when written by the database, never by the client;
 *   · nothing waits without a day (until is never empty), and a key has its shape;
 *   · another company's office reads none of them and can't write one into this company;
 *   · a tech reads none and writes none (the rows a Snooze parks are money nudges);
 *   · anon reaches nothing; the office clears its own passed waits, and only its own.
 *
 * Everything happens inside ONE transaction that is always rolled back, on throwaway companies
 * (lib/throwaway-org.db-fixture). 0367 is applied inside that transaction (the file on this branch, so
 * what is asserted is exactly what ships; it is safe to run twice, so a database that already has it
 * just runs it again). People speak by planted request.jwt.claims under `set local role authenticated`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0367 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0367_"))!), "utf8");

d("an endless Needs You row waits until a day (0367 needs_you_waits)", () => {
  let c: pg.Client;
  let ready = false;
  let orgA = "";
  let orgB = "";
  let ownerA = "";
  let ownerB = "";
  let techA = "";

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
  /** A statement that SHOULD be refused, as `uid`: its SQLSTATE, or null if it went through (then
   *  undone). Rolling back to the savepoint also undoes the role and claims set after it. */
  const refused = async (uid: string, sql: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint refused");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await c.query("set local role authenticated");
      await c.query(sql, params);
      return null;
    } catch (e: any) {
      return String(e.code);
    } finally {
      await c.query("rollback to savepoint refused");
      await asServer();
    }
  };
  /** What really landed, read as the server (RLS off). */
  const landed = async (org: string) =>
    (
      await c.query(
        "select item_key, until::text as until, reason, created_by::text as created_by, created_at from public.needs_you_waits where org_id = $1 order by item_key",
        [org],
      )
    ).rows;
  const snooze = (key: string, until: string, reason: string | null = null, org?: string, by?: string) =>
    c.query(
      `insert into public.needs_you_waits (org_id, item_key, until, reason, created_by)
       values (coalesce($1::uuid, public.auth_org_id()), $2, $3::date, $4, $5::uuid)
       on conflict (org_id, item_key) do update set until = excluded.until, reason = excluded.reason, created_by = excluded.created_by
       returning id`,
      [org ?? null, key, until, reason, by ?? null],
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    const had = (await c.query("select to_regclass('public.needs_you_waits') is not null as ok")).rows[0].ok;
    await c.query(M0367);
    // Safe to run twice: a second run changes nothing and still passes its own checks.
    await c.query(M0367);
    console.warn(`[needs-you-waits] 0367 ${had ? "was already on this database; ran it again (twice)" : "applied (twice)"} inside the test's own transaction, which is rolled back.`);
    await c.query("set local statement_timeout = '30s'");

    const a = await mintThrowawayOrg(c, { label: "0367 waits A", techs: 1 });
    const b = await mintThrowawayOrg(c, { label: "0367 waits B", techs: 0 });
    orgA = a.orgId;
    orgB = b.orgId;
    ownerA = a.owner.id;
    ownerB = b.owner.id;
    techA = a.techs[0].id;
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the office keeps its own waits: one row per key, a second Snooze moves the day", async () => {
    await asPerson(ownerA, () => snooze("materials_needed:job-1", "2026-10-03", "Breaker back-ordered"));
    await asPerson(ownerA, () => snooze("materials_needed:job-1", "2026-10-10", "Still back-ordered"));
    await asPerson(ownerA, () => snooze("job_unbilled_work:job-2", "2026-10-05"));
    const rows = await landed(orgA);
    expect(rows.map((r) => [r.item_key, r.until, r.reason])).toEqual([
      ["job_unbilled_work:job-2", "2026-10-05", null],
      ["materials_needed:job-1", "2026-10-10", "Still back-ordered"],
    ]);
    // It reads them back as itself.
    const mine = await asPerson(ownerA, () => c.query("select item_key from public.needs_you_waits order by item_key"));
    expect(mine.rows.map((r) => r.item_key)).toEqual(["job_unbilled_work:job-2", "materials_needed:job-1"]);
  });

  it("who snoozed it is the signed-in person, never the one the client sent; the company is stamped", async () => {
    await asPerson(ownerA, () => snooze("materials_needed:job-3", "2026-10-03", null, undefined, techA));
    const row = (await landed(orgA)).find((r) => r.item_key === "materials_needed:job-3");
    expect(row?.created_by).toBe(ownerA);
    expect(row?.created_at).toBeTruthy();
  });

  it("nothing waits without a day, and a key has its shape", async () => {
    expect(await refused(ownerA, "insert into public.needs_you_waits (org_id, item_key, until) values ($1, 'materials_needed:job-9', null)", [orgA])).toBe("23502");
    expect(await refused(ownerA, "insert into public.needs_you_waits (org_id, item_key, until) values ($1, 'no key shape', '2026-10-03')", [orgA])).toBe("23514");
    expect(await refused(ownerA, "insert into public.needs_you_waits (org_id, item_key, until, reason) values ($1, 'materials_needed:job-9', '2026-10-03', repeat('x', 201))", [orgA])).toBe("23514");
  });

  it("another company's office reads none of them, and can't write one into this company", async () => {
    await asPerson(ownerA, () => snooze("materials_needed:job-4", "2026-10-03"));
    const seen = await asPerson(ownerB, () => c.query("select item_key from public.needs_you_waits where org_id = $1", [orgA]));
    expect(seen.rows).toEqual([]);
    expect(await refused(ownerB, "insert into public.needs_you_waits (org_id, item_key, until) values ($1, 'materials_needed:job-5', '2026-10-03')", [orgA])).toBe("42501");
    // Its own company it can.
    await asPerson(ownerB, () => snooze("materials_needed:job-6", "2026-10-03"));
    expect((await landed(orgB)).map((r) => r.item_key)).toEqual(["materials_needed:job-6"]);
    // An update aimed at the other company's row changes nothing.
    await asPerson(ownerB, () => c.query("update public.needs_you_waits set until = '2027-01-01' where org_id = $1", [orgA]));
    expect((await landed(orgA)).every((r) => r.until !== "2027-01-01")).toBe(true);
  });

  it("a tech reads none and writes none", async () => {
    await asPerson(ownerA, () => snooze("materials_needed:job-7", "2026-10-03"));
    const seen = await asPerson(techA, () => c.query("select item_key from public.needs_you_waits"));
    expect(seen.rows).toEqual([]);
    expect(await refused(techA, "insert into public.needs_you_waits (org_id, item_key, until) values ($1, 'materials_needed:job-8', '2026-10-03')", [orgA])).toBe("42501");
    const before = (await landed(orgA)).length;
    await asPerson(techA, () => c.query("delete from public.needs_you_waits where org_id = $1", [orgA]));
    expect((await landed(orgA)).length).toBe(before);
  });

  it("anon reaches nothing", async () => {
    const r = (
      await c.query(
        "select has_table_privilege('anon', 'public.needs_you_waits', 'select') as s, has_table_privilege('anon', 'public.needs_you_waits', 'insert') as i, has_table_privilege('anon', 'public.needs_you_waits', 'delete') as d",
      )
    ).rows[0];
    expect(r).toEqual({ s: false, i: false, d: false });
  });

  it("the office clears its own passed waits, and only its own", async () => {
    await asPerson(ownerA, () => snooze("materials_needed:old-1", "2026-01-02"));
    await asPerson(ownerB, () => snooze("materials_needed:old-2", "2026-01-02"));
    await asPerson(ownerA, () => c.query("delete from public.needs_you_waits where until < '2026-02-01'"));
    expect((await landed(orgA)).map((r) => r.item_key)).not.toContain("materials_needed:old-1");
    expect((await landed(orgB)).map((r) => r.item_key)).toContain("materials_needed:old-2");
  });
});
