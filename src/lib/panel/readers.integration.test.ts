import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { PANEL_SAYS, NORT_SAYS, readerSuggestions, type ReadRow } from "./readers";

/**
 * THE READERS' WRITES AGAINST 0333, where the boundary lives (Panel plan, phase 4; no migration of
 * its own). What the photo, the plans and Nort write is exactly what readerSuggestions drafts, so
 * this plants those drafts AS a tech and AS the office and reads back what the database kept:
 *
 *   - a tech's panel-photo read lands as suggestions carrying the photo (a document link rides on
 *     a photo's row), even when the request says 'kept';
 *   - a label check (source_row.flag_for) lands as a suggestion and is findable as one;
 *   - Use It changes the circuit only while it still says what the reader saw (a zero-row update
 *     otherwise, which the door reports as "someone just changed it");
 *   - a tech can't write source 'plan' (Read Circuits From The Plans is the office's); the office can;
 *   - Nort's suggestion carries no document, and can't be dressed up as the estimate's;
 *   - a Plan kept on the customer by the estimator's Upload Plans (no job yet) files, and the crew
 *     can read it (plans carry no price; the stash's supplier quotes are never filed).
 *
 * One connection, BEGIN first, everything rolled back. Waits (skips) until 0333 is on the database.
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("the readers' writes (0333's guard, phase 4)", () => {
  let client: pg.Client;
  let waiting = false;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let jobId = "";
  let custId = "";
  let photoId = "";
  let planDocId = "";
  let fridgeId = "";
  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (waiting) return ctx.skip();
      await fn();
    });
  const as = async (uid: string) => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await client.query("set local role authenticated");
  };
  const asServer = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
  };
  const refused = async (sql: string, params: unknown[] = []) => {
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
  /** A reader's drafts, inserted the way lib/panel/suggest-write does. */
  const plant = async (drafts: ReturnType<typeof readerSuggestions>["drafts"], extra: Record<string, unknown> = {}) => {
    const out = [];
    for (const d of drafts) {
      const row = { ...d, job_id: jobId, ...extra };
      const cols = Object.keys(row);
      const vals = cols.map((k) => (k === "source_row" ? JSON.stringify((row as any)[k]) : (row as any)[k]));
      out.push(await one(`insert into job_circuits (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, vals));
    }
    return out;
  };

  beforeAll(async () => {
    client = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await client.connect();
    await assertTestDatabase(client);
    const { rows: [has] } = await client.query("select to_regclass('public.job_circuits') is not null as yes");
    if (!has.yes) {
      waiting = true;
      notOnThisDatabase("[panel readers] 0333 is not on this database yet; the suite waits for it.");
      return;
    }
    await client.query("begin");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '15s'");
    // A TEST company (owner + tech) and a stranger company, minted here and rolled back (never a live one).
    const fx = await mintOrgAndStranger(client, "fixture");
    ({ orgId, techId, staffId } = fx);
    custId = (await one("insert into customers (org_id, name) values ($1, 'TEST P4 cust') returning id", [orgId])).id;
    jobId = (
      await one(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1, 'TEST P4 job', 'TEST-P4-J1', 'scheduled', 'tm', $2) returning id`,
        [orgId, custId],
      )
    ).id;
    photoId = (
      await one("insert into documents (org_id, job_id, name, category, kind, file_url) values ($1, $2, 'panel.jpg', 'Photo', 'other', $3) returning id", [
        orgId,
        jobId,
        `${orgId}/${jobId}/1-panel.jpg`,
      ])
    ).id;
    planDocId = (
      await one("insert into documents (org_id, job_id, name, category, kind, file_url) values ($1, $2, 'E-sheets.pdf', 'Plan', 'other', $3) returning id", [
        orgId,
        jobId,
        `${orgId}/${jobId}/1-E-sheets.pdf`,
      ])
    ).id;
    fridgeId = (await one("insert into job_circuits (job_id, room, description, amps, space, work) values ($1, 'Kitchen', 'Fridge', 20, 12, 'reused') returning id", [jobId])).id;
  }, 60000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  const row = (over: Partial<ReadRow>): ReadRow => ({ space: null, half: null, said: null, room: null, amps: null, poles: 1, kind: null, wire: null, work: "existing", check: null, ...over });

  it("a tech's panel-photo read lands as suggestions with the photo on them, even when the request says kept", async () => {
    await asServer();
    const circuits = (await client.query("select * from job_circuits where job_id = $1", [jobId])).rows;
    const out = readerSuggestions({
      source: "photo",
      rows: [row({ space: 1, said: "Garage", amps: 20 }), row({ space: 12, said: "Mini Fridge", amps: 20 })],
      circuits,
      panelId: null,
      says: PANEL_SAYS,
      startSort: 0,
      stamp: { document_name: "panel.jpg" },
    });
    expect(out.drafts).toHaveLength(2);
    await as(techId);
    const rows = await plant(
      out.drafts.map((d) => ({ ...d, state: "kept" as never })),
      { source_document_id: photoId },
    );
    expect(rows.map((r: any) => [r.state, r.source, r.source_document_id, r.org_id, r.created_by])).toEqual([
      ["suggested", "photo", photoId, orgId, techId],
      ["suggested", "photo", photoId, orgId, techId],
    ]);
    expect(rows[1].source_row).toMatchObject({ flag_for: fridgeId, use: { panel_label: "Mini Fridge" }, was: { panel_label: null } });
    // The keep door's filter finds the check and only the check.
    const checks = (await client.query("select id from job_circuits where job_id = $1 and source_row->>'flag_for' is not null", [jobId])).rows;
    expect(checks.map((c: any) => c.id)).toEqual([rows[1].id]);
    // Nothing kept was touched by the read.
    expect(await one("select panel_label, updated_by from job_circuits where id = $1", [fridgeId])).toEqual({ panel_label: null, updated_by: null });
  });

  it("Use It changes the fridge only while it still says what the reader saw", async () => {
    await as(techId);
    const first = await client.query("update job_circuits set panel_label = 'Mini Fridge' where id = $1 and panel_label is null returning panel_label, updated_by", [fridgeId]);
    expect(first.rows).toEqual([{ panel_label: "Mini Fridge", updated_by: techId }]);
    // A second Use (or a crewmate's stale tap): the condition no longer holds, zero rows, nothing overwritten.
    const again = await client.query("update job_circuits set panel_label = 'Beer Fridge' where id = $1 and panel_label is null returning id", [fridgeId]);
    expect(again.rowCount).toBe(0);
  });

  it("the plans are the office's: a tech can't write source 'plan'; the office's plan read lands as suggestions with the paper", async () => {
    await as(techId);
    const t = await refused("insert into job_circuits (job_id, description, source, source_document_id, source_row) values ($1, 'Bath Floor Heat', 'plan', $2, '{\"key\":\"plan:x\"}')", [
      jobId,
      planDocId,
    ]);
    expect(t?.code).toBe("42501");
    await as(staffId);
    const r = await one(
      "insert into job_circuits (job_id, description, amps, poles, source, source_document_id, source_row) values ($1, 'Bath Floor Heat', 20, 2, 'plan', $2, '{\"key\":\"plan:x\",\"sheet\":\"E-1\",\"ckt\":\"14\"}') returning state, source, source_document_id",
      [jobId, planDocId],
    );
    expect(r).toEqual({ state: "suggested", source: "plan", source_document_id: planDocId });
  });

  it("Nort's suggestion carries no paper and can't pass for the estimate's", async () => {
    await asServer();
    const circuits = (await client.query("select * from job_circuits where job_id = $1", [jobId])).rows;
    const out = readerSuggestions({ source: "nort", rows: [row({ said: "Freezer", feeds: "Freezer", room: "Garage", amps: 20, work: "new" })], circuits, panelId: null, says: NORT_SAYS, startSort: 0 });
    await as(techId);
    const [n] = await plant(out.drafts, { source_document_id: null });
    expect([n.state, n.source, n.description, n.room]).toEqual(["suggested", "nort", "Freezer", "Garage"]);
    const withPaper = await refused("insert into job_circuits (job_id, description, source, source_document_id) values ($1, 'x', 'nort', $2)", [jobId, photoId]);
    expect(withPaper?.code).toBe("42501");
    const asEstimate = await refused("insert into job_circuits (job_id, description, source, source_row) values ($1, 'x', 'nort', '{\"key\":\"k\",\"quote_number\":\"E-017\"}')", [jobId]);
    expect(asEstimate?.code).toBe("42501");
  });

  it("a Plan kept on the customer (no job yet) files, and the crew can read it", async () => {
    await as(staffId);
    const doc = await one(
      "insert into documents (org_id, job_id, customer_id, name, category, kind, file_url, size_bytes, uploaded_by) values ($1, null, $2, 'Herringbone plans.pdf', 'Plan', 'other', $3, 412000, $4) returning id, org_id, job_id, customer_id",
      [orgId, custId, `${orgId}/customers/${custId}/1-Herringbone_plans.pdf`, staffId],
    );
    expect(doc).toMatchObject({ org_id: orgId, job_id: null, customer_id: custId });
    await as(techId);
    const seen = (await client.query("select id from documents where id = $1", [doc.id])).rows;
    expect(seen).toHaveLength(1);
  });
});
