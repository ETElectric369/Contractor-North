import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { FEATURE_KEYS, featurePreset } from "@/lib/features";

/**
 * THE SWITCH BOARD (0352), THE PAGE-OPEN COUNTER (0353) AND THE BACKFILL (0355), where the
 * boundaries live: the database.
 *
 *   · only the owner moves a switch (set_org_feature): admin, office and tech are refused, a
 *     deactivated owner is nobody, an unknown key is refused, another company is never touched,
 *     and every flip leaves one audit row;
 *   · the pin: a direct settings PATCH by office staff, and publish_site_version's merge, carry
 *     features / trade / timeclock_job_codes through unchanged while their other keys land;
 *   · create_organization keeps the trade and writes the whitelisted starting switches, and the old
 *     two-argument call still works;
 *   · FEATURE_KEYS equals feature_keys();
 *   · bump_page_open counts for the caller's company only, strips ids, stores no person, and no
 *     tenant can read page_opens (a platform admin can);
 *   · 0355 run on a throwaway company with rows turns the right switches on and keeps a stored one.
 *
 * Everything happens inside ONE transaction that is always rolled back, on throwaway companies
 * (lib/throwaway-org.db-fixture). People speak by planted request.jwt.claims under
 * `set local role authenticated`; refusals run inside savepoints so the transaction lives on.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [W0_APPLY_SWITCHES=1] npx vitest run <this file>
 * (W0_APPLY_SWITCHES=1 applies 0352/0353 inside the rolled-back transaction when the database
 * doesn't have them yet; without it such a run waits, loudly, and CI fails it.)
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, W0_APPLY_SWITCHES } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const BACKFILL = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0355_"))!), "utf8");

d("the switch board, the page-open counter and the backfill (0352, 0353, 0355)", () => {
  let c: pg.Client;
  let waiting = false;
  let orgId = "";
  let ownerId = "";
  let adminId = "";
  let officeId = "";
  let techId = "";
  let otherOrgId = "";
  let otherOwnerId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (waiting) return ctx.skip();
      await fn();
    });
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
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
  /** A TEST sign-in with no company yet (invite-only honoured: allowlisted first; handle_new_user
   *  makes the profile). Given a company and a role, it joins it the way onboarding does. */
  const person = async (tag: string, org?: string, role?: "admin" | "office") => {
    const email = `test-switch-${tag}-${randomUUID()}@example.invalid`;
    await c.query("insert into signup_allowlist (email, note) values ($1, 'TEST switch board, rolled back') on conflict do nothing", [email]);
    const id = String((await one("insert into auth.users (id, email, aud, role) values (gen_random_uuid(), $1, 'authenticated', 'authenticated') returning id", [email])).id);
    if (org && role) {
      const p = await one("update profiles set org_id = $2, role = $3, active = true where id = $1 returning org_id, role::text as role", [id, org, role]);
      if (p?.org_id !== org || p?.role !== role) throw new Error(`the ${role} seat did not land`);
    }
    return id;
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '30s'");
    const have = await one(
      `select to_regprocedure('public.set_org_feature(text, boolean)') is not null as sw,
              to_regprocedure('public.bump_page_open(text)') is not null as po`,
    );
    if ((!have.sw || !have.po) && W0_APPLY_SWITCHES === "1") {
      // Opt-in, for iterating before rebuild.cjs records them: applied INSIDE this transaction,
      // which is rolled back, so the database is left exactly as it was.
      for (const p of ["0352_", "0353_"]) await c.query(readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith(p))!), "utf8"));
    } else if (!have.sw || !have.po) {
      waiting = !notOnThisDatabase("[feature-switches] 0352 / 0353 are not on this database yet: run node scripts/test-db/rebuild.cjs.");
      if (waiting) return;
    }
    const org = await mintThrowawayOrg(c, { label: "switch board", techs: 1 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    techId = org.techs[0].id;
    adminId = await person("admin", orgId, "admin");
    officeId = await person("office", orgId, "office");
    const other = await mintThrowawayOrg(c, { label: "switch board stranger", techs: 0 });
    otherOrgId = other.orgId;
    otherOwnerId = other.owner.id;
    await c.query(
      `update organizations set settings = '{"trade_label": "TEST", "service_area": "before", "timeclock_job_codes": false}'::jsonb where id = $1`,
      [orgId],
    );
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("FEATURE_KEYS equals public.feature_keys()", async () => {
    expect((await one("select public.feature_keys() as k")).k).toEqual([...FEATURE_KEYS]);
  });

  it("the owner flips a switch: previous and new come back, the map stores it, one audit row says so", async () => {
    const r = await tryAs(ownerId, "select public.set_org_feature('panel_map', false) as r");
    expect(r.error).toBeNull();
    expect(r.rows[0].r).toEqual({ key: "panel_map", previous: true, on: false });
    const s = await settingsOf(orgId);
    expect(s.features).toEqual({ panel_map: false });
    expect(s.service_area).toBe("before"); // nothing else moved
    const audit = await c.query("select user_id, action, ok, input_summary, source from agent_audit_log where org_id = $1", [orgId]);
    expect(audit.rows).toEqual([
      { user_id: ownerId, action: "feature.set", ok: true, input_summary: { key: "panel_map", from: true, to: false }, source: "ui" },
    ]);
  });

  it("job codes: previous reads the old checkbox, and the old key follows the switch", async () => {
    const r = await tryAs(ownerId, "select public.set_org_feature('job_codes', true) as r");
    expect(r.rows[0].r).toEqual({ key: "job_codes", previous: false, on: true });
    const s = await settingsOf(orgId);
    expect(s.features.job_codes).toBe(true);
    expect(s.timeclock_job_codes).toBe(true);
  });

  it("admin, office and tech are refused, and nothing moves", async () => {
    const before = await settingsOf(orgId);
    for (const uid of [adminId, officeId, techId]) {
      const r = await tryAs(uid, "select public.set_org_feature('panel_map', true)");
      expect(r.error, uid).toBe("Only the owner can turn features on or off.");
    }
    expect(await settingsOf(orgId)).toEqual(before);
  });

  it("a deactivated owner is nobody; an unknown key and a null are refused", async () => {
    expect((await tryAs(ownerId, "select public.set_org_feature('plan', true)")).error).toBe('There is no feature called "plan".');
    expect((await tryAs(ownerId, "select public.set_org_feature('leads', null)")).error).toBe("Say on or off.");
    // Deactivated the way the server does it (the service role: 0225 lets only the owner or the
    // server touch the owner's seat), then back, all inside a savepoint.
    await c.query("savepoint deact");
    let r: { error: string | null };
    try {
      await c.query(`select set_config('request.jwt.claims', '{"role": "service_role"}', true)`);
      await c.query("update profiles set active = false where id = $1", [ownerId]);
      await asServer();
      r = await tryAs(ownerId, "select public.set_org_feature('leads', false)");
    } finally {
      await c.query("rollback to savepoint deact");
      await asServer();
    }
    expect(r.error).toBe("Sign in to your company first.");
  });

  it("another company is never touched: its owner's flip lands on its own map only", async () => {
    const mine = await settingsOf(orgId);
    const r = await tryAs(otherOwnerId, "select public.set_org_feature('panel_map', true) as r");
    expect(r.error).toBeNull();
    expect((await settingsOf(otherOrgId)).features).toEqual({ panel_map: true });
    expect(await settingsOf(orgId)).toEqual(mine);
  });

  it("the pin: office's direct settings PATCH keeps features, trade and timeclock_job_codes; its other keys land", async () => {
    const before = await settingsOf(orgId);
    const r = await tryAs(
      officeId,
      `update organizations
          set settings = settings || '{"features": {"panel_map": true, "leads": false}, "trade": "deck", "timeclock_job_codes": false, "service_area": "office wrote this"}'::jsonb
        where id = $1 returning id`,
      [orgId],
    );
    expect(r.error).toBeNull();
    expect(r.rows).toHaveLength(1); // the write happened (0181 lets office save settings)
    const s = await settingsOf(orgId);
    expect(s.service_area).toBe("office wrote this");
    expect(s.features).toEqual(before.features);
    expect(s.trade).toBeUndefined(); // it had none, so it still has none
    expect(s.timeclock_job_codes).toBe(before.timeclock_job_codes);
    // Removing the map is not a way around it either.
    await tryAs(officeId, "update organizations set settings = settings - 'features' where id = $1", [orgId]);
    expect((await settingsOf(orgId)).features).toEqual(before.features);
  });

  it("the pin: the owner's own direct PATCH is not a switch either (only set_org_feature is)", async () => {
    const before = (await settingsOf(orgId)).features;
    await tryAs(ownerId, `update organizations set settings = jsonb_set(settings, '{features,panel_map}', 'true') where id = $1`, [orgId]);
    expect((await settingsOf(orgId)).features).toEqual(before);
  });

  it("the pin: publish_site_version's merge carries the switches through; the site keys land", async () => {
    const before = await settingsOf(orgId);
    const v = await one("insert into site_versions (org_id, v, doc, status) values ($1, 1, '{}'::jsonb, 'draft') returning id", [orgId]);
    const r = await tryAs(officeId, "select public.publish_site_version($1, $2::jsonb)", [
      v.id,
      JSON.stringify({ splash_headline: "TEST published", features: { leads: false }, trade: "roofing", timeclock_job_codes: false }),
    ]);
    expect(r.error).toBeNull();
    const s = await settingsOf(orgId);
    expect(s.splash_headline).toBe("TEST published");
    expect(s.features).toEqual(before.features);
    expect(s.trade).toBeUndefined();
    expect(s.timeclock_job_codes).toBe(before.timeclock_job_codes);
  });

  it("create_organization keeps the trade and the whitelisted starting switches; the old call still works", async () => {
    const a = await person("signup");
    const preset = featurePreset("electrical");
    const r = await tryAs(a, "select public.create_organization('TEST switch signup', null, 'electrical', $1::jsonb) as id", [
      JSON.stringify({ ...preset, bogus: true, nort: "yes" }),
    ]);
    expect(r.error).toBeNull();
    const s = await settingsOf(r.rows[0].id);
    expect(s.trade).toBe("electrical");
    // Whitelisted keys holding real booleans only: "bogus" is not a feature, "yes" is not a boolean.
    const { nort: _dropped, ...kept } = preset;
    expect(s.features).toEqual(kept);
    expect(s.timeclock_job_codes).toBe(preset.job_codes);
    expect((await one("select role from profiles where id = $1", [a])).role).toBe("owner");

    const b = await person("signup-old");
    const old = await tryAs(b, "select public.create_organization('TEST switch old call', null) as id");
    expect(old.error).toBeNull();
    const s2 = await settingsOf(old.rows[0].id);
    expect(s2.features).toBeUndefined(); // no map = every switch reads on (today's app)
    expect(s2.trade).toBeUndefined();
    expect((await one("select count(*)::int as n from job_codes where org_id = $1", [old.rows[0].id])).n).toBeGreaterThan(0);
  });

  it("bump_page_open counts for the caller's company only, with the ids stripped and no person stored", async () => {
    for (const p of ["/jobs/6f1c2d3e-aaaa-bbbb-cccc-1234567890ab?tab=costs", "/jobs/[id]?tab=costs", "/planner"]) {
      expect((await tryAs(techId, "select public.bump_page_open($1) as ok", [p])).rows[0].ok).toBe(true);
    }
    expect((await tryAs(techId, "select public.bump_page_open('not a path') as ok")).rows[0].ok).toBe(false);
    const rows = (await c.query("select page, opens from page_opens where org_id = $1 order by page", [orgId])).rows;
    expect(rows).toEqual([
      { page: "/jobs/[id]?tab=costs", opens: 2 },
      { page: "/planner", opens: 1 },
    ]);
    expect((await one("select count(*)::int as n from page_opens where org_id = $1", [otherOrgId])).n).toBe(0);
    const cols = (await c.query("select column_name from information_schema.columns where table_schema='public' and table_name='page_opens' order by 1")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["day", "opens", "org_id", "page"]);
  });

  it("no tenant reads page_opens, not even its own company's; a platform admin does; anon can't count", async () => {
    for (const uid of [ownerId, officeId, techId]) {
      const r = await tryAs(uid, "select count(*)::int as n from page_opens");
      expect(r.error).toBeNull();
      expect(r.rows[0].n, uid).toBe(0);
      expect((await tryAs(uid, "insert into page_opens (org_id, page, day, opens) values ($1, '/x', current_date, 99)", [orgId])).error).toMatch(/permission denied/);
    }
    await c.query("savepoint padmin");
    await c.query("insert into platform_admins (user_id) values ($1)", [adminId]);
    const seen = await tryAs(adminId, "select count(*)::int as n from page_opens where org_id = $1", [orgId]);
    await c.query("rollback to savepoint padmin");
    expect(seen.rows[0].n).toBe(2);
    expect((await one("select has_function_privilege('anon', 'public.bump_page_open(text)', 'execute') as x")).x).toBe(false);
  });

  it("0355 turns on what a company uses, keeps a stored switch, and names its trade", async () => {
    // A plumbing company (from the words) with rows in Daily Reports, Crew Board, To-Do Extras,
    // Sales Tax and a coded clock-in; an auto-minted-style portal link that must NOT count; and a
    // Panel Map switch its owner already stored off.
    const t = await mintThrowawayOrg(c, { label: "switch backfill", techs: 1 });
    const o = t.orgId;
    const tech = t.techs[0].id;
    await c.query(
      `update organizations set settings = '{"trade_label": "Plumbing & Heating", "features": {"panel_map": false}}'::jsonb,
                                created_at = now() - interval '30 days' where id = $1`,
      [o],
    );
    await c.query("insert into daily_reports (org_id, profile_id, report_date, did_today) values ($1, $2, '2001-01-01', 'TEST')", [o, tech]);
    await c.query("insert into crew_day_assignments (org_id, profile_id, work_date, kind, off_reason) values ($1, $2, '2001-01-01', 'off', 'other')", [o, tech]);
    await c.query("insert into tasks (org_id, title, priority) values ($1, 'TEST', 2)", [o]);
    await c.query("insert into tax_rates (org_id, name, rate) values ($1, 'TEST tax', 0.05)", [o]);
    await c.query(
      `insert into time_entries (org_id, profile_id, clock_in, clock_out, job_code, status)
       values ($1, $2, '2001-01-01 08:00+00', '2001-01-01 09:00+00', 'SVC', 'closed')`,
      [o, tech],
    );
    const cust = await one("insert into customers (org_id, name) values ($1, 'TEST customer') returning id", [o]);
    await c.query(
      "insert into customer_portal_access (customer_id, org_id, token, enabled) values ($1, $2, $3, true) on conflict do nothing",
      [cust.id, o, `test-${cust.id}`],
    );

    await asServer();
    await c.query("savepoint backfill");
    await c.query(BACKFILL);
    const s = await settingsOf(o);
    await c.query("release savepoint backfill");

    expect(s.trade).toBe("plumbing");
    const f = s.features as Record<string, boolean>;
    expect(Object.keys(f).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(f).toMatchObject({
      shop_stock: true, // the plumbing preset
      daily_reports: true, // rows
      crew_board: true, // rows
      todo_extras: true, // rows
      sales_tax: true, // rows
      job_codes: true, // a coded clock-in
      panel_map: false, // stored by the owner: kept
      customer_portal: false, // a minted link is not use
      kits: false,
      contracts: false,
      site_chat: false, // no live site
      permits: true,
    });
    expect(s.timeclock_job_codes).toBe(true);

    // A company that already has a whole map is not touched; a re-run changes nothing.
    await c.query("savepoint again");
    await c.query(BACKFILL);
    expect(await settingsOf(o)).toEqual(s);
    await c.query("release savepoint again");
  });
});
