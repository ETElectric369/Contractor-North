import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import pg from "pg";
import { codeMatches, hashCode, hashSecret, newSalt, newSessionSecret } from "./portal/code";

/**
 * Migration 0331: the portal link asks for a code.
 *
 * ONE connection, BEGIN before anything, ROLLBACK at the end: nothing here can outlive the run (and
 * lock_timeout / statement_timeout are set inside it, so a busy live table makes this fail fast
 * instead of waiting on it). It borrows an active tech and an active office member of one org (and
 * an office member of another org when there is one) and makes its own customers, named TEST 0331.
 * When 0331 is not on the database yet, the file itself is run INSIDE the same transaction (a
 * practice run) and rolled back with everything else; once it is applied, the database's own
 * functions are tested as they are.
 *
 * Speaks as anon / a tech / office staff the way PostgREST does (request.jwt.claims +
 * `set local role`), and as the server (the service role's side of the door) on the direct
 * connection. Read-back is the assertion, never the absence of an error.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run src/lib/portal-code.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = path.join(__dirname, "../../supabase/migrations/0331_the_portal_asks_for_a_code.sql");

d("the portal link asks for a code (0331)", { timeout: 30_000 }, () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let orgName = "";
  let techId = "";
  let staffId = "";
  let otherStaffId = "";
  let otherOrgId = "";
  let custA = "";
  let custB = "";
  let custNoEmail = "";
  let custOther = ""; // a customer in ANOTHER org, when there is one

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asAnon = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run fn in a savepoint; the SQLSTATE it was refused with, or null when it went through (then undone). */
  const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return String((e as { code?: string }).code ?? (e as Error).message);
    } finally {
      await asServer();
    }
  };
  /** Run fn as someone, keep what it returned, undo nothing (the outer transaction rolls back). */
  const asWho = async <T,>(who: () => Promise<void>, fn: () => Promise<T>): Promise<T> => {
    await who();
    try {
      return await fn();
    } finally {
      await asServer();
    }
  };
  const needs = () => {
    if (!ready) console.warn("[portal-code] 0298 is not on this database; nothing to test.");
    return ready;
  };
  const tokenOf = async (id: string) => (await one("select token from public.customer_portal_access where customer_id = $1", [id])).token as string;
  const gate = async (token: string) => (await one("select public.portal_gate($1) as j", [token])).j;
  const issue = async (token: string, code: string, channel = "email") => {
    const salt = newSalt();
    const j = (await one("select public.portal_code_issue($1, $2, $3, $4) as j", [token, channel, salt, hashCode(code, salt)])).j;
    return { j, salt };
  };
  const tryCode = async (token: string) => (await one("select public.portal_code_try($1) as j", [token])).j;
  const redeem = async (token: string, codeId: string, code: string, salt: string, secret: string) =>
    (await one("select public.portal_code_redeem($1, $2, $3, $4) as ok", [token, codeId, hashCode(code, salt), hashSecret(secret)])).ok as boolean;
  /** The whole customer flow: send, try, compare in constant time, redeem. Returns the cookie's secret. */
  const signIn = async (token: string, code = "314159"): Promise<string> => {
    const { j, salt } = await issue(token, code);
    expect(j.ok).toBe(true);
    const t = await tryCode(token);
    expect(t.state).toBe("check");
    expect(codeMatches(code, t.salt, t.hash)).toBe(true);
    const secret = newSessionSecret();
    expect(await redeem(token, t.code_id, code, salt, secret)).toBe(true);
    return secret;
  };
  const check = async (token: string, secret: string) =>
    (await one("select public.portal_session_check($1, $2) as j", [token, hashSecret(secret)])).j;
  const sessions = async (customerId: string, kind?: string) =>
    Number(
      (await one("select count(*)::int as n from public.customer_portal_sessions where customer_id = $1 and ($2::text is null or kind = $2)", [customerId, kind ?? null])).n,
    );
  const liveCodes = async (customerId: string) =>
    Number(
      (await one("select count(*)::int as n from public.customer_portal_codes where customer_id = $1 and consumed_at is null and superseded_at is null", [customerId])).n,
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    if (!(await one("select to_regclass('public.customer_portal_access') is not null as ok")).ok) return;
    if (!(await one("select to_regclass('public.customer_portal_codes') is not null as ok")).ok) {
      // 0331 not applied yet: practice-run it inside this transaction (rolled back in afterAll).
      await c.query(fs.readFileSync(MIGRATION, "utf8"));
    }
    ready = true;

    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id, o.name as org_name
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and coalesce(s.active, true)
         join public.organizations o on o.id = t.org_id
        where t.role = 'tech' and coalesce(t.active, true)
        limit 1`,
    );
    if (!fx) throw new Error("0331 test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    orgName = fx.org_name;
    techId = fx.tech_id;
    staffId = fx.staff_id;
    const other = await one(
      "select id, org_id from public.profiles where org_id <> $1 and role in ('owner','admin','office') and coalesce(active, true) limit 1",
      [orgId],
    );
    otherStaffId = other?.id ?? "";
    otherOrgId = other?.org_id ?? "";

    const cust = async (org: string, name: string, email: string | null) =>
      (await one("insert into public.customers (org_id, name, email) values ($1, $2, $3) returning id", [org, name, email])).id as string;
    custA = await cust(orgId, "TEST 0331 A", "test0331-a@example.com");
    custB = await cust(orgId, "TEST 0331 B", "test0331-b@example.com");
    custNoEmail = await cust(orgId, "TEST 0331 no email", "  ");
    if (otherOrgId) custOther = await cust(otherOrgId, "TEST 0331 other org", "test0331-o@example.com");
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("anon can run none of it; a signed-in member can't run the portal's side or read the tables", async () => {
    if (!needs()) return;
    const token = await tokenOf(custA);
    const h = "0".repeat(64);
    const serverSide: [string, unknown[]][] = [
      ["select public.portal_gate($1)", [token]],
      ["select public.portal_session_check($1, $2)", [token, h]],
      ["select public.portal_code_issue($1, 'email', $2, $3)", [token, "0".repeat(32), h]],
      ["select public.portal_code_try($1)", [token]],
      ["select public.portal_code_redeem($1, gen_random_uuid(), $2, $3)", [token, h, h]],
      ["select public.portal_code_void($1, gen_random_uuid())", [token]],
      ["select public.portal_session_end($1, $2)", [token, h]],
      ["select public.portal_preview_redeem($1, $2, $3)", [token, h, h]],
    ];
    const officeSide: [string, unknown[]][] = [
      ["select public.portal_link_devices($1)", [custA]],
      ["select public.portal_sessions_end_all($1)", [custA]],
      ["select public.portal_preview_ticket($1, $2)", [custA, h]],
    ];
    for (const [sql, args] of [...serverSide, ...officeSide]) {
      expect(await refused(async () => { await asAnon(); await c.query(sql, args); }), `anon: ${sql}`).toBe("42501");
    }
    for (const [sql, args] of serverSide) {
      for (const uid of [staffId, techId]) {
        expect(await refused(async () => { await as(uid); await c.query(sql, args); }), `member: ${sql}`).toBe("42501");
      }
    }
    for (const t of ["customer_portal_codes", "customer_portal_sessions", "customer_portal_preview_tickets"]) {
      for (const who of [() => asAnon(), () => as(staffId), () => as(techId)]) {
        expect(await refused(async () => { await who(); await c.query(`select 1 from public.${t} limit 1`); }), t).toBe("42501");
      }
    }
  });

  it("the sign-in screen's read: the business and the address on file, and nothing for a link that isn't one", async () => {
    if (!needs()) return;
    const g = await gate(await tokenOf(custA));
    expect(g.org.name).toBe(orgName);
    expect(g.email).toBe("test0331-a@example.com");
    expect(Object.keys(g).sort()).toEqual(["email", "live_code_sent_at", "org"]);
    expect(g.live_code_sent_at).toBeNull();
    expect((await gate(await tokenOf(custNoEmail))).email).toBeNull();
    expect(await gate("0".repeat(32))).toBeNull();
    expect(await gate("short")).toBeNull();
  });

  it("issue: to the email on file only, hashes only, one live code per link", async () => {
    if (!needs()) return;
    await c.query("savepoint s_issue");
    const token = await tokenOf(custA);
    const { j, salt } = await issue(token, "271828");
    expect(j.ok).toBe(true);
    expect(j.to).toBe("test0331-a@example.com");
    expect(j.org.name).toBe(orgName);
    const row = await one("select * from public.customer_portal_codes where id = $1", [j.code_id]);
    expect(row.code_salt).toBe(salt);
    expect(row.code_hash).toBe(hashCode("271828", salt));
    expect(JSON.stringify(row)).not.toContain("271828");
    const minutes = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 60_000;
    expect(minutes).toBeCloseTo(10, 5);

    const second = await issue(token, "161803");
    expect(second.j.ok).toBe(true);
    expect(await liveCodes(custA)).toBe(1);
    const first = await one("select superseded_at from public.customer_portal_codes where id = $1", [j.code_id]);
    expect(first.superseded_at).not.toBeNull();
    await c.query("rollback to savepoint s_issue");
  });

  it("issue refuses out loud: no email, texting not live, a malformed hash, a dead link", async () => {
    if (!needs()) return;
    expect((await issue(await tokenOf(custNoEmail), "111111")).j).toEqual({ ok: false, reason: "no_email" });
    expect((await issue(await tokenOf(custA), "111111", "sms")).j).toEqual({ ok: false, reason: "channel_unavailable" });
    expect((await issue("0".repeat(32), "111111")).j).toEqual({ ok: false, reason: "no_link" });
    expect(
      await refused(() => c.query("select public.portal_code_issue($1, 'email', 'nothex', $2)", ["a".repeat(32), "0".repeat(64)])),
    ).toBe("22023");
  });

  it("rate limit: 3 sends per link per 15 minutes, then 'too_many' with when to try again", async () => {
    if (!needs()) return;
    await c.query("savepoint s_rate");
    const token = await tokenOf(custB);
    for (let i = 0; i < 3; i++) expect((await issue(token, "123456")).j.ok).toBe(true);
    const fourth = (await issue(token, "123456")).j;
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe("too_many");
    expect(new Date(fourth.retry_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // The window passes: sends again.
    await c.query("update public.customer_portal_codes set created_at = created_at - interval '16 minutes' where customer_id = $1", [custB]);
    expect((await issue(token, "123456")).j.ok).toBe(true);
    await c.query("rollback to savepoint s_rate");
  });

  it("the right code signs the device in: a session by hash, checked, Last Opened stamped, 30 days", async () => {
    if (!needs()) return;
    await c.query("savepoint s_in");
    const token = await tokenOf(custA);
    await c.query("update public.customer_portal_access set last_opened_at = null where customer_id = $1", [custA]);
    const secret = await signIn(token);
    const s = await one("select * from public.customer_portal_sessions where customer_id = $1", [custA]);
    expect(s.session_hash).toBe(hashSecret(secret));
    expect(s.kind).toBe("customer");
    const days = (new Date(s.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(await check(token, secret)).toEqual({ kind: "customer" });
    expect((await one("select last_opened_at from public.customer_portal_access where customer_id = $1", [custA])).last_opened_at).not.toBeNull();
    // The code is spent: it can't sign in a second device.
    expect(await liveCodes(custA)).toBe(0);
    expect((await tryCode(token)).state).toBe("no_code");
    // A made-up session is nothing.
    expect(await check(token, newSessionSecret())).toBeNull();
    await c.query("rollback to savepoint s_in");
  });

  it("5 wrong tries, then the code is used up and a fresh one is needed (and works)", async () => {
    if (!needs()) return;
    await c.query("savepoint s_tries");
    const token = await tokenOf(custA);
    const { j, salt } = await issue(token, "999999");
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await tryCode(token);
      expect(t.state).toBe("check");
      expect(codeMatches("000000", t.salt, t.hash)).toBe(false);
      left.push(t.tries_left);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect((await tryCode(token)).state).toBe("used_up");
    expect((await one("select attempts from public.customer_portal_codes where id = $1", [j.code_id])).attempts).toBe(5);
    void salt;
    const secret = await signIn(token, "424242");
    expect(await check(token, secret)).toEqual({ kind: "customer" });
    await c.query("rollback to savepoint s_tries");
  });

  it("a code older than 10 minutes is expired: no try, no sign-in", async () => {
    if (!needs()) return;
    await c.query("savepoint s_exp");
    const token = await tokenOf(custA);
    const { j, salt } = await issue(token, "555555");
    const t = await tryCode(token);
    await c.query("update public.customer_portal_codes set expires_at = now() - interval '1 second' where id = $1", [j.code_id]);
    expect((await tryCode(token)).state).toBe("expired");
    expect(await redeem(token, t.code_id, "555555", salt, newSessionSecret())).toBe(false);
    expect(await sessions(custA)).toBe(0);
    await c.query("rollback to savepoint s_exp");
  });

  it("redeem checks the hash itself: a caller that skipped the comparison gets nowhere", async () => {
    if (!needs()) return;
    await c.query("savepoint s_hash");
    const token = await tokenOf(custA);
    await issue(token, "777777");
    const t = await tryCode(token);
    expect(await redeem(token, t.code_id, "777778", t.salt, newSessionSecret())).toBe(false);
    expect(await sessions(custA)).toBe(0);
    await c.query("rollback to savepoint s_hash");
  });

  it("cross-customer: A's code can't be spent on B's link, and A's session opens nothing on B's", async () => {
    if (!needs()) return;
    await c.query("savepoint s_cross");
    const a = await tokenOf(custA);
    const b = await tokenOf(custB);
    const { salt } = await issue(a, "808080");
    const t = await tryCode(a);
    expect(await redeem(b, t.code_id, "808080", salt, newSessionSecret())).toBe(false);
    expect(await sessions(custB)).toBe(0);
    const secret = newSessionSecret();
    expect(await redeem(a, t.code_id, "808080", salt, secret)).toBe(true);
    expect(await check(a, secret)).toEqual({ kind: "customer" });
    expect(await check(b, secret)).toBeNull();
    await c.query("rollback to savepoint s_cross");
  });

  it("cross-org: another org's session opens nothing here, and another org's office can't see or touch it", async () => {
    if (!needs()) return;
    if (!otherStaffId || !custOther) {
      console.warn("[portal-code] a one-org database has no neighbour to test against.");
      return;
    }
    await c.query("savepoint s_org");
    const mine = await tokenOf(custA);
    const theirs = await tokenOf(custOther);
    const theirSecret = await signIn(theirs, "123123");
    expect(await check(theirs, theirSecret)).toEqual({ kind: "customer" });
    expect(await check(mine, theirSecret)).toBeNull();
    for (const sql of [
      "select public.portal_link_devices($1)",
      "select public.portal_sessions_end_all($1)",
      `select public.portal_preview_ticket($1, '${"0".repeat(64)}')`,
    ]) {
      expect(await refused(async () => { await as(otherStaffId); await c.query(sql, [custA]); }), sql).toBe("P0002");
    }
    await c.query("rollback to savepoint s_org");
  });

  it("New Link ends every session and live code at once; the new link asks for a code", async () => {
    if (!needs()) return;
    await c.query("savepoint s_rotate");
    const old = await tokenOf(custA);
    const phone = await signIn(old, "111222");
    await issue(old, "333444"); // a code mid-sign-in on another device
    expect(await sessions(custA)).toBe(1);
    expect(await liveCodes(custA)).toBe(1);
    const fresh = await asWho(() => as(staffId), async () => (await one("select public.portal_link_rotate($1) as t", [custA])).t as string);
    expect(fresh).not.toBe(old);
    expect(await sessions(custA)).toBe(0);
    expect(await liveCodes(custA)).toBe(0);
    expect(await check(old, phone)).toBeNull();
    expect(await check(fresh, phone)).toBeNull();
    expect((await gate(old)).disabled).toBe(true);
    expect((await gate(fresh)).org.name).toBe(orgName);
    await c.query("rollback to savepoint s_rotate");
  });

  it("Turn Off ends every session; Turn On brings the link back, not the sessions", async () => {
    if (!needs()) return;
    await c.query("savepoint s_off");
    const token = await tokenOf(custA);
    const phone = await signIn(token, "565656");
    await asWho(() => as(staffId), () => c.query("select public.portal_link_set_enabled($1, false)", [custA]));
    expect(await sessions(custA)).toBe(0);
    expect(await check(token, phone)).toBeNull();
    expect((await gate(token)).disabled).toBe(true);
    expect((await issue(token, "121212")).j).toEqual({ ok: false, reason: "no_link" });
    await asWho(() => as(staffId), () => c.query("select public.portal_link_set_enabled($1, true)", [custA]));
    expect(await check(token, phone)).toBeNull();
    expect((await gate(token)).email).toBe("test0331-a@example.com");
    await c.query("rollback to savepoint s_off");
  });

  it("the office card: devices counted (office looks not), Sign Out All Devices, and a tech can do neither", async () => {
    if (!needs()) return;
    await c.query("savepoint s_devices");
    const token = await tokenOf(custA);
    await signIn(token, "101010");
    await signIn(token, "202020");
    await c.query(
      "insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, expires_at) values ($1, $2, $3, 'office', now() + interval '8 hours')",
      [custA, orgId, hashSecret(newSessionSecret())],
    );
    const dev = await asWho(() => as(staffId), async () => (await one("select public.portal_link_devices($1) as j", [custA])).j);
    expect(dev.devices).toBe(2);
    expect(dev.last_seen_at).not.toBeNull();
    expect(await refused(async () => { await as(techId); await c.query("select public.portal_link_devices($1)", [custA]); })).toBe("42501");
    expect(await refused(async () => { await as(techId); await c.query("select public.portal_sessions_end_all($1)", [custA]); })).toBe("42501");
    expect(await sessions(custA)).toBe(3);

    const ended = await asWho(() => as(staffId), async () => (await one("select public.portal_sessions_end_all($1) as n", [custA])).n);
    expect(ended).toBe(2);
    expect(await sessions(custA)).toBe(0);
    // The link itself keeps working: the next device just needs a code.
    expect((await gate(token)).org.name).toBe(orgName);
    await c.query("rollback to savepoint s_devices");
  });

  it("the session slides: a visit after a minute pushes the end to 30 days out; an ended one opens nothing", async () => {
    if (!needs()) return;
    await c.query("savepoint s_slide");
    const token = await tokenOf(custA);
    const secret = await signIn(token, "343434");
    await c.query(
      "update public.customer_portal_sessions set last_seen_at = now() - interval '2 days', expires_at = now() + interval '28 days' where customer_id = $1",
      [custA],
    );
    expect(await check(token, secret)).toEqual({ kind: "customer" });
    const s = await one("select expires_at from public.customer_portal_sessions where customer_id = $1", [custA]);
    expect((new Date(s.expires_at).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(29.9);
    await c.query("update public.customer_portal_sessions set expires_at = now() - interval '1 second' where customer_id = $1", [custA]);
    expect(await check(token, secret)).toBeNull();
    await c.query("rollback to savepoint s_slide");
  });

  it("Sign Out On This Device ends only this device", async () => {
    if (!needs()) return;
    await c.query("savepoint s_signout");
    const token = await tokenOf(custA);
    const phone = await signIn(token, "454545");
    const laptop = await signIn(token, "565656");
    expect((await one("select public.portal_session_end($1, $2) as ok", [token, hashSecret(phone)])).ok).toBe(true);
    expect(await check(token, phone)).toBeNull();
    expect(await check(token, laptop)).toEqual({ kind: "customer" });
    // Another link's token can't end this customer's session.
    expect((await one("select public.portal_session_end($1, $2) as ok", [await tokenOf(custB), hashSecret(laptop)])).ok).toBe(false);
    await c.query("rollback to savepoint s_signout");
  });

  it("See What They See: a one-use, two-minute ticket for an office session on that link only, never counted, never stamping", async () => {
    if (!needs()) return;
    await c.query("savepoint s_look");
    const token = await tokenOf(custA);
    await c.query("update public.customer_portal_access set last_opened_at = null where customer_id = $1", [custA]);
    const ticket = newSessionSecret();
    const got = await asWho(() => as(staffId), async () => (await one("select public.portal_preview_ticket($1, $2) as t", [custA, hashSecret(ticket)])).t);
    expect(got).toBe(token);
    expect(await refused(async () => { await as(techId); await c.query("select public.portal_preview_ticket($1, $2)", [custA, hashSecret(newSessionSecret())]); })).toBe("42501");

    const redeemLook = async (tok: string, t: string, s: string) =>
      (await one("select public.portal_preview_redeem($1, $2, $3) as ok", [tok, hashSecret(t), hashSecret(s)])).ok as boolean;
    // Not on another customer's link.
    expect(await redeemLook(await tokenOf(custB), ticket, newSessionSecret())).toBe(false);
    const office = newSessionSecret();
    expect(await redeemLook(token, ticket, office)).toBe(true);
    // Spent on first use.
    expect(await redeemLook(token, ticket, newSessionSecret())).toBe(false);
    expect(await check(token, office)).toEqual({ kind: "office" });
    expect((await one("select last_opened_at from public.customer_portal_access where customer_id = $1", [custA])).last_opened_at).toBeNull();
    const s = await one("select kind, started_by, expires_at from public.customer_portal_sessions where customer_id = $1", [custA]);
    expect(s.kind).toBe("office");
    expect(s.started_by).toBe(staffId);
    expect((new Date(s.expires_at).getTime() - Date.now()) / 3_600_000).toBeLessThan(8.1);
    const dev = await asWho(() => as(staffId), async () => (await one("select public.portal_link_devices($1) as j", [custA])).j);
    expect(dev.devices).toBe(0);

    // A ticket past its two minutes opens nothing.
    const late = newSessionSecret();
    await asWho(() => as(staffId), () => c.query("select public.portal_preview_ticket($1, $2)", [custA, hashSecret(late)]));
    await c.query("update public.customer_portal_preview_tickets set expires_at = now() - interval '1 second' where ticket_hash = $1", [hashSecret(late)]);
    expect(await redeemLook(token, late, newSessionSecret())).toBe(false);
    await c.query("rollback to savepoint s_look");
  });

  it("a code already out: the sign-in screen's read says when it went, and nothing once it's spent or used up", async () => {
    if (!needs()) return;
    await c.query("savepoint s_live");
    const token = await tokenOf(custA);
    const { j } = await issue(token, "777777");
    const g = await gate(token);
    expect(new Date(g.live_code_sent_at).getTime()).toBe(new Date((await one("select created_at from public.customer_portal_codes where id = $1", [j.code_id])).created_at).getTime());
    await c.query("update public.customer_portal_codes set attempts = 5 where id = $1", [j.code_id]);
    expect((await gate(token)).live_code_sent_at).toBeNull();
    await c.query("update public.customer_portal_codes set attempts = 0, expires_at = now() - interval '1 second' where id = $1", [j.code_id]);
    expect((await gate(token)).live_code_sent_at).toBeNull();
    // B's code is not A's.
    await issue(await tokenOf(custB), "888888");
    expect((await gate(token)).live_code_sent_at).toBeNull();
    await c.query("rollback to savepoint s_live");
  });

  it("the day's ceiling: 10 codes a link in 24 hours (the 10th says so), then 'day_limit' with when", async () => {
    if (!needs()) return;
    await c.query("savepoint s_day");
    const token = await tokenOf(custB);
    // Nine earlier today, spread past the 15-minute window.
    await c.query(
      `insert into public.customer_portal_codes (customer_id, org_id, code_salt, code_hash, created_at, expires_at, superseded_at)
       select $1, $2, $3, $4, now() - (i * interval '1 hour'), now() - (i * interval '1 hour') + interval '10 minutes', now() - (i * interval '1 hour') + interval '1 minute'
         from generate_series(1, 9) i`,
      [custB, orgId, "0".repeat(32), "0".repeat(64)],
    );
    const tenth = (await issue(token, "123123")).j;
    expect(tenth.ok).toBe(true);
    expect(tenth.left_today).toBe(0);
    expect(tenth.customer_id).toBe(custB);
    await c.query("update public.customer_portal_codes set created_at = created_at - interval '16 minutes' where id = $1", [tenth.code_id]);
    const eleventh = (await issue(token, "123123")).j;
    expect(eleventh).toMatchObject({ ok: false, reason: "day_limit" });
    const hours = (new Date(eleventh.retry_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(14);
    expect(hours).toBeLessThan(15.1);
    // A day on, the oldest are swept and it sends again.
    await c.query("update public.customer_portal_codes set created_at = created_at - interval '1 day' where customer_id = $1", [custB]);
    expect((await issue(token, "123123")).j.ok).toBe(true);
    await c.query("rollback to savepoint s_day");
  });

  it("an email that didn't go out is taken back: it never counts, and the code already in the inbox works again", async () => {
    if (!needs()) return;
    await c.query("savepoint s_void");
    const token = await tokenOf(custA);
    const inbox = await issue(token, "246810");
    const failed = await issue(token, "135791");
    const voidIt = async (tok: string, id: string) => (await one("select public.portal_code_void($1, $2) as ok", [tok, id])).ok as boolean;
    // Not from another customer's link.
    expect(await voidIt(await tokenOf(custB), failed.j.code_id)).toBe(false);
    expect(await voidIt(token, failed.j.code_id)).toBe(true);
    expect((await one("select count(*)::int as n from public.customer_portal_codes where id = $1", [failed.j.code_id])).n).toBe(0);
    expect(await liveCodes(custA)).toBe(1);
    const t = await tryCode(token);
    expect(t.state).toBe("check");
    expect(t.code_id).toBe(inbox.j.code_id);
    expect(codeMatches("246810", t.salt, t.hash)).toBe(true);
    // Twice is nothing, and a code anyone has tried is never taken back.
    expect(await voidIt(token, failed.j.code_id)).toBe(false);
    expect(await voidIt(token, inbox.j.code_id)).toBe(false);
    // It never counted: three more sends fit the window (inbox + 2 = 3, and the voided one isn't there).
    expect((await issue(token, "000001")).j.ok).toBe(true);
    expect((await issue(token, "000002")).j.ok).toBe(true);
    expect((await issue(token, "000003")).j).toMatchObject({ ok: false, reason: "too_many" });
    await c.query("rollback to savepoint s_void");
  });

  it("a changed email signs the customer's devices out and cancels the live code; case and spaces aren't a change", async () => {
    if (!needs()) return;
    await c.query("savepoint s_email");
    const token = await tokenOf(custA);
    const device = await signIn(token, "112233");
    await c.query(
      "insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, started_by, expires_at) values ($1, $2, $3, 'office', $4, now() + interval '8 hours')",
      [custA, orgId, hashSecret(newSessionSecret()), staffId],
    );
    await issue(token, "445566");
    await c.query("update public.customers set email = '  TEST0331-A@example.com ' where id = $1", [custA]);
    expect(await check(token, device)).toEqual({ kind: "customer" });
    expect(await liveCodes(custA)).toBe(1);
    await c.query("update public.customers set email = 'test0331-a-new@example.com' where id = $1", [custA]);
    expect(await check(token, device)).toBeNull();
    expect(await sessions(custA, "customer")).toBe(0);
    expect(await sessions(custA, "office")).toBe(1);
    expect(await liveCodes(custA)).toBe(0);
    // B untouched.
    const other = await signIn(await tokenOf(custB), "778899");
    await c.query("update public.customers set email = 'test0331-a-newer@example.com' where id = $1", [custA]);
    expect(await check(await tokenOf(custB), other)).toEqual({ kind: "customer" });
    await c.query("rollback to savepoint s_email");
  });

  it("an office look ends when its staff member is deactivated or no longer office staff (0158)", async () => {
    if (!needs()) return;
    /** Flip a staff row's `active` the way our server's offboarding does (the service role gets past
     *  0225's owner-seat guard); only ever inside an inner savepoint that is undone at once. */
    const setActive = async (id: string, active: boolean) => {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      try {
        await c.query("update public.profiles set active = $2 where id = $1", [id, active]);
      } finally {
        await asServer();
      }
    };
    await c.query("savepoint s_staff");
    const token = await tokenOf(custA);
    const look = newSessionSecret();
    const add = (secret: string, by: string | null) =>
      c.query(
        "insert into public.customer_portal_sessions (customer_id, org_id, session_hash, kind, started_by, expires_at) values ($1, $2, $3, 'office', $4, now() + interval '8 hours')",
        [custA, orgId, hashSecret(secret), by],
      );
    await add(look, staffId);
    expect(await check(token, look)).toEqual({ kind: "office" });
    // A real staff row: touched only inside an inner savepoint, undone at once, so its row lock is
    // held for milliseconds, never for the rest of the run.
    await c.query("savepoint s_staff_row");
    try {
      await setActive(staffId, false);
      expect(await check(token, look)).toBeNull();
      expect((await one("select count(*)::int as n from public.customer_portal_sessions where session_hash = $1", [hashSecret(look)])).n).toBe(0);
      await setActive(staffId, true);
      // Gone for good, not back on reactivation.
      expect(await check(token, look)).toBeNull();
    } finally {
      await c.query("rollback to savepoint s_staff_row");
    }

    const techLook = newSessionSecret();
    await add(techLook, techId);
    expect(await check(token, techLook)).toBeNull();
    const orphan = newSessionSecret();
    await add(orphan, null);
    expect(await check(token, orphan)).toBeNull();
    // A customer's own device doesn't depend on any staff member.
    const device = await signIn(token, "909090");
    await c.query("savepoint s_staff_row2");
    try {
      await setActive(staffId, false);
      expect(await check(token, device)).toEqual({ kind: "customer" });
    } finally {
      await c.query("rollback to savepoint s_staff_row2");
    }
    await c.query("rollback to savepoint s_staff");
  });

  it("the tables are RLS-on with only the written-down deny, and every new function pins its search_path", async () => {
    if (!needs()) return;
    const { rows } = await c.query(
      `select c.relname, c.relrowsecurity, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              (select bool_and(coalesce(p.qual, '') = 'false') from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as deny_only
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('customer_portal_codes', 'customer_portal_sessions', 'customer_portal_preview_tickets')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.policies).toBe(1);
      expect(r.deny_only).toBe(true);
    }
    const fns = await c.query(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('portal_gate','portal_session_check','portal_code_issue','portal_code_try','portal_code_redeem',
          'portal_session_end','portal_preview_redeem','portal_link_devices','portal_sessions_end_all','portal_preview_ticket',
          'portal_code_void','customer_email_ends_portal_sessions')`,
    );
    expect(fns.rows).toHaveLength(12);
    for (const f of fns.rows) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(f.cfg, f.proname).toMatch(/search_path=/);
    }
  });
});
