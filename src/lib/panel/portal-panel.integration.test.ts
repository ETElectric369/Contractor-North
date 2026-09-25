import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Migration 0335: the panel on the customer's page, only once the office turns it on, and only the
 * safe fields (Panel plan, phase 5).
 *
 * Spoken to the database the way PostgREST would (office staff, a tech) and the way the portal
 * page does (the service role; the direct connection here), inside ONE transaction on ONE
 * connection, begun before anything else and always rolled back. It borrows an active tech and an
 * active office member of one org and makes its own customers, jobs, panels and circuits, so no
 * real row is read for an answer or left behind. Read-back is the assertion.
 *
 *   - hidden by default: a panel with circuits is not on the page until the office turns it on;
 *   - a tech cannot turn it on (0333's guard, 42501);
 *   - on: each panel carries exactly {name, main_amps, spaces, circuits}, each circuit exactly
 *     {space, half, poles, amps, kind, room, label, feeds, is_new}; kept circuits only, never a
 *     suggestion, one taken off or one coming out; never a wire tag, a note, a source or a who;
 *   - another customer's link opens nothing of it, and a panel taken off leaves the page.
 *
 * BEFORE 0335 IS APPLIED each case skips and says so. TEST_APPLY_PENDING=1 loads 0335 INSIDE the
 * rolled-back transaction (a practice run; lock_timeout 3s, statement_timeout 15s), never CI.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [TEST_APPLY_PENDING=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, TEST_APPLY_PENDING } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const PANEL_KEYS = ["circuits", "main_amps", "name", "spaces"];
const CIRCUIT_KEYS = ["amps", "feeds", "half", "is_new", "kind", "label", "poles", "room", "space"];

d("the panel on the customer's page (0335)", { timeout: 30_000 }, () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let jobA = "";
  let jobB = "";
  let tokenA = "";
  let tokenB = "";
  let panelId = "";
  let otherPanelId = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) {
        console.warn("[portal-panel] migration 0335 is not on this database yet; apply it (or TEST_APPLY_PENDING=1) to exercise this case.");
        return ctx.skip();
      }
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
  const view = async (token: string, jobId: string) => (await one("select public.portal_job_view($1, $2) as j", [token, jobId])).j;
  const setShown = async (id: string, shown: boolean) => {
    await as(staffId);
    const r = await c.query("update public.job_panels set shown_on_portal = $2 where id = $1 returning shown_on_portal", [id, shown]);
    await asServer();
    expect(r.rows).toEqual([{ shown_on_portal: shown }]);
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    // FIRST: nothing below may write outside this transaction.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const probe = async () =>
      (
        await one(
          `select to_regclass('public.job_panels') is not null
              and position('job_panels' in pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure)) > 0 as ok`,
        )
      ).ok as boolean;
    ready = await probe();
    if (!ready && TEST_APPLY_PENDING === "1" && (await one("select to_regclass('public.job_panels') is not null as ok")).ok) {
      await c.query(fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", "0335_the_panel_on_their_page.sql"), "utf8"));
      ready = await probe();
    }
    if (!ready) return;

    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and coalesce(s.active, true)
        where t.role = 'tech' and coalesce(t.active, true)
        order by (s.role = 'owner') desc, t.id
        limit 1`,
    );
    if (!fx) throw new Error("0335 test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;

    const cust = async (name: string) => (await one("insert into public.customers (org_id, name) values ($1, $2) returning id", [orgId, name])).id as string;
    const custA = await cust("TEST 0335 A");
    const custB = await cust("TEST 0335 B");
    const job = async (customerId: string, number: string) =>
      (
        await one("insert into public.jobs (org_id, name, job_number, status, billing_type, customer_id) values ($1, $2, $2, 'in_progress', 'tm', $3) returning id", [
          orgId,
          number,
          customerId,
        ])
      ).id as string;
    jobA = await job(custA, "TEST-0335-A");
    jobB = await job(custB, "TEST-0335-B");
    tokenA = (await one("select token from public.customer_portal_access where customer_id = $1", [custA])).token;
    tokenB = (await one("select token from public.customer_portal_access where customer_id = $1", [custB])).token;

    // The crew adds the panel and works the list, the way the Panel tab does.
    await as(techId);
    panelId = (
      await one("insert into public.job_panels (org_id, job_id, name, main_amps, spaces, notes) values ($1, $2, 'Main Panel', 125, 32, 'TEST-NOTE crimped bus') returning id", [orgId, jobA])
    ).id;
    otherPanelId = (await one("insert into public.job_panels (org_id, job_id, name, spaces) values ($1, $2, 'Garage Sub', 12) returning id", [orgId, jobA])).id;
    const add = async (cols: Record<string, unknown>) => {
      const row = { org_id: orgId, job_id: jobA, panel_id: panelId, ...cols };
      const keys = Object.keys(row);
      return (
        await one(`insert into public.job_circuits (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))
      ).id as string;
    };
    await add({ room: "Kitchen", description: "Range", amps: 50, poles: 2, kind: "gfci", space: 25, work: "existing", wire: "6/3", wire_tag: "TEST-TAG-RANGE" });
    await add({ room: "Kitchen", description: "Kitchen and living", panel_label: "Entry Lights", amps: 15, space: 7, work: "reused", progress: "done", verified: true });
    await add({ room: "Bath", description: "GFI Outlets", panel_label: "gfi outlets", amps: 20, space: 9, half: "A" });
    await add({ room: "Bath", description: "Floor Heat", amps: 20, poles: 2 });
    // Never on the page: a suggestion, one taken off, one coming out, one on the panel not shown.
    await add({ room: "Garage", description: "TEST-SUGGESTED Freezer", amps: 20, source: "nort", source_row: JSON.stringify({ key: "nort:1", said: "freezer" }) });
    await add({ room: "Hall", description: "TEST-TAKEN-OFF Fan", amps: 15, removed_at: new Date().toISOString() });
    await add({ room: "Hall", description: "TEST-COMING-OUT Heater", amps: 30, poles: 2, work: "removed" });
    await add({ room: "Garage", description: "TEST-SUB Opener", amps: 20, panel_id: otherPanelId });
    await asServer();
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("hidden by default: a panel full of circuits is not on the page until the office turns it on", async () => {
    const v = await view(tokenA, jobA);
    expect(v.panels).toEqual([]);
    expect((await one("select shown_on_portal from public.job_panels where id = $1", [panelId])).shown_on_portal).toBe(false);
  });

  it("a tech cannot turn it on", async () => {
    expect(
      await refused(async () => {
        await as(techId);
        await c.query("update public.job_panels set shown_on_portal = true where id = $1", [panelId]);
      }),
    ).toBe("42501");
    // Nor on the way in: a crew insert asking for it lands off.
    await c.query("savepoint crew_insert");
    try {
      await as(techId);
      const r = await one("insert into public.job_panels (org_id, job_id, name, shown_on_portal) values ($1, $2, 'Crew Asked', true) returning shown_on_portal", [orgId, jobA]);
      expect(r.shown_on_portal).toBe(false);
    } finally {
      await c.query("rollback to savepoint crew_insert");
      await asServer();
    }
  });

  it("on: exactly the safe keys, kept circuits only, in space order, the door's words first", async () => {
    await c.query("savepoint shown");
    try {
      await setShown(panelId, true);
      const v = await view(tokenA, jobA);
      expect(v.panels).toHaveLength(1);
      const p = v.panels[0];
      expect(Object.keys(p).sort()).toEqual(PANEL_KEYS);
      expect(p).toMatchObject({ name: "Main Panel", main_amps: 125, spaces: 32 });
      for (const x of p.circuits) expect(Object.keys(x).sort()).toEqual(CIRCUIT_KEYS);
      expect(p.circuits).toEqual([
        { space: 7, half: null, poles: 1, amps: 15, kind: null, room: "Kitchen", label: "Entry Lights", feeds: "Kitchen and living", is_new: false },
        // The same words in another case are not said twice.
        { space: 9, half: "A", poles: 1, amps: 20, kind: null, room: "Bath", label: "gfi outlets", feeds: null, is_new: true },
        { space: 25, half: null, poles: 2, amps: 50, kind: "gfci", room: "Kitchen", label: "Range", feeds: null, is_new: false },
        { space: null, half: null, poles: 2, amps: 20, kind: null, room: "Bath", label: "Floor Heat", feeds: null, is_new: true },
      ]);
      const text = JSON.stringify(v.panels);
      for (const secret of ["TEST-NOTE", "TEST-TAG", "6/3", "TEST-SUGGESTED", "TEST-TAKEN-OFF", "TEST-COMING-OUT", "TEST-SUB", "nort", "verified", "done", staffId, techId]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      await c.query("rollback to savepoint shown");
      await asServer();
    }
  });

  it("another customer's link opens nothing of it; their own job shows no panel", async () => {
    await c.query("savepoint other");
    try {
      await setShown(panelId, true);
      expect(await view(tokenB, jobA)).toBeNull();
      expect((await view(tokenB, jobB)).panels).toEqual([]);
    } finally {
      await c.query("rollback to savepoint other");
      await asServer();
    }
  });

  it("a panel the office takes off the job leaves the page; turning the switch off does too", async () => {
    await c.query("savepoint off");
    try {
      await setShown(panelId, true);
      await setShown(otherPanelId, true);
      // Both panels were made in this one transaction, so they share created_at and their order
      // falls to the random id: the test asks WHICH panels show, not in what order.
      expect((await view(tokenA, jobA)).panels.map((p: { name: string }) => p.name).sort()).toEqual(["Garage Sub", "Main Panel"]);
      await setShown(otherPanelId, false);
      expect((await view(tokenA, jobA)).panels.map((p: { name: string }) => p.name)).toEqual(["Main Panel"]);
      await as(staffId);
      await c.query("update public.job_panels set removed_at = now() where id = $1", [panelId]);
      await asServer();
      expect((await view(tokenA, jobA)).panels).toEqual([]);
    } finally {
      await c.query("rollback to savepoint off");
      await asServer();
    }
  });

  it("only the service role runs the door", async () => {
    expect((await one("select has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute') as a")).a).toBe(false);
    expect((await one("select has_function_privilege('authenticated', 'public.portal_job_view(text, uuid)', 'execute') as a")).a).toBe(false);
  });
});
