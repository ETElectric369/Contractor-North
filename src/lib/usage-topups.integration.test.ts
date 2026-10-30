import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * ONE USAGE WINDOW, TOPPED UP (0401, cn-v1140) on the test database:
 *
 *   add_usage_topup     inserts once per Stripe Checkout session and answers {id, inserted: true};
 *                       the same session again answers inserted: false with the SAME id and no second
 *                       row; a blank session, a month that is not YYYY-MM, usage ≤ 0 and an unknown
 *                       company are refused in words (22023), nothing written.
 *   usage_topup_total   sums one company's one month only: another month's and another company's
 *                       top-ups are not in it; 0 when there is nothing.
 *   ai_spend_from       sums the ledger (ai_usage, 0162, written through record_ai_usage as the
 *                       server) from the date given: rows before it are out, rows on and after it are
 *                       in; another company's rows never count; 0 for a company with none.
 *   the grants          anon and a signed-in person get 42501 on all three; the table answers a
 *                       signed-in person zero rows where the server sees one, and refuses an insert.
 *
 * Everything happens inside ONE transaction that is always rolled back, on throwaway companies, with
 * 0401 applied inside it when the database does not carry it yet (the file on this branch, so what is
 * asserted is what ships) and applied AGAIN on top of itself (twice-safe, proven). Every statement
 * names a throwaway company's id; the fixture's stand-in names are the no-real-names test's.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith(prefix))!), "utf8");
const M0401 = migration("0401_");

const ADD = "public.add_usage_topup(uuid,text,numeric,text)";
const TOTAL = "public.usage_topup_total(uuid,text)";
const FROM = "public.ai_spend_from(uuid,date)";

/** Session ids in the test's own shape, never a vendor's real one. */
const SESSION_1 = "sess-larkspur-1";
const SESSION_2 = "sess-larkspur-2";
const SESSION_OTHER = "sess-snowbell-1";

