import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Migration 0333 — THE JOB KNOWS ITS PANEL, exercised where the boundary lives.
 *
 * Erik's decision 1 (2026-09-25): the crew works the circuit list — add, relabel, place, Planned /
 * Roughed / Done, Verified On Site, Take Off with Undo — and only the office brings circuits in from
 * an estimate or the plans, shows the panel on the customer's page, or takes a panel off a job.
 * Nobody hard-deletes. Nothing on either table carries a price. This speaks to the database AS a
 * tech and AS staff (the 0254 suite's pattern: `set local role authenticated` + planted claims,
 * borrowing an existing active tech and staff member of one org), builds its own customer / jobs /
 * other org around them, and rolls the whole transaction back. Read-back is the assertion, never
 * the absence of an error (the silent-write law).
 *
 * 0333 IS NOT ON PRODUCTION YET, so the suite applies it inside its own transaction (rolled back).
 * Creating the tables takes a SHARE ROW EXCLUSIVE lock on the tables they reference (jobs, quotes,
 * documents, profiles, organizations) until the rollback, so writes to those wait for this suite:
 * it takes its locks with a 3-second lock_timeout, runs one short pass, and rolls back. Once 0333 is
 * applied the migration step is skipped and nothing is locked.
 *
 * Same creds gate as the other DB suites; skips cleanly without them.
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("the job's panel: the crew and the office boundary (0333)", () => {
  let client: pg.Client;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let jobId = "";
  let otherJobId = ""; // another org's job
  let otherPanelId = ""; // another org's panel
  let otherCircuitId = "";
  let quoteId = ""; // this org's estimate with circuits
  let otherQuoteId = ""; // another org's estimate
  let panelId = "";

  const as = async (uid: string) => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await client.query("set local role authenticated");
  };
  const asServer = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
  };
  /** A statement that SHOULD be refused: its SQLSTATE and message, or null if it went through. */
  const refused = async (sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | null> => {
    await client.query("savepoint refused");
    try {
      await client.query(sql, params);
      return null;
    } catch (e: any) {
      return { code: String(e.code), message: String(e.message) };
    } finally {
      await client.query("rollback to savepoint refused");
    }
  };
  const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];

  beforeAll(async () => {
    client = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '15s'");

    const { rows: [has] } = await client.query("select to_regclass('public.job_circuits') is not null as yes");
    if (!has.yes) {
      await client.query(readFileSync(fileURLToPath(new URL("../../supabase/migrations/0333_the_job_knows_its_panel.sql", import.meta.url)), "utf8"));
      console.warn("[panel] 0333 is not on this database yet; applied inside the test's own transaction, which is rolled back.");
    }

    const { rows: fx } = await client.query(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from profiles t
         join profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and s.active
        where t.role = 'tech' and t.active
        limit 1`,
    );
    if (!fx.length) throw new Error("0333 test fixture: no org has both an active tech and an active staff member.");
    ({ org_id: orgId, tech_id: techId, staff_id: staffId } = fx[0]);

    const cust = await one("insert into customers (org_id, name) values ($1, 'TEST 0333 cust') returning id", [orgId]);
    jobId = (
      await one(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1, 'TEST 0333 job', 'TEST-0333-J1', 'scheduled', 'tm', $2) returning id`,
        [orgId, cust.id],
      )
    ).id;
    quoteId = (
      await one(
        `insert into quotes (org_id, customer_id, quote_number, circuits)
         values ($1, $2, 'TEST-0333-Q1', '[{"ckt":"1","description":"Kitchen small-appliance #1","breaker":"20A"}]'::jsonb) returning id`,
        [orgId, cust.id],
      )
    ).id;

    const other = await one("insert into organizations (name) values ('TEST 0333 other org') returning id");
    const ocust = await one("insert into customers (org_id, name) values ($1, 'TEST 0333 other cust') returning id", [other.id]);
    otherJobId = (
      await one(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1, 'TEST 0333 other job', 'TEST-0333-J2', 'scheduled', 'tm', $2) returning id`,
        [other.id, ocust.id],
      )
    ).id;
    otherQuoteId = (await one("insert into quotes (org_id, customer_id, quote_number) values ($1, $2, 'TEST-0333-Q2') returning id", [other.id, ocust.id])).id;
    // As the server (privileged): another org's panel and circuit, the tenant line.
    otherPanelId = (await one("insert into job_panels (job_id, name) values ($1, 'Other Main') returning id", [otherJobId])).id;
    otherCircuitId = (await one("insert into job_circuits (job_id, description, amps) values ($1, 'Other org circuit', 20) returning id", [otherJobId])).id;
  }, 60000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("a tech adds the panel; it is never shown on the customer's page by a tech's hand", async () => {
    await as(techId);
    const p = await one(
      "insert into job_panels (job_id, name, spaces, dead_spaces, twin_spaces, shown_on_portal) values ($1, 'Main Panel', 12, '{9}', '{3,1,3}', true) returning *",
      [jobId],
    );
    panelId = p.id;
    expect(p.org_id).toBe(orgId);
    expect(p.shown_on_portal).toBe(false); // pinned, not refused: the crew's add never bounces
    expect(p.created_by).toBe(techId);
    expect(p.twin_spaces).toEqual([1, 3]); // once each, in order
    const flip = await refused("update job_panels set shown_on_portal = true where id = $1", [panelId]);
    expect(flip?.code).toBe("42501");
    expect(flip?.message).toContain("Only the office can show the panel");
    const off = await refused("update job_panels set removed_at = now() where id = $1", [panelId]);
    expect(off?.code).toBe("42501");
    // A tech's rename lands, stamped as his.
    const r = await client.query("update job_panels set brand = 'Siemens' where id = $1 returning brand, updated_by", [panelId]);
    expect(r.rows).toEqual([{ brand: "Siemens", updated_by: techId }]);
  });

  it("a tech adds, edits, verifies, takes off and puts back a circuit; who and when are the database's", async () => {
    await as(techId);
    const c = await one(
      "insert into job_circuits (job_id, panel_id, room, description, amps, poles, space, verified_by, org_id) values ($1, $2, 'Kitchen', 'Outlets Right', 20, 1, 1, $3, $4) returning *",
      [jobId, panelId, staffId, "00000000-0000-0000-0000-000000000000"],
    );
    expect(c.org_id).toBe(orgId); // the job decides the org, whatever the request said
    expect(c.state).toBe("kept");
    expect(c.source).toBe("hand");
    expect(c.verified_by).toBeNull(); // not verified, so no verifier, forged or not
    const edited = await one("update job_circuits set panel_label = 'Kitchen Right', progress = 'roughed' where id = $1 returning panel_label, progress, updated_by", [c.id]);
    expect(edited).toEqual({ panel_label: "Kitchen Right", progress: "roughed", updated_by: techId });
    const v = await one("update job_circuits set verified = true, verified_by = $2 where id = $1 returning verified, verified_by, verified_at", [c.id, staffId]);
    expect(v.verified).toBe(true);
    expect(v.verified_by).toBe(techId);
    expect(v.verified_at).not.toBeNull();
    // A later edit can't move the stamp.
    const pinned = await one("update job_circuits set verified_by = $2, wire = '12/2' where id = $1 returning verified_by", [c.id, staffId]);
    expect(pinned.verified_by).toBe(techId);
    const off = await one("update job_circuits set removed_at = now() where id = $1 returning removed_at, removed_by", [c.id]);
    expect(off.removed_by).toBe(techId);
    const back = await one("update job_circuits set removed_at = null where id = $1 returning removed_at, removed_by", [c.id]);
    expect(back).toEqual({ removed_at: null, removed_by: null });
    // Provenance and the job are fixed.
    const moved = await one("update job_circuits set job_id = $2, source = 'estimate' where id = $1 returning job_id, source", [c.id, otherJobId]);
    expect(moved).toEqual({ job_id: jobId, source: "hand" });
  });

  it("a tech can't bring circuits in from an estimate or the plans; a machine's circuit lands as a suggestion", async () => {
    await as(techId);
    const est = await refused("insert into job_circuits (job_id, description, source) values ($1, 'From an estimate', 'estimate')", [jobId]);
    expect(est?.code).toBe("42501");
    expect(est?.message).toContain("Only the office brings in circuits");
    const plan = await refused("insert into job_circuits (job_id, description, source) values ($1, 'From the plans', 'plan')", [jobId]);
    expect(plan?.code).toBe("42501");
    const photo = await one("insert into job_circuits (job_id, panel_label, source, state) values ($1, 'Garage', 'photo', 'kept') returning state", [jobId]);
    expect(photo.state).toBe("suggested");
  });

  it("the office brings in from its own estimate as suggestions, once per row; never from another org's", async () => {
    await as(staffId);
    const row = { key: "1|kitchen small-appliance #1|20a||", quote_number: "TEST-0333-Q1" };
    const s = await one(
      "insert into job_circuits (job_id, description, amps, source, source_quote_id, source_row, state) values ($1, 'Kitchen small-appliance #1', 20, 'estimate', $2, $3, 'kept') returning state, source",
      [jobId, quoteId, JSON.stringify(row)],
    );
    expect(s).toEqual({ state: "suggested", source: "estimate" });
    const twice = await refused("insert into job_circuits (job_id, description, source, source_quote_id, source_row) values ($1, 'again', 'estimate', $2, $3)", [
      jobId,
      quoteId,
      JSON.stringify(row),
    ]);
    expect(twice?.code).toBe("23505");
    const foreign = await refused("insert into job_circuits (job_id, description, source, source_quote_id, source_row) values ($1, 'x', 'estimate', $2, '{\"key\":\"z\"}')", [
      jobId,
      otherQuoteId,
    ]);
    expect(foreign?.code).toBe("42501");
    // The office's switch and the office's removal both work.
    expect((await one("update job_panels set shown_on_portal = true where id = $1 returning shown_on_portal", [panelId])).shown_on_portal).toBe(true);
    const gone = await one("update job_panels set removed_at = now() where id = $1 returning removed_by", [panelId]);
    expect(gone.removed_by).toBe(staffId);
    await one("update job_panels set removed_at = null, shown_on_portal = false where id = $1 returning id", [panelId]);
  });

  it("nobody hard-deletes, the tech or the office", async () => {
    await as(techId);
    const t = await refused("delete from job_circuits where job_id = $1", [jobId]);
    expect(t?.code).toBe("42501");
    await as(staffId);
    const s = await refused("delete from job_panels where id = $1", [panelId]);
    expect(s?.code).toBe("42501");
    await asServer();
    expect(Number((await one("select count(*)::int n from job_circuits where job_id = $1", [jobId])).n)).toBeGreaterThan(0);
  });

  it("another org is invisible and unreachable", async () => {
    await as(techId);
    expect((await client.query("select id from job_circuits where id = $1", [otherCircuitId])).rows).toEqual([]);
    expect((await client.query("select id from job_panels where job_id = $1", [otherJobId])).rows).toEqual([]);
    const upd = await client.query("update job_circuits set description = 'mine now' where id = $1 returning id", [otherCircuitId]);
    expect(upd.rowCount).toBe(0);
    const onTheirJob = await refused("insert into job_circuits (job_id, description) values ($1, 'x')", [otherJobId]);
    expect(onTheirJob?.code).toBe("42501");
    const theirPanel = await refused("insert into job_circuits (job_id, panel_id, description) values ($1, $2, 'x')", [jobId, otherPanelId]);
    expect(theirPanel?.code).toBe("42501");
    expect(theirPanel?.message).toContain("That panel is on another job");
    await asServer();
    expect((await one("select description from job_circuits where id = $1", [otherCircuitId])).description).toBe("Other org circuit");
  });

  it("a kept circuit is refused on a No Stab space or past the end; a suggestion there is not, until it is kept", async () => {
    await as(techId);
    const dead = await refused("insert into job_circuits (job_id, panel_id, description, amps, space) values ($1, $2, 'Stairs', 20, 9)", [jobId, panelId]);
    expect(dead?.code).toBe("23514");
    expect(dead?.message).toContain("Space 9 has no stab");
    const pastEnd = await refused("insert into job_circuits (job_id, panel_id, description, amps, poles, space) values ($1, $2, 'Dryer', 30, 2, 11)", [jobId, panelId]);
    expect(pastEnd?.code).toBe("23514");
    expect(pastEnd?.message).toContain("Space 13 is past the end");
    const s = await one("insert into job_circuits (job_id, panel_id, panel_label, space, source) values ($1, $2, 'Read off the photo', 9, 'photo') returning id, state", [jobId, panelId]);
    expect(s.state).toBe("suggested");
    const keep = await refused("update job_circuits set state = 'kept' where id = $1", [s.id]);
    expect(keep?.code).toBe("23514");
    // Two circuits on one space is a WARNING in TypeScript, not a refusal here.
    await one("insert into job_circuits (job_id, panel_id, description, amps, space) values ($1, $2, 'A', 20, 5) returning id", [jobId, panelId]);
    await one("insert into job_circuits (job_id, panel_id, description, amps, space) values ($1, $2, 'B', 20, 5) returning id", [jobId, panelId]);
  });

  it("carries no money, part number or supplier column, and anon can read nothing", async () => {
    await asServer();
    const cols = (
      await client.query(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name in ('job_panels','job_circuits')",
      )
    ).rows.map((r) => r.column_name as string);
    expect(cols.filter((c) => /price|cost|amount|supplier|vendor|part/.test(c))).toEqual([]);
    const anon = await one(
      "select has_table_privilege('anon','public.job_circuits','select') or has_table_privilege('anon','public.job_panels','select') as yes",
    );
    expect(anon.yes).toBe(false);
  });

  it("the estimate a circuit came from can still be deleted: the link empties, the circuit stays", async () => {
    await asServer();
    const before = Number((await one("select count(*)::int n from job_circuits where source_quote_id = $1", [quoteId])).n);
    expect(before).toBeGreaterThan(0);
    const gone = await refused("delete from quotes where id = $1", [quoteId]);
    expect(gone).toBeNull();
    await client.query("delete from quotes where id = $1", [quoteId]);
    const left = await client.query("select source_quote_id, source_row, source from job_circuits where job_id = $1 and source = 'estimate'", [jobId]);
    expect(left.rowCount).toBe(before);
    expect(left.rows.every((r) => r.source_quote_id === null && r.source_row?.key)).toBe(true);
  });
});
