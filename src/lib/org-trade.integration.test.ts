import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * THE OWNER CAN CHANGE THE COMPANY'S TRADE (0398, cn-v1135), where the boundary lives: the database.
 *
 *   · only the owner moves settings.trade, through set_org_trade: the key lands, {previous, trade}
 *     comes back, nothing else in settings moves, and one audit row says so;
 *   · blank clears the key ("Other / Not Listed");
 *   · an office, admin or tech seat is refused in words, and nothing moves;
 *   · anon has no execute privilege; the function is security definer with its search_path pinned;
 *   · the pin still stands: the owner's own direct PATCH of the key (not through the RPC) is carried
 *     through unchanged, so set_org_trade is the one door;
 *   · a word that is not one of the app's trades is refused in words.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company
 * (lib/throwaway-org.db-fixture), with 0398 applied inside it (the file on this branch, so what is
 * asserted is what ships; create or replace is idempotent on a database that already has it). Each
 * seat is played the way PostgREST plays it: request.jwt.claims under `set local role authenticated`;
 * refusals run inside savepoints so the transaction lives on. The harness is
 * feature-switches.integration.test's.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith(prefix))!), "utf8");
const M0398 = migration("0398_");

/** 0398's words. */
const OWNER_WORDS = "Only the owner can change the company's trade.";