d("one usage window, topped up (0401)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let otherOrgId = "";
  let ownerId = "";

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
  /** The server: no claims at all, the pooler's own role (the functions' owner; RLS does not bind it). */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };

  /** One statement that is expected to be refused: its SQLSTATE and message, always undone. */
  const refused = async (who: string | "anon" | "server", sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> => {
    await c.query("savepoint attempt");
    try {
      if (who === "anon") await asAnon();
      else if (who === "server") await asServer();
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

  const add = async (org: string, month: string, usd: number, session: string) =>
    (await c.query("select public.add_usage_topup($1::uuid, $2, $3::numeric, $4) as r", [org, month, usd, session])).rows[0].r as { id: string; inserted: boolean };
  const total = async (org: string, month: string) => Number((await c.query("select public.usage_topup_total($1::uuid, $2) as n", [org, month])).rows[0].n);
  const spendFrom = async (org: string, from: string) => Number((await c.query("select public.ai_spend_from($1::uuid, $2::date) as n", [org, from])).rows[0].n);
  const rows = async (org: string) =>
    (await c.query("select month, usage_usd::text as usage_usd, stripe_session_id from public.usage_topups where org_id = $1 order by created_at, stripe_session_id", [org])).rows as {
      month: string;
      usage_usd: string;
      stripe_session_id: string;
    }[];
  /** A ledger row on a given UTC date, as the server writes one through record_ai_usage, then moved to the date asked for. */
  const ledger = async (org: string, usageDate: string, costUsd: number) => {
    await c.query("select public.record_ai_usage($1::uuid, 'test-model', 'test:0401', 10, 0, 0, 10, $2::numeric)", [org, costUsd]);
    // record_ai_usage stamps today (UTC); the test needs rows on either side of the 1st, so the
    // row just written is dated by hand — the server owns the ledger, RLS does not bind it.
    await c.query(
      "update public.ai_usage set usage_date = $2::date where org_id = $1 and surface = 'test:0401' and usage_date = (now() at time zone 'utc')::date and model = 'test-model'",
      [org, usageDate],
    );
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    const have = (await c.query(`select to_regprocedure('${ADD}') is not null as ok`)).rows[0]?.ok === true;
    if (!have) await c.query(M0401); // the table and the three reads as they ship, inside the transaction that is rolled back
    // Twice-safe, proven: the file runs again on top of itself (on CI, where the rebuild already
    // applied it, this is the second run), and its own self-check must still pass.
    await c.query(M0401);
    const org = await mintThrowawayOrg(c, { label: "0401 usage Larkspur", techs: 0 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    const other = await mintThrowawayOrg(c, { label: "0401 usage Snowbell", techs: 0 });
    otherOrgId = other.orgId;
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the table, its policy and the grants are on the database", async () => {
    const cols = (
      await c.query(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'usage_topups' order by ordinal_position`,
      )
    ).rows;
    expect(cols).toEqual([
      { column_name: "id", is_nullable: "NO" },
      { column_name: "org_id", is_nullable: "NO" },
      { column_name: "month", is_nullable: "NO" },
      { column_name: "usage_usd", is_nullable: "NO" },
      { column_name: "stripe_session_id", is_nullable: "NO" },
      { column_name: "created_at", is_nullable: "NO" },
    ]);
    const policies = (await c.query("select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'usage_topups'")).rows;
    expect(policies).toEqual([{ policyname: "usage_topups_deny_all", cmd: "ALL", qual: "false", with_check: "false" }]);
    expect((await c.query("select relrowsecurity from pg_class where oid = 'public.usage_topups'::regclass")).rows[0].relrowsecurity).toBe(true);
    const grants = (
      await c.query(
        `select has_function_privilege('anon', '${ADD}', 'execute') as add_anon,
                has_function_privilege('authenticated', '${ADD}', 'execute') as add_authed,
                has_function_privilege('service_role', '${ADD}', 'execute') as add_service,
                has_function_privilege('anon', '${TOTAL}', 'execute') as total_anon,
                has_function_privilege('authenticated', '${TOTAL}', 'execute') as total_authed,
                has_function_privilege('service_role', '${TOTAL}', 'execute') as total_service,
                has_function_privilege('anon', '${FROM}', 'execute') as from_anon,
                has_function_privilege('authenticated', '${FROM}', 'execute') as from_authed,
                has_function_privilege('service_role', '${FROM}', 'execute') as from_service`,
      )
    ).rows[0];
    expect(grants).toEqual({
      add_anon: false,
      add_authed: false,
      add_service: true,
      total_anon: false,
      total_authed: false,
      total_service: true,
      from_anon: false,
      from_authed: false,
      from_service: true,
    });
    // The rolling read (0162) is still there beside the calendar one.
    expect((await c.query("select to_regprocedure('public.ai_spend_since(uuid,integer)') is not null as ok")).rows[0].ok).toBe(true);
  });

  it("add_usage_topup: once per session — the second delivery answers inserted=false with the same id and no second row", async () => {
    const first = await add(orgId, "2026-11", 10, SESSION_1);
    expect(first.inserted).toBe(true);
    expect(typeof first.id).toBe("string");
    const again = await add(orgId, "2026-11", 10, SESSION_1);
    expect(again).toEqual({ id: first.id, inserted: false });
    // Even with a different amount or month on the replay: the session is the identity.
    const replay = await add(orgId, "2026-12", 99, SESSION_1);
    expect(replay).toEqual({ id: first.id, inserted: false });
    expect(await rows(orgId)).toEqual([{ month: "2026-11", usage_usd: "10.000000", stripe_session_id: SESSION_1 }]);
    // A second session lands as its own row; a padded session id is trimmed to the same identity.
    const second = await add(orgId, "2026-11", 5.5, `  ${SESSION_2}  `);
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect((await add(orgId, "2026-11", 5.5, SESSION_2)).inserted).toBe(false);
    expect((await rows(orgId)).map((r) => r.stripe_session_id)).toEqual([SESSION_1, SESSION_2]);
  });

  it("add_usage_topup: a blank session, a bad month, nothing added and an unknown company are refused in words, nothing written", async () => {
    const before = await rows(orgId);
    for (const [args, message] of [
      [[orgId, "2026-11", 10, ""], "A usage top-up needs its checkout session."],
      [[orgId, "2026-11", 10, "   "], "A usage top-up needs its checkout session."],
      [[orgId, "2026-13", 10, "sess-larkspur-bad-month"], "A usage top-up needs its month as YYYY-MM."],
      [[orgId, "November", 10, "sess-larkspur-bad-month"], "A usage top-up needs its month as YYYY-MM."],
      [[orgId, "2026-11-01", 10, "sess-larkspur-bad-month"], "A usage top-up needs its month as YYYY-MM."],
      [[orgId, "2026-11", 0, "sess-larkspur-zero"], "A usage top-up must add something."],
      [[orgId, "2026-11", -3, "sess-larkspur-zero"], "A usage top-up must add something."],
      [[randomUUID(), "2026-11", 10, "sess-nobody-1"], "No such company for a usage top-up."],
    ] as [unknown[], string][]) {
      const r = await refused("server", "select public.add_usage_topup($1::uuid, $2, $3::numeric, $4)", args);
      expect(r, JSON.stringify(args)).toMatchObject({ code: "22023", message });
    }
    expect(await rows(orgId)).toEqual(before);
  });

  it("usage_topup_total: one company's one month only; another month and another company are not in it; 0 when none", async () => {
    expect(await total(orgId, "2026-11")).toBe(15.5);
    expect(await add(orgId, "2026-12", 20, "sess-larkspur-dec")).toMatchObject({ inserted: true });
    expect(await add(otherOrgId, "2026-11", 30, SESSION_OTHER)).toMatchObject({ inserted: true });
    expect(await total(orgId, "2026-11")).toBe(15.5);
    expect(await total(orgId, "2026-12")).toBe(20);
    expect(await total(orgId, "2026-10")).toBe(0);
    expect(await total(otherOrgId, "2026-11")).toBe(30);
    expect(await total(randomUUID(), "2026-11")).toBe(0);
  });

  it("ai_spend_from: the ledger from the date given — rows before it are out, rows on and after are in, another company's never count", async () => {
    await ledger(orgId, "2026-10-31", 2.25); // the last day of the month before
    await ledger(orgId, "2026-11-01", 1.5); // the 1st: in
    await ledger(orgId, "2026-11-15", 0.75); // mid-month: in
    await ledger(otherOrgId, "2026-11-02", 40); // another company's November
    expect(await spendFrom(orgId, "2026-11-01")).toBeCloseTo(2.25, 6);
    expect(await spendFrom(orgId, "2026-10-01")).toBeCloseTo(4.5, 6);
    expect(await spendFrom(orgId, "2026-11-02")).toBeCloseTo(0.75, 6);
    expect(await spendFrom(orgId, "2026-12-01")).toBe(0);
    expect(await spendFrom(otherOrgId, "2026-11-01")).toBeCloseTo(40, 6);
    expect(await spendFrom(randomUUID(), "2026-01-01")).toBe(0);
    // The rolling read agrees on what it can see (everything here is within 30 days of today only
    // if today is near these dates, so the two are compared on a window that holds them all).
    expect(await spendFrom(orgId, "2000-01-01")).toBeCloseTo(4.5, 6);
  });

  it("anon and a signed-in person get 42501 on all three, see zero rows where the server sees three, and cannot insert", async () => {
    for (const who of [ownerId, "anon"]) {
      const a = await refused(who, "select public.add_usage_topup($1::uuid, '2026-11', 10, 'sess-larkspur-stranger')", [orgId]);
      expect(a?.code, `${who} add`).toBe("42501");
      const t = await refused(who, "select public.usage_topup_total($1::uuid, '2026-11')", [orgId]);
      expect(t?.code, `${who} total`).toBe("42501");
      const f = await refused(who, "select public.ai_spend_from($1::uuid, '2026-11-01'::date)", [orgId]);
      expect(f?.code, `${who} from`).toBe("42501");
    }
    // The table itself: the deny-all hides every row from a signed-in person and from anon (zero
    // rows where the server sees three), or the role has no SELECT on it at all — either is nothing.
    expect((await rows(orgId)).length).toBe(3);
    for (const who of [ownerId, "anon"]) {
      await c.query("savepoint peek");
      try {
        if (who === "anon") await asAnon();
        else await as(who);
        const seen = await c.query("select count(*)::int as n from public.usage_topups where org_id = $1", [orgId]);
        expect(seen.rows[0].n, `${who} select`).toBe(0);
      } catch (e) {
        expect((e as { code?: string }).code, `${who} select`).toBe("42501");
      } finally {
        await c.query("rollback to savepoint peek");
        await asServer();
      }
      const ins = await refused(who, "insert into public.usage_topups (org_id, month, usage_usd, stripe_session_id) values ($1, '2026-11', 10, 'sess-larkspur-by-hand')", [orgId]);
      expect(ins?.code, `${who} insert`).toBe("42501");
    }
    // Nothing moved.
    expect((await rows(orgId)).map((r) => r.stripe_session_id)).toEqual([SESSION_1, SESSION_2, "sess-larkspur-dec"]);
  });
});
