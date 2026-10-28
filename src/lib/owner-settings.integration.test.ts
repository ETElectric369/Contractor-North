import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * THE OWNER-ONLY SETTINGS ARE PINNED IN THE DATABASE (0397, cn-v1134). organizations.settings is one
 * jsonb column that 0181 lets an office seat PATCH whole; the app alone kept two keys in it out of
 * their hands. 0397's pin_owner_settings trigger makes that a boundary:
 *
 *   office_sees_owner_money   moves for an ACTIVE owner (0158) or a privileged writer (the service
 *                             role, a migration); an office or admin seat, or a deactivated owner,
 *                             is refused in words naming the one action;
 *   lead_inbound_secret       moves for a privileged writer only;
 *   anything else             a save that carries both keys through unchanged passes untouched.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company, with
 * 0397 applied inside it (the file on this branch, so what is asserted is what ships). Each seat is
 * played the way PostgREST plays it: request.jwt.claims under `set local role authenticated`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith(prefix))!), "utf8");
const M0397 = migration("0397_");

/** 0397's words. */
const MONEY_WORDS = "Only the owner changes who sees the owner's money, on the Analytics page.";
const SECRET_WORDS = "Only North sets the inbound lead key. Ask North to change it.";
/** 0286's guard_owner_money_visibility fires first for the money key (triggers fire in name order). */
const MONEY_WORDS_0286 = "Only the owner can change whether the office sees what is left for the owner.";

