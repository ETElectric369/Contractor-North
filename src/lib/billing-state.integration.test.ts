import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * THE TRIAL WARNS, THE LAPSE KEEPS THE LIGHTS ON (0400, cn-v1137). A company's standing gets its
 * ledger (billing_notices), its comp (comped_until) and its pin on the test database:
 *
 *   organizations_update   re-created from 0181 verbatim plus three clauses: an owner's, an admin's
 *                          or an office seat's own-client UPDATE of billing_notices or comped_until
 *                          is refused; a SET stripe_terminal_location_id is never repointed by hand,
 *                          while the lazy first fill (null → tml_…) by a staff seat still lands; an
 *                          ordinary write (the company's name) still lands from every seat.
 *   claim_billing_notice   true once per key (the stamp is a timestamp), false after; keys are
 *                          independent. release_billing_notice: true once, false after, and a
 *                          released key can be claimed again. Both service role only: a signed-in
 *                          person and anon are refused.
 *   platform_set_comped_until  a company's owner is refused in words; North's own team sets,
 *                          clears on null, and each write leaves ONE agent_audit_log row
 *                          (comp.set, {from, to}); an unknown company answers false and no row.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company, with
 * 0400 applied inside it when the database does not carry it yet (the file on this branch, so what
 * is asserted is what ships) and applied AGAIN on top of itself (twice-safe, proven). Each seat is
 * played the way PostgREST plays it: request.jwt.claims under `set local role authenticated`. Every
 * statement names the throwaway company's id.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith(prefix))!), "utf8");
const M0400 = migration("0400_");

const CLAIM = "public.claim_billing_notice(uuid,text)";
const RELEASE = "public.release_billing_notice(uuid,text)";
const COMP = "public.platform_set_comped_until(uuid,timestamptz)";
const NOT_ADMIN = "Only North's own team can comp a company.";

d("the trial warns, the lapse keeps the lights on (0400)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let officeId = "";

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

  /**
   * One UPDATE of the throwaway company's row by `who` (a seat's id or "server"), always undone.
   * Answers null when it landed on exactly one row, else the refusal's words or the row count.
   */
  const attempt = async (who: string, setClause: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      if (who === "server") await asServer();
      else await as(who);
      const { rows } = await c.query(`update public.organizations set ${setClause} where id = $1 returning id`, [orgId, ...params]);
      return rows.length === 1 ? null : `landed on ${rows.length} rows`;
    } catch (e) {
      return String((e as Error).message ?? e);
    } finally {
      await c.query("rollback to savepoint attempt");
      await asServer();
    }
  };
  /** The pin's refusal reads as Postgres words it (the WITH CHECK), or as zero rows (RLS hid the row). */
  const refusedByPin = (msg: string | null) => msg !== null && (msg === "landed on 0 rows" || /row-level security/i.test(msg));

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

  /** The company's row as the server sees it. */
  const row = async () => {
    const { rows } = await c.query(
      "select billing_notices, comped_until, stripe_terminal_location_id, name from public.organizations where id = $1",
      [orgId],
    );
    return rows[0] as { billing_notices: Record<string, string>; comped_until: Date | null; stripe_terminal_location_id: string | null; name: string };
  };
  const claim = async (key: string) => (await c.query("select public.claim_billing_notice($1::uuid, $2) as ok", [orgId, key])).rows[0].ok as boolean;
  const release = async (key: string) => (await c.query("select public.release_billing_notice($1::uuid, $2) as ok", [orgId, key])).rows[0].ok as boolean;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    const have = (await c.query(`select to_regprocedure('${CLAIM}') is not null as ok`)).rows[0]?.ok === true;
    if (!have) await c.query(M0400); // the pin and the doors as they ship, inside the transaction that is rolled back
    // Twice-safe, proven: the file runs again on top of itself (on CI, where the rebuild already
    // applied it, this is the second run), and its own self-check must still pass.
    await c.query(M0400);
    const org = await mintThrowawayOrg(c, { label: "0400 billing state", techs: 1 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    officeId = org.techs[0].id;
    // An office seat, promoted by the owner (0225: only an owner or admin changes roles).
    await as(ownerId);
    const promoted = (await c.query("update public.profiles set role = 'office' where id = $1 and org_id = $2 returning role::text as role", [officeId, orgId])).rows[0];
    await asServer();
    if (promoted?.role !== "office") throw new Error("0400 test: the office seat did not land.");
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the columns, the policy's clauses and the grants are on the database", async () => {
    const cols = (
      await c.query(
        `select table_name, column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and ((table_name = 'organizations' and column_name in ('billing_notices', 'comped_until'))
                                          or (table_name = 'bills' and column_name = 'both_real_at'))
          order by 1, 2`,
      )
    ).rows;
    expect(cols).toEqual([
      { table_name: "bills", column_name: "both_real_at", is_nullable: "YES" },
      { table_name: "organizations", column_name: "billing_notices", is_nullable: "NO" },
      { table_name: "organizations", column_name: "comped_until", is_nullable: "YES" },
    ]);
    expect((await row()).billing_notices).toEqual({});
    const policy = (
      await c.query("select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'organizations' and policyname = 'organizations_update'")
    ).rows[0];
    expect(policy?.cmd).toBe("UPDATE");
    expect(policy.qual).toContain("office");
    for (const col of ["billing_notices", "comped_until", "stripe_terminal_location_id", "stripe_platform_fee_bps", "subscription_status"]) {
      expect(policy.with_check, col).toContain(col);
    }
    const grants = (
      await c.query(
        `select has_function_privilege('anon', '${CLAIM}', 'execute') as claim_anon,
                has_function_privilege('authenticated', '${CLAIM}', 'execute') as claim_authed,
                has_function_privilege('service_role', '${CLAIM}', 'execute') as claim_service,
                has_function_privilege('anon', '${RELEASE}', 'execute') as release_anon,
                has_function_privilege('authenticated', '${RELEASE}', 'execute') as release_authed,
                has_function_privilege('service_role', '${RELEASE}', 'execute') as release_service,
                has_function_privilege('anon', '${COMP}', 'execute') as comp_anon,
                has_function_privilege('authenticated', '${COMP}', 'execute') as comp_authed`,
      )
    ).rows[0];
    expect(grants).toEqual({
      claim_anon: false,
      claim_authed: false,
      claim_service: true,
      release_anon: false,
      release_authed: false,
      release_service: true,
      comp_anon: false,
      comp_authed: true,
    });
  });

  it("the pin: an owner's, an office seat's own-client UPDATE of billing_notices or comped_until is refused; the server's lands", async () => {
    expect(refusedByPin(await attempt(ownerId, `billing_notices = '{"trial_3": "2026-10-28T00:00:00Z"}'::jsonb`))).toBe(true);
    expect(refusedByPin(await attempt(officeId, `billing_notices = '{"lapsed": "2026-10-28T00:00:00Z"}'::jsonb`))).toBe(true);
    expect(refusedByPin(await attempt(ownerId, "comped_until = now() + interval '30 days'"))).toBe(true);
    expect(refusedByPin(await attempt(officeId, "comped_until = now() + interval '30 days'"))).toBe(true);
    // The service role (the crons, the webhook) is not bound by the policy.
    expect(await attempt("server", `billing_notices = '{"trial_3": "2026-10-28T00:00:00Z"}'::jsonb`)).toBeNull();
    expect(await attempt("server", "comped_until = now() + interval '30 days'")).toBeNull();
    // Nothing of that stands.
    const r = await row();
    expect(r.billing_notices).toEqual({});
    expect(r.comped_until).toBeNull();
  });

  it("the pin: an ordinary write (the company's name) still lands from the owner and the office seat (0181's roles carried)", async () => {
    expect(await attempt(ownerId, "name = $2", ["TEST 0400 Larkspur Electric"])).toBeNull();
    expect(await attempt(officeId, "name = $2", ["TEST 0400 Snowbell Decks"])).toBeNull();
    // A write that carries the pinned columns through unchanged is not the pin's business.
    expect(await attempt(ownerId, "name = $2, billing_notices = billing_notices, comped_until = comped_until", ["TEST 0400 Bayberry Builders"])).toBeNull();
  });

  it("the pin: a staff seat's first fill of stripe_terminal_location_id lands (the lazy mint); a set value is never repointed by hand; the server may", async () => {
    expect((await row()).stripe_terminal_location_id).toBeNull();
    // ensureTerminalLocation's own write: the office seat, the column still null.
    await as(officeId);
    const minted = (
      await c.query(
        "update public.organizations set stripe_terminal_location_id = $2 where id = $1 and stripe_terminal_location_id is null returning id",
        [orgId, "tml_test_0400_first"],
      )
    ).rows;
    await asServer();
    expect(minted).toHaveLength(1);
    expect((await row()).stripe_terminal_location_id).toBe("tml_test_0400_first");
    // Once set, no seat moves it — not to another location, not back to null.
    expect(refusedByPin(await attempt(ownerId, "stripe_terminal_location_id = $2", ["tml_test_0400_second"]))).toBe(true);
    expect(refusedByPin(await attempt(officeId, "stripe_terminal_location_id = $2", ["tml_test_0400_second"]))).toBe(true);
    expect(refusedByPin(await attempt(ownerId, "stripe_terminal_location_id = null"))).toBe(true);
    expect((await row()).stripe_terminal_location_id).toBe("tml_test_0400_first");
    // The server (a migration, the service role) may.
    expect(await attempt("server", "stripe_terminal_location_id = $2", ["tml_test_0400_second"])).toBeNull();
  });

  it("claim_billing_notice: true once per key, false after; the stamp is a timestamp; keys are independent", async () => {
    expect(await claim("trial_3")).toBe(true);
    expect(await claim("trial_3")).toBe(false);
    const after = (await row()).billing_notices;
    expect(Object.keys(after)).toEqual(["trial_3"]);
    expect(typeof after.trial_3).toBe("string");
    expect(Number.isNaN(Date.parse(after.trial_3))).toBe(false);
    expect(Math.abs(Date.parse(after.trial_3) - Date.now())).toBeLessThan(5 * 60_000);
    expect(await claim("trial_1")).toBe(true);
    expect(await claim(`grace_3:${new Date("2026-12-01T00:00:00Z").toISOString()}`)).toBe(true);
    expect(Object.keys((await row()).billing_notices).sort()).toEqual(["grace_3:2026-12-01T00:00:00.000Z", "trial_1", "trial_3"]);
    // No such company: false, nothing written anywhere.
    expect((await c.query("select public.claim_billing_notice($1::uuid, 'trial_3') as ok", [randomUUID()])).rows[0].ok).toBe(false);
    // A key is required: refused in words, not a null key in the ledger.
    const noKey = await (async () => {
      await c.query("savepoint nokey");
      try {
        await c.query("select public.claim_billing_notice($1::uuid, '')", [orgId]);
        return null;
      } catch (e) {
        return { code: (e as { code?: string }).code, message: (e as Error).message };
      } finally {
        await c.query("rollback to savepoint nokey");
      }
    })();
    expect(noKey).toMatchObject({ code: "22023", message: "A billing notice needs a key." });
  });

  it("release_billing_notice: true once, false after; a released key can be claimed again; the other keys stay", async () => {
    expect(await release("trial_3")).toBe(true);
    expect(await release("trial_3")).toBe(false);
    expect(Object.keys((await row()).billing_notices).sort()).toEqual(["grace_3:2026-12-01T00:00:00.000Z", "trial_1"]);
    expect(await claim("trial_3")).toBe(true);
    expect(Object.keys((await row()).billing_notices).sort()).toEqual(["grace_3:2026-12-01T00:00:00.000Z", "trial_1", "trial_3"]);
    expect((await c.query("select public.release_billing_notice($1::uuid, 'trial_3') as ok", [randomUUID()])).rows[0].ok).toBe(false);
  });

  it("a signed-in person and anon cannot call claim or release (service role only)", async () => {
    for (const who of [ownerId, officeId, "anon"]) {
      const claimed = await refused(who, "select public.claim_billing_notice($1::uuid, 'trial_7')", [orgId]);
      expect(claimed?.code, `${who} claim`).toBe("42501");
      const released = await refused(who, "select public.release_billing_notice($1::uuid, 'trial_3')", [orgId]);
      expect(released?.code, `${who} release`).toBe("42501");
    }
    // Nothing moved.
    expect(Object.keys((await row()).billing_notices).sort()).toEqual(["grace_3:2026-12-01T00:00:00.000Z", "trial_1", "trial_3"]);
  });

  it("platform_set_comped_until: a company's owner and office seat are refused in words; anon too; nothing moved", async () => {
    const owner = await refused(ownerId, "select public.platform_set_comped_until($1::uuid, now() + interval '30 days')", [orgId]);
    expect(owner).toMatchObject({ code: "42501", message: NOT_ADMIN });
    const office = await refused(officeId, "select public.platform_set_comped_until($1::uuid, now() + interval '30 days')", [orgId]);
    expect(office).toMatchObject({ code: "42501", message: NOT_ADMIN });
    const anon = await refused("anon", "select public.platform_set_comped_until($1::uuid, now() + interval '30 days')", [orgId]);
    expect(anon?.code).toBe("42501");
    expect((await row()).comped_until).toBeNull();
    expect((await c.query("select count(*)::int as n from public.agent_audit_log where org_id = $1 and action = 'comp.set'", [orgId])).rows[0].n).toBe(0);
  });

  it("North's own team sets, clears on null, and each write leaves one audit row; an unknown company answers false and no row", async () => {
    await c.query("insert into public.platform_admins (user_id, note) values ($1, 'TEST 0400, rolled back')", [ownerId]);
    const until = new Date("2027-01-31T23:59:59Z");
    await c.query("savepoint admin");
    try {
      await as(ownerId);
      const set = (await c.query("select public.platform_set_comped_until($1::uuid, $2::timestamptz) as ok", [orgId, until.toISOString()])).rows[0].ok;
      expect(set).toBe(true);
      await asServer();
      expect((await row()).comped_until?.toISOString()).toBe(until.toISOString());
      const audit = async () =>
        (
          await c.query(
            "select user_id::text as user_id, action, risk, effect, ok, source, input_summary from public.agent_audit_log where org_id = $1 and action = 'comp.set' order by created_at, id",
            [orgId],
          )
        ).rows;
      let rows = await audit();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: ownerId, action: "comp.set", risk: 1, effect: "write", ok: true, source: "ui" });
      expect(rows[0].input_summary.from).toBeNull();
      expect(Date.parse(rows[0].input_summary.to)).toBe(until.getTime());

      await as(ownerId);
      const cleared = (await c.query("select public.platform_set_comped_until($1::uuid, null) as ok", [orgId])).rows[0].ok;
      expect(cleared).toBe(true);
      await asServer();
      expect((await row()).comped_until).toBeNull();
      rows = await audit();
      expect(rows).toHaveLength(2);
      // Both rows are written inside ONE transaction, so they share created_at (now() is the
      // transaction's time) and the uuid tiebreak is random: pin the clear by its content.
      const clearRow = rows.find((r: any) => r.input_summary.to === null);
      expect(clearRow).toBeTruthy();
      expect(Date.parse(clearRow.input_summary.from)).toBe(until.getTime());

      await as(ownerId);
      const missing = (await c.query("select public.platform_set_comped_until($1::uuid, $2::timestamptz) as ok", [randomUUID(), until.toISOString()])).rows[0].ok;
      expect(missing).toBe(false);
      await asServer();
      expect(await audit()).toHaveLength(2);
    } finally {
      await c.query("rollback to savepoint admin");
      await asServer();
    }
    // Nothing of that stands past the savepoint.
    expect((await row()).comped_until).toBeNull();
  });
});
