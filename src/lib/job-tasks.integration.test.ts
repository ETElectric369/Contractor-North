import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

const MIGRATION_0358 = "0358_a_job_has_one_task_list.sql";
// The test database's steps and their md5s, as rebuild.cjs records them (one list, steps.cjs).
const { stepsOnDisk } = createRequire(import.meta.url)("../../scripts/test-db/steps.cjs") as {
  stepsOnDisk: () => { name: string; md5: string }[];
};

/**
 * Migration 0358 — a job has one task list, exercised where the boundary lives.
 *
 * Erik, 2026-09-26: a task belongs to the JOB (no assignee; the crew lead hands them out out loud);
 * the check-off records who and when; a Reminder (no job) is private to its maker and its person; a
 * tech can check an office task off but never delete it. The app says all of this; the database is
 * what makes it true against a PATCH carrying a tech's own token. So this suite speaks to the
 * database AS a tech, AS the office, AS another tech and AS another company's owner, and reads back
 * what landed. Read-back is the assertion, never the absence of an error (a zero-row UPDATE is a clean
 * 204: the silent-write law).
 *
 * How it impersonates: the pooler user is `postgres`, a member of `authenticated`, so inside one
 * transaction it can `set local role authenticated` and plant request.jwt.claims (what auth.uid()
 * reads). Everything is minted inside the one transaction — a TEST company (owner + two techs) and a
 * TEST stranger company — and rolled back (throwaway-org.db-fixture). If 0358 is not on this database
 * yet, or the database's is older than the file (its recorded md5 differs), the file is applied inside
 * that same transaction, rolled back with it (the materials-crew-boundary suite's pattern); applying
 * this 0358 to the test database turns that into a no-op.
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("tasks: a job has one task list, and a Reminder is private (0358)", () => {
  let client: pg.Client;
  let orgId = "";
  let officeId = ""; // the company's owner: office staff
  let techId = ""; // Brian
  let tech2Id = ""; // another tech on the same crew
  let jobId = "";
  let job2Id = ""; // a second job of the same company
  let otherOrgId = "";
  let strangerId = ""; // another company's owner
  let otherJobId = "";
  let officeTaskId = ""; // a job task the office added
  let orphanReminderId = ""; // a legacy Reminder with no maker and no person

  const as = async (uid: string) => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await client.query("set local role authenticated");
  };
  const asServer = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
  };
  /** A statement that SHOULD be refused: its SQLSTATE and message, or null if it went through (then
   *  undone, so a wrong success can't pollute the checks after it). */
  const refused = async (sql: string, params: unknown[]): Promise<{ code: string; message: string } | null> => {
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
  /** Read a task as the server (RLS off): what really landed. */
  const landed = async (id: string) => {
    await asServer();
    const { rows } = await client.query(
      `select id, status, created_by, created_at, completed_at, done_by, photo_path, done_photo_path, job_id, title,
              (select now()) as txn_now
         from tasks where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  };

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
    await assertTestDatabase(client);
    await client.query("begin");

    // THIS FILE's 0358, not just any: the ledger's md5 (rebuild.cjs, steps.cjs) says whether the
    // database carries the migration as it is on disk. Missing, or applied before an edit: the file is
    // applied inside this transaction (it is safe to re-run) and rolled back with it.
    const { rows: [has] } = await client.query(
      "select exists (select 1 from pg_trigger where tgname = 'tasks_stamp_who' and tgrelid = 'public.tasks'::regclass) as yes, to_regclass('public.cn_test_migrations') is not null as ledger",
    );
    const step = stepsOnDisk().find((s) => s.name === MIGRATION_0358);
    const recorded = has.ledger
      ? (((await client.query("select md5 from public.cn_test_migrations where name = $1", [MIGRATION_0358])).rows[0]?.md5 ?? null) as string | null)
      : null;
    if (!has.yes || !step || recorded !== step.md5) {
      await client.query(readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${MIGRATION_0358}`, import.meta.url)), "utf8"));
      console.warn(
        has.yes
          ? "[job-tasks] this database's 0358 isn't the file on disk (edited since it was applied); the file was applied inside the test's own transaction, which is rolled back."
          : "[job-tasks] 0358 is not on this database yet; applied inside the test's own transaction, which is rolled back.",
      );
    }

    const org = await mintThrowawayOrg(client, { label: "0358", techs: 2 });
    orgId = org.orgId;
    officeId = org.owner.id;
    techId = org.techs[0].id;
    tech2Id = org.techs[1].id;
    const other = await mintThrowawayOrg(client, { label: "0358 stranger", techs: 0 });
    otherOrgId = other.orgId;
    strangerId = other.owner.id;

    await asServer();
    const { rows: [cust] } = await client.query("insert into customers (org_id, name) values ($1, 'TEST 0358 cust') returning id", [orgId]);
    const mkJob = async (org: string, customer: string, n: string) =>
      (
        await client.query(
          `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
           values ($1, $2, $3, 'in_progress', 'tm', $4) returning id`,
          [org, `TEST 0358 ${n}`, `TEST-0358-${n}`, customer],
        )
      ).rows[0].id as string;
    jobId = await mkJob(orgId, cust.id, "J1");
    job2Id = await mkJob(orgId, cust.id, "J2");
    const { rows: [ocust] } = await client.query("insert into customers (org_id, name) values ($1, 'TEST 0358 other cust') returning id", [otherOrgId]);
    otherJobId = await mkJob(otherOrgId, ocust.id, "OJ");

    // The office adds a job task (as the office, through RLS).
    await as(officeId);
    officeTaskId = (
      await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 hang the panel') returning id", [jobId])
    ).rows[0].id;

    // A legacy Reminder with no maker and no person, written as the server (a privileged writer keeps
    // what it writes).
    await asServer();
    orphanReminderId = (
      await client.query("insert into tasks (org_id, title, created_by) values ($1, 'TEST 0358 orphan', null) returning id", [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await client?.query("rollback");
    } finally {
      await client?.end();
    }
  });

  // ── the boundary is bound ──────────────────────────────────────────────────────────────────
  it("the stamp trigger is bound BEFORE INSERT OR UPDATE and enabled; its helpers are closed to anon", async () => {
    await asServer();
    const { rows } = await client.query(
      `select tgenabled, pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.tasks'::regclass and tgname = 'tasks_stamp_who'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tgenabled).not.toBe("D");
    expect(rows[0].def).toMatch(/BEFORE INSERT OR UPDATE/);
    const { rows: acl } = await client.query(
      `select has_function_privilege('anon', 'public.stamp_task_who()', 'execute') as a,
              has_function_privilege('anon', 'public.task_photo_path_ok(text, uuid)', 'execute') as b`,
    );
    expect(acl[0]).toEqual({ a: false, b: false });
    const { rows: pols } = await client.query("select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'tasks' order by policyname");
    expect(pols.map((p: any) => `${p.policyname}:${p.cmd}`)).toEqual([
      "tasks_delete:DELETE",
      "tasks_insert:INSERT",
      "tasks_read:SELECT",
      "tasks_update:UPDATE",
    ]);
  });

  // ── who added it, who checked it off, when: the server's ──────────────────────────────────
  it("a new task's maker is the caller, whatever the request says; an open task carries no who or when", async () => {
    await as(techId);
    const { rows: [t] } = await client.query(
      `insert into tasks (job_id, title, created_by, created_at, done_by, completed_at, status)
       values ($1, 'TEST 0358 forged insert', $2, '2020-01-01', $2, '2020-01-01', 'open') returning id`,
      [jobId, officeId],
    );
    const r = await landed(t.id);
    expect(r.created_by).toBe(techId);
    expect(new Date(r.created_at).getTime()).toBe(new Date(r.txn_now).getTime());
    expect(r.done_by).toBeNull();
    expect(r.completed_at).toBeNull();
  });

  it("checking off stamps the person asking and now — a forged done_by / completed_at is ignored", async () => {
    await as(techId);
    const { rowCount } = await client.query(
      "update tasks set status = 'done', done_by = $2, completed_at = '2020-01-01' where id = $1",
      [officeTaskId, officeId],
    );
    expect(rowCount).toBe(1); // anyone on the job checks an office task off
    const r = await landed(officeTaskId);
    expect(r.status).toBe("done");
    expect(r.done_by).toBe(techId);
    expect(new Date(r.completed_at).getTime()).toBe(new Date(r.txn_now).getTime());
    expect(r.created_by).toBe(officeId); // who added it never changes
  });

  it("while it stays done, nobody can move who or when — not the office either", async () => {
    const before = await landed(officeTaskId);
    await as(officeId);
    await client.query(
      "update tasks set done_by = $2, completed_at = '2020-01-01', created_by = $2, created_at = '2020-01-01', title = 'TEST 0358 hang the panel (renamed)' where id = $1",
      [officeTaskId, officeId],
    );
    const r = await landed(officeTaskId);
    expect(r.title).toBe("TEST 0358 hang the panel (renamed)"); // the edit itself lands
    expect(r.done_by).toBe(before.done_by);
    expect(new Date(r.completed_at).getTime()).toBe(new Date(before.completed_at).getTime());
    expect(r.created_by).toBe(before.created_by);
    expect(new Date(r.created_at).getTime()).toBe(new Date(before.created_at).getTime());
  });

  it("an open task can't be given a who or a when by an update, either", async () => {
    await as(techId);
    const { rows: [t] } = await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 still open') returning id", [jobId]);
    await client.query("update tasks set done_by = $2, completed_at = now() where id = $1", [t.id, officeId]);
    const r = await landed(t.id);
    expect(r.status).toBe("open");
    expect(r.done_by).toBeNull();
    expect(r.completed_at).toBeNull();
  });

  it("reopening clears who, when and the done photo", async () => {
    await as(techId);
    await client.query("update tasks set done_photo_path = $2 where id = $1", [officeTaskId, `${orgId}/${jobId}/done.jpg`]);
    expect((await landed(officeTaskId)).done_photo_path).toBe(`${orgId}/${jobId}/done.jpg`);
    await as(tech2Id);
    await client.query("update tasks set status = 'open' where id = $1", [officeTaskId]);
    const r = await landed(officeTaskId);
    expect(r.status).toBe("open");
    expect(r.done_by).toBeNull();
    expect(r.completed_at).toBeNull();
    expect(r.done_photo_path).toBeNull();
    // Checked off again: the new person, the new time (landed() read as the server; speak as tech 2).
    await as(tech2Id);
    await client.query("update tasks set status = 'done' where id = $1", [officeTaskId]);
    expect((await landed(officeTaskId)).done_by).toBe(tech2Id);
  });

  // ── a job task names this company's job ────────────────────────────────────────────────────
  it("a job task must name a job of the caller's own company: insert and move are refused in words", async () => {
    await as(techId);
    const ins = await refused("insert into tasks (job_id, title) values ($1, 'TEST 0358 onto their job')", [otherJobId]);
    expect(ins?.code).toBe("42501");
    expect(ins?.message).toMatch(/isn't one of this company's jobs/);
    const mv = await refused("update tasks set job_id = $2 where id = $1", [officeTaskId, otherJobId]);
    expect(mv?.code).toBe("42501");
    // Another job of the SAME company is fine.
    const { rows: [t] } = await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 on job 2') returning id", [job2Id]);
    expect((await landed(t.id)).job_id).toBe(job2Id);
  });

  it("the policy says it too: with the trigger's words out of the way, the row is refused by RLS", async () => {
    await asServer();
    const { rows } = await client.query(
      "select with_check from pg_policies where schemaname = 'public' and tablename = 'tasks' and policyname = 'tasks_insert'",
    );
    expect(rows[0].with_check).toMatch(/j\.org_id = auth_org_id\(\)/);
  });

  // ── delete: the office, or whoever added it ────────────────────────────────────────────────
  it("a tech can't delete a task the office added (the row stays), but can delete his own", async () => {
    await as(techId);
    const del = await client.query("delete from tasks where id = $1", [officeTaskId]);
    expect(del.rowCount).toBe(0);
    expect(await landed(officeTaskId)).not.toBeNull();
    await as(techId);
    const { rows: [mine] } = await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 my own') returning id", [jobId]);
    const own = await client.query("delete from tasks where id = $1", [mine.id]);
    expect(own.rowCount).toBe(1);
  });

  it("nor can a tech take an office task off the job by making it his Reminder", async () => {
    await as(techId);
    const r = await refused("update tasks set job_id = null, assigned_to = $2 where id = $1", [officeTaskId, techId]);
    expect(r?.code).toBe("42501");
    expect(r?.message).toMatch(/Only the office or whoever added this task can move it/);
    expect((await landed(officeTaskId)).job_id).toBe(jobId);
  });

  it("nor by putting it under his own task and deleting that (a step goes with its task)", async () => {
    await as(techId);
    const { rows: [mine] } = await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 his decoy') returning id", [jobId]);
    const r = await refused("update tasks set parent_id = $2 where id = $1", [officeTaskId, mine.id]);
    expect(r?.code).toBe("42501");
    expect(r?.message).toMatch(/Only the office or whoever added this task can move it/);
    await as(techId);
    expect((await client.query("delete from tasks where id = $1", [mine.id])).rowCount).toBe(1);
    const still = await landed(officeTaskId);
    expect(still).not.toBeNull();
    expect(still.job_id).toBe(jobId);
  });

  it("nor by moving it to another of the company's jobs; the office and whoever added a task can move it", async () => {
    await as(techId);
    const r = await refused("update tasks set job_id = $2 where id = $1", [officeTaskId, job2Id]);
    expect(r?.code).toBe("42501");
    expect((await landed(officeTaskId)).job_id).toBe(jobId);
    // His own task moves.
    await as(techId);
    const { rows: [mine] } = await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 his to move') returning id", [jobId]);
    expect((await client.query("update tasks set job_id = $2 where id = $1", [mine.id, job2Id])).rowCount).toBe(1);
    expect((await landed(mine.id)).job_id).toBe(job2Id);
    // The office moves anyone's, and back.
    await as(officeId);
    expect((await client.query("update tasks set job_id = $2 where id = $1", [officeTaskId, job2Id])).rowCount).toBe(1);
    expect((await client.query("update tasks set job_id = $2 where id = $1", [officeTaskId, jobId])).rowCount).toBe(1);
    expect((await landed(officeTaskId)).job_id).toBe(jobId);
  });

  it("another tech can't delete Brian's task either; the office can delete anyone's", async () => {
    await as(techId);
    const { rows: [b] } = await client.query("insert into tasks (job_id, title) values ($1, 'TEST 0358 brians') returning id", [jobId]);
    await as(tech2Id);
    expect((await client.query("delete from tasks where id = $1", [b.id])).rowCount).toBe(0);
    await as(officeId);
    expect((await client.query("delete from tasks where id = $1", [b.id])).rowCount).toBe(1);
  });

  // ── a Reminder is private ──────────────────────────────────────────────────────────────────
  it("a Reminder is its maker's alone: another member can't read, change or delete it", async () => {
    await as(officeId);
    const { rows: [rem] } = await client.query("insert into tasks (title) values ('TEST 0358 buy the gift') returning id");
    expect((await client.query("select id from tasks where id = $1", [rem.id])).rowCount).toBe(1);
    for (const who of [techId, tech2Id]) {
      await as(who);
      expect((await client.query("select id from tasks where id = $1", [rem.id])).rowCount).toBe(0);
      expect((await client.query("update tasks set title = 'x' where id = $1", [rem.id])).rowCount).toBe(0);
      expect((await client.query("delete from tasks where id = $1", [rem.id])).rowCount).toBe(0);
    }
    expect((await landed(rem.id)).title).toBe("TEST 0358 buy the gift");
  });

  it("a Reminder made for someone: the two of them see it, a third member doesn't", async () => {
    await as(officeId);
    const { rows: [rem] } = await client.query("insert into tasks (title, assigned_to) values ('TEST 0358 grab the ladder', $1) returning id", [techId]);
    await as(techId);
    expect((await client.query("select id from tasks where id = $1", [rem.id])).rowCount).toBe(1);
    expect((await client.query("update tasks set status = 'done' where id = $1", [rem.id])).rowCount).toBe(1);
    await as(tech2Id);
    expect((await client.query("select id from tasks where id = $1", [rem.id])).rowCount).toBe(0);
    await as(officeId);
    expect((await client.query("select id from tasks where id = $1", [rem.id])).rowCount).toBe(1);
  });

  it("a Reminder can't be made for someone outside the company", async () => {
    await as(officeId);
    const r = await refused("insert into tasks (title, assigned_to) values ('TEST 0358 for a stranger', $1)", [strangerId]);
    expect(r?.code).toBe("42501");
    expect(r?.message).toMatch(/isn't on this company's team/);
  });

  it("a legacy Reminder with no maker and no person stays the office's, never the crew's", async () => {
    await as(officeId);
    expect((await client.query("select id from tasks where id = $1", [orphanReminderId])).rowCount).toBe(1);
    await as(techId);
    expect((await client.query("select id from tasks where id = $1", [orphanReminderId])).rowCount).toBe(0);
  });

  it("a job's task is the whole crew's to read", async () => {
    for (const who of [officeId, techId, tech2Id]) {
      await as(who);
      expect((await client.query("select id from tasks where id = $1", [officeTaskId])).rowCount).toBe(1);
    }
  });

  // ── photos: this company's folder, one the crew can open ───────────────────────────────────
  it("a task photo must be in this company's folder, not a staff-only one, and never climb out", async () => {
    await as(techId);
    const { rows: [t] } = await client.query("insert into tasks (job_id, title, photo_path) values ($1, 'TEST 0358 photo', $2) returning id", [
      jobId,
      `${orgId}/${jobId}/breaker.jpg`,
    ]);
    expect((await landed(t.id)).photo_path).toBe(`${orgId}/${jobId}/breaker.jpg`);
    await as(techId);
    for (const bad of [`${otherOrgId}/${otherJobId}/x.jpg`, `${orgId}/organize/x.jpg`, `${orgId}/../${otherOrgId}/x.jpg`, `${orgId}`, "x.jpg"]) {
      const r = await refused("update tasks set photo_path = $2 where id = $1", [t.id, bad]);
      expect(r?.code, bad).toBe("42501");
      expect(r?.message, bad).toMatch(/isn't in this company's job files/);
    }
  });

  // ── another company ────────────────────────────────────────────────────────────────────────
  it("another company can't read, check off, delete or add to this company's tasks", async () => {
    await as(strangerId);
    expect((await client.query("select id from tasks where id = $1", [officeTaskId])).rowCount).toBe(0);
    expect((await client.query("update tasks set status = 'done' where id = $1", [officeTaskId])).rowCount).toBe(0);
    expect((await client.query("delete from tasks where id = $1", [officeTaskId])).rowCount).toBe(0);
    const ins = await refused("insert into tasks (org_id, job_id, title) values ($1, $2, 'TEST 0358 into their org')", [orgId, jobId]);
    expect(ins?.code).toBe("42501");
    expect(await landed(officeTaskId)).not.toBeNull();
  });
});
