import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

/**
 * Migration 0254 — the crew's materials-list boundary, exercised where it actually lives.
 *
 * Erik (2026-09-11): a tech works the job's ONE materials list — add / edit / remove lines, tick
 * purchased — and never touches money. The UI hides est_cost / vendor / is_tool from a tech, but
 * a hidden input is a convention: a PATCH with the tech's own session token walks past it. The
 * boundary is the RLS policy (which ROWS) plus the pin_material_money_columns trigger (which
 * COLUMNS), so this test speaks to the database AS a tech and AS staff and reads back what landed.
 * "One" is literal too: everyone reads the NEWEST list on a job, so a tech may start the list
 * only while the job has none — a second one would displace the office's take-off for the org.
 *
 * How it impersonates: the pooler user is `postgres`, a member of `authenticated`, so inside one
 * transaction it can `set local role authenticated` and plant request.jwt.claims — the exact
 * setting auth.uid() reads under PostgREST. It borrows an EXISTING active tech and an existing
 * active staff member of the same org (nothing is minted in auth.users), builds its own customer /
 * job / lists / lines around them, and rolls the whole transaction back — the billing test's
 * pattern. Read-back is the assertion, never the absence of an error: an UPDATE the policy hides
 * is a clean 0-row 204 (the silent-write law), so each check counts rows or reads the column.
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("material lists: the crew boundary (0254)", () => {
  let client: pg.Client;
  // The fixture, all inside the one transaction.
  let orgId = "";
  let techId = "";
  let staffId = "";
  let jobId = ""; // a job that already has its list
  let jobListId = ""; // the job's list — the crew's door
  let pricedLineId = ""; // a line the office priced: est_cost 12.34, vendor CED
  let freshJobId = ""; // a job with no list yet — the one the tech may start
  let bareJobId = ""; // a job with no list that never gets one — refusals here are for their own reason
  let noJobListId = ""; // a list with no job (a quote's take-off before the quote has a job) — staff-only
  let otherListId = ""; // another org's job list
  let otherLineId = "";
  let otherJobId = ""; // another org's job, carrying otherListId
  let otherBareJobId = ""; // another org's job with no list — foreignness is the only reason to refuse

  /** Speak as this user: the claims auth.uid() reads, under the role PostgREST uses. */
  const as = async (uid: string) => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
  };
  /** Back to the direct connection: no claims (is_privileged_writer → true), RLS bypassed. */
  const asServer = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run a statement that SHOULD be refused. Returns the SQLSTATE, or null if it went through.
   *  Wrapped in a savepoint so a refusal doesn't abort the shared transaction — and so a write
   *  that wrongly succeeded is undone rather than polluting the checks after it. */
  const refused = async (sql: string, params: unknown[]): Promise<string | null> => {
    await client.query("savepoint refused");
    try {
      await client.query(sql, params);
      return null;
    } catch (e: any) {
      return String(e.code);
    } finally {
      await client.query("rollback to savepoint refused");
    }
  };
  const RLS_REFUSAL = "42501"; // insufficient_privilege — "new row violates row-level security policy"

  beforeAll(async () => {
    client = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query("begin");

    // An org that has BOTH an active tech and active staff. Without one the boundary can't be
    // exercised, and that has to be a loud failure, not a green skip (tests/ci-guard.test.ts).
    const { rows: fx } = await client.query(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from profiles t
         join profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and s.active
        where t.role = 'tech' and t.active
        limit 1`,
    );
    if (!fx.length) {
      throw new Error(
        "0254 test fixture: no org has both an active tech and an active staff member — the crew boundary cannot be exercised.",
      );
    }
    orgId = fx[0].org_id;
    techId = fx[0].tech_id;
    staffId = fx[0].staff_id;

    // The org's job, its list, and a line the office priced.
    const { rows: [cust] } = await client.query(
      "insert into customers (org_id, name) values ($1, 'TEST 0254 cust') returning id",
      [orgId],
    );
    const { rows: [job] } = await client.query(
      `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
       values ($1, 'TEST 0254 job', 'TEST-0254-J1', 'scheduled', 'tm', $2) returning id`,
      [orgId, cust.id],
    );
    jobId = job.id;
    const { rows: [jl] } = await client.query(
      "insert into material_lists (org_id, name, job_id) values ($1, 'TEST 0254 job list', $2) returning id",
      [orgId, jobId],
    );
    jobListId = jl.id;
    const { rows: [pl] } = await client.query(
      `insert into material_list_items (org_id, list_id, description, quantity, est_cost, vendor, is_tool)
       values ($1, $2, 'Priced by the office', 2, 12.34, 'CED', false) returning id, est_cost`,
      [orgId, jobListId],
    );
    pricedLineId = pl.id;
    expect(Number(pl.est_cost)).toBe(12.34); // the direct connection is a privileged writer: price kept

    // Two more jobs in the org with NO list: one the tech will start, one that stays bare so a
    // refusal on it can only be about the thing under test, never about a list already there.
    const { rows: [fresh] } = await client.query(
      `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
       values ($1, 'TEST 0254 fresh job', 'TEST-0254-J3', 'scheduled', 'tm', $2) returning id`,
      [orgId, cust.id],
    );
    freshJobId = fresh.id;
    const { rows: [bare] } = await client.query(
      `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
       values ($1, 'TEST 0254 bare job', 'TEST-0254-J4', 'scheduled', 'tm', $2) returning id`,
      [orgId, cust.id],
    );
    bareJobId = bare.id;

    // A list with no job in the same org — a quote's take-off before the quote has a job
    // (job_id null): staff-only by design.
    const { rows: [quote] } = await client.query(
      "insert into quotes (org_id, customer_id, quote_number) values ($1, $2, 'TEST-0254-Q1') returning id",
      [orgId, cust.id],
    );
    const { rows: [nl] } = await client.query(
      "insert into material_lists (org_id, name, quote_id) values ($1, 'TEST 0254 list with no job', $2) returning id",
      [orgId, quote.id],
    );
    noJobListId = nl.id;

    // Another org's job list — the tenant line.
    const { rows: [other] } = await client.query(
      "insert into organizations (name) values ('TEST 0254 other org') returning id",
    );
    const { rows: [ocust] } = await client.query(
      "insert into customers (org_id, name) values ($1, 'TEST 0254 other cust') returning id",
      [other.id],
    );
    const { rows: [ojob] } = await client.query(
      `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
       values ($1, 'TEST 0254 other job', 'TEST-0254-J2', 'scheduled', 'tm', $2) returning id`,
      [other.id, ocust.id],
    );
    otherJobId = ojob.id;
    const { rows: [ol] } = await client.query(
      "insert into material_lists (org_id, name, job_id) values ($1, 'TEST 0254 other list', $2) returning id",
      [other.id, otherJobId],
    );
    otherListId = ol.id;
    const { rows: [oline] } = await client.query(
      "insert into material_list_items (org_id, list_id, description) values ($1, $2, 'Other org line') returning id",
      [other.id, otherListId],
    );
    otherLineId = oline.id;
    const { rows: [obare] } = await client.query(
      `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
       values ($1, 'TEST 0254 other bare job', 'TEST-0254-J5', 'scheduled', 'tm', $2) returning id`,
      [other.id, ocust.id],
    );
    otherBareJobId = obare.id;
  });

  afterAll(async () => {
    try {
      await client?.query("rollback");
    } finally {
      await client?.end();
    }
  });

  // ── the boundary is bound ──────────────────────────────────────────────────────────────────
  it("the money-pin trigger is bound to material_list_items INSERT and UPDATE, and enabled", async () => {
    await asServer();
    const { rows } = await client.query(
      `select tgenabled, pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.material_list_items'::regclass and not tgisinternal
          and tgname = 'pin_material_money_columns'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tgenabled).not.toBe("D"); // never shipped disabled
    expect(rows[0].def).toMatch(/BEFORE INSERT OR UPDATE/);
    // Closed to anon for real: PUBLIC's default EXECUTE is revoked too, not just anon's own grant.
    const { rows: acl } = await client.query(
      "select has_function_privilege('anon', 'public.pin_material_money_columns()', 'execute') as anon_can_run",
    );
    expect(acl[0].anon_can_run).toBe(false);
  });

  it("the write rule keeps staff and opens JOB lists to the crew; lists stay staff-only to change", async () => {
    await asServer();
    const { rows } = await client.query(
      `select tablename, policyname, cmd, coalesce(qual,'') as qual, coalesce(with_check,'') as with_check
         from pg_policies where schemaname = 'public'
          and tablename in ('material_lists','material_list_items')`,
    );
    const items = rows.find((r: any) => r.policyname === "material_list_items_write");
    expect(items?.cmd).toBe("ALL");
    expect(items?.qual).toMatch(/is_org_staff\(\)/);
    expect(items?.qual).toMatch(/job_id IS NOT NULL/);
    expect(items?.with_check).toMatch(/job_id IS NOT NULL/);
    const crew = rows.find((r: any) => r.policyname === "material_lists_crew_insert");
    expect(crew?.cmd).toBe("INSERT");
    expect(crew?.with_check).toMatch(/quote_id IS NULL/);
    expect(crew?.with_check).toMatch(/work_order_id IS NULL/);
    // "Just one, the same one": the crew starts a list only while the job has none, and the
    // check reads the whole table through the owner-side helper, never the policy's own table.
    expect(crew?.with_check).toMatch(/NOT job_has_material_list\(/);
    // The staff FOR ALL policy on lists is untouched — it is the only door for rename/relink/delete.
    const lists = rows.find((r: any) => r.policyname === "material_lists_write");
    expect(lists?.cmd).toBe("ALL");
    expect(lists?.qual).toMatch(/is_org_staff\(\)/);
  });

  it("the list-exists helper is owner-side and closed to anon (0246)", async () => {
    await asServer();
    const { rows } = await client.query(
      `select p.prosecdef as secdef,
              has_function_privilege('anon', p.oid, 'execute') as anon_can_run,
              has_function_privilege('authenticated', p.oid, 'execute') as authed_can_run
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'job_has_material_list'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].secdef).toBe(true); // reads as the owner: the whole table, not the caller's view
    expect(rows[0].anon_can_run).toBe(false);
    expect(rows[0].authed_can_run).toBe(true); // the policy calls it on the crew's behalf
  });

  // ── as a TECH ──────────────────────────────────────────────────────────────────────────────
  it("a tech adds a line to the job's list — and the price, vendor and tool flag it carried are dropped", async () => {
    await as(techId);
    const { rows } = await client.query(
      `insert into material_list_items (list_id, description, quantity, unit, est_cost, vendor, is_tool)
       values ($1, 'Crew added: 3/4in EMT', 10, 'ea', 99.99, 'Home Depot', true)
       returning id, org_id, description, quantity, est_cost, vendor, is_tool`,
      [jobListId],
    );
    expect(rows.length).toBe(1); // the row came back — the write is real, not a 204
    expect(rows[0].org_id).toBe(orgId); // stamped to the tech's own org
    expect(rows[0].description).toBe("Crew added: 3/4in EMT");
    expect(Number(rows[0].quantity)).toBe(10);
    expect(rows[0].est_cost).toBeNull(); // null BY DESIGN — a tech never writes a price
    expect(rows[0].vendor).toBeNull();
    expect(rows[0].is_tool).toBe(false);
  });

  it("a tech edits an office-priced line: the edit lands, the money survives", async () => {
    await as(techId);
    const { rows } = await client.query(
      `update material_list_items
          set description = 'Priced by the office — crew edit', quantity = 3,
              est_cost = 1, vendor = 'Somewhere else', is_tool = true
        where id = $1
        returning id, description, quantity, est_cost, vendor, is_tool`,
      [pricedLineId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].description).toBe("Priced by the office — crew edit");
    expect(Number(rows[0].quantity)).toBe(3);
    expect(Number(rows[0].est_cost)).toBe(12.34); // the old value, pinned by the trigger
    expect(rows[0].vendor).toBe("CED");
    expect(rows[0].is_tool).toBe(false);
  });

  it("a tech ticks a line purchased, and removes a line", async () => {
    await as(techId);
    const { rows: ticked } = await client.query(
      `update material_list_items set purchased = true, purchased_at = now()
        where id = $1 returning id, purchased`,
      [pricedLineId],
    );
    expect(ticked.length).toBe(1);
    expect(ticked[0].purchased).toBe(true);

    const { rows: [mine] } = await client.query(
      "insert into material_list_items (list_id, description) values ($1, 'Crew added, then removed') returning id",
      [jobListId],
    );
    const { rows: gone } = await client.query(
      "delete from material_list_items where id = $1 returning id",
      [mine.id],
    );
    expect(gone.length).toBe(1);
  });

  it("a tech cannot write a line on a list with no job (a quote's take-off is not theirs to shop)", async () => {
    await as(techId);
    expect(
      await refused(
        "insert into material_list_items (list_id, description) values ($1, 'Crew on a list with no job') returning id",
        [noJobListId],
      ),
    ).toBe(RLS_REFUSAL);
  });

  it("a tech cannot rename, relink or delete a list", async () => {
    await as(techId);
    const { rows: renamed } = await client.query(
      "update material_lists set name = 'renamed by crew' where id = $1 returning id",
      [jobListId],
    );
    expect(renamed.length).toBe(0); // hidden by the policy: a clean zero-row write
    const { rows: relinked } = await client.query(
      "update material_lists set job_id = null where id = $1 returning id",
      [jobListId],
    );
    expect(relinked.length).toBe(0);
    const { rows: deleted } = await client.query(
      "delete from material_lists where id = $1 returning id",
      [jobListId],
    );
    expect(deleted.length).toBe(0);
  });

  it("a tech cannot touch another org's list or lines (zero rows, no refusal to learn from)", async () => {
    await as(techId);
    const { rows: seen } = await client.query("select id from material_lists where id = $1", [otherListId]);
    expect(seen.length).toBe(0);
    expect(
      await refused(
        "insert into material_list_items (list_id, description) values ($1, 'Cross-org line') returning id",
        [otherListId],
      ),
    ).toBe(RLS_REFUSAL);
    const { rows: updated } = await client.query(
      "update material_list_items set description = 'x' where id = $1 returning id",
      [otherLineId],
    );
    expect(updated.length).toBe(0);
    const { rows: deleted } = await client.query(
      "delete from material_list_items where id = $1 returning id",
      [otherLineId],
    );
    expect(deleted.length).toBe(0);
  });

  it("a tech can start the job's list when it has none (ensureJobMaterialList) and write to it", async () => {
    await as(techId);
    // Exactly the shape ensureJobMaterialList sends: no org_id (stamp_org fills it), created_by = self.
    const { rows: [list] } = await client.query(
      "insert into material_lists (name, job_id, created_by) values ('Materials — TEST-0254-J3', $1, $2) returning id, org_id",
      [freshJobId, techId],
    );
    expect(list?.id).toBeTruthy();
    expect(list.org_id).toBe(orgId);
    const { rows: line } = await client.query(
      "insert into material_list_items (list_id, description) values ($1, 'First line on a crew-started list') returning id",
      [list.id],
    );
    expect(line.length).toBe(1);
  });

  it("a tech cannot start a second list on a job that already has one (newest wins, so a second would displace the office's take-off)", async () => {
    await as(techId);
    // The job the office already listed and priced — the createMaterialList POST shape.
    expect(
      await refused(
        "insert into material_lists (name, job_id, created_by) values ('a second list beside the office''s', $1, $2) returning id",
        [jobId, techId],
      ),
    ).toBe(RLS_REFUSAL);
    // And the job the tech just started a list on: not even its author gets a second.
    expect(
      await refused(
        "insert into material_lists (name, job_id, created_by) values ('a second list beside my own', $1, $2) returning id",
        [freshJobId, techId],
      ),
    ).toBe(RLS_REFUSAL);
    // Nothing landed: the job still carries exactly the one list the office made.
    await asServer();
    const { rows } = await client.query(
      "select count(*)::int as n from material_lists where job_id = $1",
      [jobId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a tech cannot start a list on a quote, on another org's job, or under someone else's name", async () => {
    await as(techId);
    // Every job here has NO list, so each refusal is for the reason named, not for a list in the way.
    const { rows: [quote] } = await client.query(
      "select quote_id from material_lists where id = $1",
      [noJobListId],
    );
    expect(
      await refused(
        "insert into material_lists (name, job_id, quote_id) values ('crew list on a quote', $1, $2) returning id",
        [bareJobId, quote.quote_id],
      ),
    ).toBe(RLS_REFUSAL);
    expect(
      await refused(
        "insert into material_lists (name, job_id) values ('crew list on a foreign job', $1) returning id",
        [otherBareJobId],
      ),
    ).toBe(RLS_REFUSAL);
    expect(
      await refused(
        "insert into material_lists (name, job_id, created_by) values ('crew list as someone else', $1, $2) returning id",
        [bareJobId, staffId],
      ),
    ).toBe(RLS_REFUSAL);
  });

  it("a tech still reads the job's list and its lines (0056, unchanged)", async () => {
    await as(techId);
    const { rows } = await client.query(
      "select count(*)::int as n from material_list_items where list_id = $1",
      [jobListId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  // ── as STAFF: nothing they had is gone ─────────────────────────────────────────────────────
  it("staff still write prices, vendors and tool flags on new and existing lines", async () => {
    await as(staffId);
    const { rows: added } = await client.query(
      `insert into material_list_items (list_id, description, est_cost, vendor, is_tool)
       values ($1, 'Office line', 5.5, 'CED', true) returning est_cost, vendor, is_tool`,
      [jobListId],
    );
    expect(added.length).toBe(1);
    expect(Number(added[0].est_cost)).toBe(5.5);
    expect(added[0].vendor).toBe("CED");
    expect(added[0].is_tool).toBe(true);

    const { rows: repriced } = await client.query(
      "update material_list_items set est_cost = 20, vendor = 'Platt' where id = $1 returning est_cost, vendor",
      [pricedLineId],
    );
    expect(repriced.length).toBe(1);
    expect(Number(repriced[0].est_cost)).toBe(20);
    expect(repriced[0].vendor).toBe("Platt");
  });

  it("staff still write lists with no job, add a second list to a job, rename and delete lists", async () => {
    await as(staffId);
    const { rows: noJob } = await client.query(
      "insert into material_list_items (list_id, description, est_cost) values ($1, 'Office on a list with no job', 3) returning id, est_cost",
      [noJobListId],
    );
    expect(noJob.length).toBe(1);
    expect(Number(noJob[0].est_cost)).toBe(3);
    // The office keeps its freedom to land a second list on a job (a take-off after a hand-made
    // list is the documented case) — the "no list yet" clause binds the crew door only.
    const { rows: second } = await client.query(
      "insert into material_lists (name, job_id, created_by) values ('Office take-off, landing second', $1, $2) returning id",
      [jobId, staffId],
    );
    expect(second.length).toBe(1);
    const { rows: renamed } = await client.query(
      "update material_lists set name = 'renamed by the office' where id = $1 returning id",
      [jobListId],
    );
    expect(renamed.length).toBe(1);
    const { rows: deleted } = await client.query(
      "delete from material_lists where id = $1 returning id",
      [noJobListId],
    );
    expect(deleted.length).toBe(1);
  });

  it("staff are still held to their own org", async () => {
    await as(staffId);
    const { rows } = await client.query(
      "update material_lists set name = 'x' where id = $1 returning id",
      [otherListId],
    );
    expect(rows.length).toBe(0);
  });
});