d("the owner can change the company's trade (0398)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let officeId = "";
  let adminId = "";
  let techId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** PostgREST's own mechanism: the person's claims under the authenticated role. */
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run as `uid`; the error message if refused, else null. Always back to the server after. */
  const tryAs = async (uid: string, sql: string, params: unknown[] = []): Promise<{ error: string | null; rows: any[] }> => {
    await c.query("savepoint tryas");
    try {
      await as(uid);
      const r = await c.query(sql, params);
      await c.query("release savepoint tryas");
      return { error: null, rows: r.rows };
    } catch (e: any) {
      await c.query("rollback to savepoint tryas");
      return { error: String(e.message), rows: [] };
    } finally {
      await asServer();
    }
  };
  const settingsOf = async (org: string) => (await one("select settings from organizations where id = $1", [org])).settings as Record<string, any>;
  const auditRows = async () =>
    (await c.query("select user_id, action, ok, input_summary, source from agent_audit_log where org_id = $1 and action = 'trade.set' order by created_at", [orgId])).rows;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    const org = await mintThrowawayOrg(c, { label: "0398 trade", techs: 3 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    techId = org.techs[2].id;
    // An office seat and an admin seat, promoted by the owner (0225: only an owner or admin changes roles).
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
    officeId = org.techs[0].id;
    adminId = org.techs[1].id;
    const office = (await c.query("update public.profiles set role = 'office' where id = $1 and org_id = $2 returning role::text as role", [officeId, orgId])).rows[0];
    const admin = (await c.query("update public.profiles set role = 'admin' where id = $1 and org_id = $2 returning role::text as role", [adminId, orgId])).rows[0];
    await asServer();
    if (office?.role !== "office" || admin?.role !== "admin") throw new Error("0398 test: the office and admin seats did not land.");
    // A company with no trade yet, its own words, a switch stored and the old checkbox: everything
    // beside the key must come through every write untouched.
    await c.query(
      `update organizations set settings = '{"trade_label": "TEST handyman", "service_area": "before", "features": {"panel_map": false}, "timeclock_job_codes": false}'::jsonb where id = $1`,
      [orgId],
    );
    await c.query(M0398); // the writer as it ships
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the owner's call lands: the key is stored, previous and trade come back, nothing else moves, one audit row says so", async () => {
    const r = await tryAs(ownerId, "select public.set_org_trade('deck') as r");
    expect(r.error).toBeNull();
    expect(r.rows[0].r).toEqual({ previous: null, trade: "deck" });
    const s = await settingsOf(orgId);
    expect(s.trade).toBe("deck");
    expect(s.trade_label).toBe("TEST handyman"); // the words are the app's to keep or clear, never this function's
    expect(s.service_area).toBe("before");
    expect(s.features).toEqual({ panel_map: false });
    expect(s.timeclock_job_codes).toBe(false);
    expect(await auditRows()).toEqual([{ user_id: ownerId, action: "trade.set", ok: true, input_summary: { from: null, to: "deck" }, source: "ui" }]);

    // A second change says what it replaced.
    const again = await tryAs(ownerId, "select public.set_org_trade('plumbing') as r");
    expect(again.error).toBeNull();
    expect(again.rows[0].r).toEqual({ previous: "deck", trade: "plumbing" });
    expect((await settingsOf(orgId)).trade).toBe("plumbing");
    expect(await auditRows()).toHaveLength(2);
  });

  it("blank clears the key (Other / Not Listed); so does nothing at all", async () => {
    const r = await tryAs(ownerId, "select public.set_org_trade('') as r");
    expect(r.error).toBeNull();
    expect(r.rows[0].r).toEqual({ previous: "plumbing", trade: null });
    const s = await settingsOf(orgId);
    expect(s.trade).toBeUndefined();
    expect(s.service_area).toBe("before");
    const nothing = await tryAs(ownerId, "select public.set_org_trade(null) as r");
    expect(nothing.error).toBeNull();
    expect(nothing.rows[0].r).toEqual({ previous: null, trade: null });
    // Back to a trade for the cases below.
    expect((await tryAs(ownerId, "select public.set_org_trade('roofing') as r")).rows[0].r).toEqual({ previous: null, trade: "roofing" });
  });

  it("an office, admin or tech seat is refused in the owner words, and nothing moves", async () => {
    const before = await settingsOf(orgId);
    const audits = (await auditRows()).length;
    for (const uid of [officeId, adminId, techId]) {
      const r = await tryAs(uid, "select public.set_org_trade('deck')");
      expect(r.error, uid).toBe(OWNER_WORDS);
    }
    expect(await settingsOf(orgId)).toEqual(before);
    expect(await auditRows()).toHaveLength(audits);
  });

  it("anon has no execute privilege; a signed-in person does; the function is security definer with its search_path pinned", async () => {
    const grants = await one(
      "select has_function_privilege('anon', 'public.set_org_trade(text)', 'execute') as anon, has_function_privilege('authenticated', 'public.set_org_trade(text)', 'execute') as authed",
    );
    expect(grants).toEqual({ anon: false, authed: true });
    const shape = await one("select prosecdef, proconfig from pg_proc where oid = 'public.set_org_trade(text)'::regprocedure");
    expect(shape.prosecdef).toBe(true);
    expect(shape.proconfig).toContain("search_path=public");
  });

  it("the pin stands: the owner's own direct PATCH of the key, not through the RPC, is carried through unchanged", async () => {
    const before = await settingsOf(orgId);
    expect(before.trade).toBe("roofing");
    const r = await tryAs(ownerId, `update organizations set settings = jsonb_set(settings, '{trade}', '"deck"') where id = $1 returning id`, [orgId]);
    expect(r.error).toBeNull();
    expect(r.rows).toHaveLength(1); // the write happened (0181 lets the owner save settings) …
    expect((await settingsOf(orgId)).trade).toBe("roofing"); // … and the pin kept the key
    // Removing the key by hand is not a way around it either.
    await tryAs(ownerId, "update organizations set settings = settings - 'trade' where id = $1", [orgId]);
    expect(await settingsOf(orgId)).toEqual(before);
  });

  it("a word that is not one of the app's trades is refused in words", async () => {
    const before = await settingsOf(orgId);
    expect((await tryAs(ownerId, "select public.set_org_trade('solar')")).error).toBe('There is no trade called "solar".');
    expect((await tryAs(ownerId, "select public.set_org_trade('Deck')")).error).toBe('There is no trade called "Deck".');
    expect(await settingsOf(orgId)).toEqual(before);
  });
});