d("the owner-only settings are pinned in the database (0397)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let officeId = "";
  let adminId = "";

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
  /** The server: no claims at all (0154's is_privileged_writer reads that as privileged). */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The service role, as the webhook and the admin client arrive. */
  const asServiceRole = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  };

  /**
   * One settings PATCH by `who` (a seat's id, "server" or "service"), merged over the stored map as
   * every app door merges. Answers the refusal's words, or null when it landed with the row read
   * back holding the patch. Always undone, and the connection put back as the server.
   */
  const patch = async (who: string, change: Record<string, unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      if (who === "server") await asServer();
      else if (who === "service") await asServiceRole();
      else await as(who);
      const { rows } = await c.query(
        "update public.organizations set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1 returning settings",
        [orgId, JSON.stringify(change)],
      );
      if (rows.length !== 1) return `landed on ${rows.length} rows`;
      for (const [k, v] of Object.entries(change)) {
        if (JSON.stringify(rows[0].settings?.[k]) !== JSON.stringify(v)) return `landed, but ${k} reads ${JSON.stringify(rows[0].settings?.[k])}`;
      }
      return null;
    } catch (e) {
      return String((e as Error).message ?? e);
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
    const org = await mintThrowawayOrg(c, { label: "0397 owner settings", techs: 2 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    // An office seat and an admin seat, promoted by the owner (0225: only an owner or admin changes roles).
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
    officeId = org.techs[0].id;
    adminId = org.techs[1].id;
    const promoted = (
      await c.query("update public.profiles set role = 'office' where id = $1 and org_id = $2 returning role::text as role", [officeId, orgId])
    ).rows[0];
    const promotedAdmin = (
      await c.query("update public.profiles set role = 'admin' where id = $1 and org_id = $2 returning role::text as role", [adminId, orgId])
    ).rows[0];
    await asServer();
    if (promoted?.role !== "office" || promotedAdmin?.role !== "admin") throw new Error("0397 test: the office and admin seats did not land.");
    await c.query("update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{\"office_sees_owner_money\": true, \"currency\": \"USD\"}'::jsonb where id = $1", [orgId]);
    await c.query(M0397); // the pin as it ships
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the trigger is bound and enabled beside 0352's and 0286's, and nobody signed in can call the function", async () => {
    const { rows } = await c.query(
      "select tgname, tgenabled from pg_trigger where tgrelid = 'public.organizations'::regclass and not tgisinternal and tgname in ('pin_owner_settings', 'pin_org_features', 'guard_owner_money_visibility') order by 1",
    );
    expect(rows.map((r: { tgname: string }) => r.tgname)).toEqual(["guard_owner_money_visibility", "pin_org_features", "pin_owner_settings"]);
    for (const r of rows) expect(r.tgenabled).not.toBe("D");
    const grants = (
      await c.query(
        "select has_function_privilege('anon', 'public.pin_owner_settings()', 'execute') as anon, has_function_privilege('authenticated', 'public.pin_owner_settings()', 'execute') as authed",
      )
    ).rows[0];
    expect(grants).toEqual({ anon: false, authed: false });
  });

  it("an office seat's PATCH of office_sees_owner_money is refused in words; so is an admin's", async () => {
    const office = await patch(officeId, { office_sees_owner_money: false });
    expect(office).toMatch(/^Only the owner/);
    expect([MONEY_WORDS, MONEY_WORDS_0286]).toContain(office);
    const admin = await patch(adminId, { office_sees_owner_money: false });
    expect([MONEY_WORDS, MONEY_WORDS_0286]).toContain(admin);
    // Blanking the key (JSON null over true) is a change too.
    const blanked = await patch(officeId, { office_sees_owner_money: null });
    expect([MONEY_WORDS, MONEY_WORDS_0286]).toContain(blanked);
  });

  // 0397's OWN money branch is unreachable while 0286's guard_owner_money_visibility stands (triggers
  // fire in name order, and 0286's refuses first), so its words are proven by the source pin on the
  // migration's body below — never by disabling 0286's trigger here: no DB suite alters a trigger on
  // a shared table (table ownership, and a lock the pooler's other sessions would wait on).

  it("the owner's write lands, both ways", async () => {
    expect(await patch(ownerId, { office_sees_owner_money: false })).toBeNull();
    expect(await patch(ownerId, { office_sees_owner_money: true })).toBeNull();
  });

  it("the server's write lands: the service role and a migration are privileged writers", async () => {
    expect(await patch("service", { office_sees_owner_money: false })).toBeNull();
    expect(await patch("server", { office_sees_owner_money: false })).toBeNull();
    expect(await patch("service", { lead_inbound_secret: "test-0397-key" })).toBeNull();
    expect(await patch("server", { lead_inbound_secret: "test-0397-key" })).toBeNull();
  });

  it("a deactivated owner is nobody (0158): refused like anyone else", async () => {
    await c.query("savepoint cut");
    try {
      await asServiceRole(); // 0225: only the owner or the server deactivates the owner
      const cut = (await c.query("update public.profiles set active = false where id = $1 returning active", [ownerId])).rows[0];
      expect(cut?.active).toBe(false);
      await asServer();
      const msg = await patch(ownerId, { office_sees_owner_money: false });
      expect(msg).not.toBeNull();
      // RLS hides the row from a deactivated seat (auth_org_id() is NULL), or the pin refuses: either way it did not land.
      expect(msg === "landed on 0 rows" || /^Only the owner/.test(msg ?? "")).toBe(true);
    } finally {
      await c.query("rollback to savepoint cut");
      await asServer();
    }
  });

  it("lead_inbound_secret: no seat moves it, not even the owner", async () => {
    expect(await patch(officeId, { lead_inbound_secret: "test-0397-key" })).toBe(SECRET_WORDS);
    expect(await patch(adminId, { lead_inbound_secret: "test-0397-key" })).toBe(SECRET_WORDS);
    expect(await patch(ownerId, { lead_inbound_secret: "test-0397-key" })).toBe(SECRET_WORDS);
  });

  it("an ordinary save that carries both keys through unchanged passes, from every seat", async () => {
    expect(await patch(officeId, { currency: "CAD" })).toBeNull();
    expect(await patch(adminId, { currency: "CAD", timezone: "America/Denver" })).toBeNull();
    expect(await patch(ownerId, { currency: "CAD" })).toBeNull();
    // Re-stating the stored value is not a change either (the read-merge-write every door does).
    expect(await patch(officeId, { office_sees_owner_money: true, currency: "CAD" })).toBeNull();
  });
});
