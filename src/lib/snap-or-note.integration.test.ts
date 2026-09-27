import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * SNAP OR NOTE, WHERE IT MEETS THE DATABASE (W1-30), exercised as a crew member and as the office.
 *
 * The one paper door leans on four things the database decides, not the screen:
 *   · the one note writer (saveVoiceNote) now inserts with `.select("id")` and treats no row back
 *     as "didn't save" (the silent-write law). A TECH's note must come back to him: organized_items
 *     lets a non-staff member read the rows he created (0201), and the org is stamped by trigger.
 *     If that read-back failed, every tech note would say "didn't save" over a note that did.
 *   · a tech's note is his own: another tech (or another company) never reads it; the office does.
 *   · a tech's photo is filed on his job through the job's own door (captureReceipt -> addDocument):
 *     a documents row with uploaded_by him, read back the same way.
 *   · the sheet's context reads his own open punch and the jobs' labels, which the crew may read.
 *
 * Inside ONE transaction that is always rolled back, on two TEST companies minted here (never a
 * live one). Impersonation is the billing and materials suites' own: `set local role authenticated`
 * and planted request.jwt.claims, the setting auth.uid() reads. Read-back is the assertion.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("Snap Or Note: a tech's note, his photo's job document, his punch and his jobs", () => {
  let c: pg.Client;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let otherStaffId = "";
  let jobId = "";

  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const rows = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  /** The saveVoiceNote insert, as PostgREST runs it for .insert(...).select("id"). */
  const saveNote = async (by: string, text: string) =>
    rows(
      `insert into organized_items (kind, title, summary, category, confidence, status, file_url, created_by)
       values ('note', $1, $1, 'Note', 'high', 'needs_review', null, $2) returning id`,
      [text, by],
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    const fx = await mintOrgAndStranger(c, "snap-or-note");
    orgId = fx.orgId;
    techId = fx.techId;
    staffId = fx.staffId;
    otherStaffId = fx.otherStaffId;
    jobId = (
      await one(
        "insert into jobs (org_id, name, job_number, status, billing_type) values ($1, 'TEST snap job', 'TEST-SNAP-J1', 'in_progress', 'tm') returning id",
        [orgId],
      )
    ).id;
    await one(
      "insert into time_entries (org_id, profile_id, job_id, clock_in, status) values ($1, $2, $3, now() - interval '1 hour', 'open') returning id",
      [orgId, techId, jobId],
    );
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("a tech's note comes back to him with its id (the .select('id') read-back), stamped with his company", async () => {
    await as(techId);
    const back = await saveNote(techId, "TEST need more 12/2 at the snap job");
    expect(back).toHaveLength(1);
    await asServer();
    const row = await one("select org_id::text as org_id, created_by::text as created_by, status, kind from organized_items where id = $1", [back[0].id]);
    expect(row).toEqual({ org_id: orgId, created_by: techId, status: "needs_review", kind: "note" });
  });

  it("the office's note comes back too; a tech never reads the office's note, and another company reads neither", async () => {
    await as(staffId);
    const staffNote = await saveNote(staffId, "TEST call the inspector");
    expect(staffNote).toHaveLength(1);
    await as(techId);
    const techSees = await rows("select id from organized_items where id = $1", [staffNote[0].id]);
    expect(techSees).toHaveLength(0);
    await as(staffId);
    const officeSees = await rows("select count(*)::int as n from organized_items where org_id = $1 and kind = 'note'", [orgId]);
    expect(officeSees[0].n).toBeGreaterThanOrEqual(2);
    await as(otherStaffId);
    const strangerSees = await rows("select id from organized_items where org_id = $1", [orgId]);
    expect(strangerSees).toHaveLength(0);
    await asServer();
  });

  it("a tech can't write a note as someone else", async () => {
    await as(techId);
    await c.query("savepoint forged");
    let code: string | null = null;
    try {
      await saveNote(staffId, "TEST forged");
    } catch (e) {
      code = String((e as { code?: string }).code);
    } finally {
      await c.query("rollback to savepoint forged");
    }
    expect(code).toBe("42501");
    await asServer();
  });

  it("his photo files on his job as a documents row he uploaded, read back (captureReceipt's addDocument)", async () => {
    await as(techId);
    const doc = await rows(
      `insert into documents (job_id, name, category, kind, file_url, size_bytes, uploaded_by)
       values ($1, 'TEST ticket.jpg', 'Receipt', 'other', $2, 1234, $3) returning id`,
      [jobId, `${orgId}/${jobId}/1-TEST_ticket.jpg`, techId],
    );
    expect(doc).toHaveLength(1);
    await asServer();
    expect(await one("select org_id::text as org_id, job_id::text as job_id, category from documents where id = $1", [doc[0].id])).toEqual({
      org_id: orgId,
      job_id: jobId,
      category: "Receipt",
    });
  });

  it("the sheet's context: his own open punch's job, and the jobs' labels, read as him", async () => {
    await as(techId);
    const punch = await rows("select job_id::text as job_id from time_entries where org_id = $1 and profile_id = $2 and status = 'open' limit 1", [orgId, techId]);
    expect(punch).toEqual([{ job_id: jobId }]);
    const jobs = await rows(
      "select id::text as id, job_number, name from jobs where org_id = $1 and status in ('to_be_scheduled','scheduled','in_progress','on_hold') order by created_at desc limit 500",
      [orgId],
    );
    expect(jobs.map((j) => j.id)).toContain(jobId);
    await asServer();
  });
});
