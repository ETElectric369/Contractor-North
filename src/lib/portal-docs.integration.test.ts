import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Migration 0326: the customer sees the plans and drawings, only the newest version, and never a
 * receipt, a bill or a supplier invoice.
 *
 * Spoken to the database the way PostgREST would (office staff, a tech, another org's office,
 * anon) and the way the portal page does (the service role, the direct connection here), inside
 * ONE transaction on ONE connection, begun before anything else and always rolled back. It borrows
 * an active tech and an active office member of one org and makes its own customers, jobs and
 * documents (dated 2001), so no real row is read for an answer or left behind. Read-back is the
 * assertion, never the absence of an error (the silent-write law).
 *
 * BEFORE 0326 IS APPLIED each case says so on the console and returns (loud, not a green lie).
 * TEST_APPLY_PENDING=1 loads the file INSIDE the rolled-back transaction and exercises it anyway:
 * that renames a table for the few seconds the suite runs, so it is for a practice run, never CI.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [TEST_APPLY_PENDING=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, TEST_APPLY_PENDING } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("plans and drawings on the customer's page (0326)", { timeout: 30_000 }, () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let otherStaffId = "";
  let custA = "";
  let custB = "";
  let jobA = "";
  let jobB = "";
  let tokenA = "";
  let tokenB = "";

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
  /** Run fn as someone; return the error code (or message) it was refused with, or null. Undone. */
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
  const refusedWith = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt2");
    try {
      await fn();
      await c.query("rollback to savepoint attempt2");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt2");
      return (e as Error).message;
    } finally {
      await asServer();
    }
  };
  /** Run fn as someone, keep what it returned, and undo everything it did. */
  const lookAs = async <T,>(who: () => Promise<void>, fn: () => Promise<T>): Promise<T> => {
    await c.query("savepoint look");
    try {
      await who();
      return await fn();
    } finally {
      await c.query("rollback to savepoint look");
      await asServer();
    }
  };
  const needs = () => {
    if (!ready) console.warn("[portal-docs] migration 0326 is not on this database yet; apply it (or TEST_APPLY_PENDING=1) to exercise this case.");
    return ready;
  };
  const view = async (token: string, jobId: string) => (await one("select public.portal_job_view($1, $2) as j", [token, jobId])).j;
  const docIds = async (token: string, jobId: string) => ((await view(token, jobId))?.documents ?? []).map((x: { id: string }) => x.id);
  const doc = async (jobId: string, name: string, category: string | null, folder?: string) =>
    (
      await one("insert into public.documents (org_id, job_id, name, kind, category, file_url) values ($1, $2, $3, 'other', $4, $5) returning id", [
        orgId,
        jobId,
        name,
        category,
        `${orgId}/${folder ?? jobId}/${name}`,
      ])
    ).id as string;
  /** Show a paper as the office: the insert PostgREST would send, org/job/file stamped by 0326. */
  const show = async (documentId: string, jobId: string, extra: Record<string, unknown> = {}) => {
    const cols = ["document_id", "org_id", "job_id", "file_url_at_share", ...Object.keys(extra)];
    const vals = [documentId, orgId, jobId, "", ...Object.values(extra)];
    await c.query(`insert into public.job_shared_documents (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    // FIRST: nothing below may write outside this transaction.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    const probe = async () =>
      (
        await one(
          `select to_regclass('public.job_shared_documents') is not null
              and to_regprocedure('public.job_share_shows(uuid, uuid, uuid)') is not null as ok`,
        )
      ).ok as boolean;
    ready = await probe();
    if (!ready && TEST_APPLY_PENDING === "1") {
      await c.query(fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", "0326_the_customer_sees_the_latest_drawing.sql"), "utf8"));
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
    if (!fx) throw new Error("0326 test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;
    otherStaffId =
      (await one("select id from public.profiles where org_id <> $1 and role in ('owner','admin','office') and coalesce(active, true) limit 1", [orgId]))?.id ?? "";

    const cust = async (name: string) => (await one("insert into public.customers (org_id, name) values ($1, $2) returning id", [orgId, name])).id as string;
    custA = await cust("TEST 0326 A");
    custB = await cust("TEST 0326 B");
    const job = async (customerId: string, number: string) =>
      (
        await one("insert into public.jobs (org_id, name, job_number, status, billing_type, customer_id) values ($1, $2, $2, 'in_progress', 'tm', $3) returning id", [
          orgId,
          number,
          customerId,
        ])
      ).id as string;
    jobA = await job(custA, "TEST-0326-A");
    jobB = await job(custB, "TEST-0326-B");
    tokenA = (await one("select token from public.customer_portal_access where customer_id = $1", [custA])).token;
    tokenB = (await one("select token from public.customer_portal_access where customer_id = $1", [custB])).token;
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("a receipt, a bill and a supplier's invoice are refused, even by the office", async () => {
    if (!needs()) return;
    for (const cat of ["Receipt", "Bill", "Invoice"]) {
      const id = await doc(jobA, `test-0326-${cat.toLowerCase()}.jpg`, cat);
      const msg = await refusedWith(async () => {
        await as(staffId);
        await show(id, jobA, { kind: "document" });
      });
      expect(msg).toBe(`A ${cat.toLowerCase()} is the company's own paper and is never shown to the customer.`);
    }
    // No category, or one nobody put on the allow-list: refused out loud too.
    const bare = await doc(jobA, "test-0326-bare.pdf", null);
    expect(await refused(async () => { await as(staffId); await show(bare, jobA); })).toBe("23514");
  });

  it("paper tied to money is refused whatever it is filed as: Organize wrote a bill from it, or it is a supplier invoice's file", async () => {
    if (!needs()) return;
    await c.query("savepoint money");
    try {
      const other = await doc(jobA, "test-0326-looks-like-a-plan.pdf", "Other");
      const bill = (await one("insert into public.bills (org_id, job_id, supplier, amount, status, bill_date) values ($1, $2, 'TEST 0326 SUPPLIER', 10, 'unpaid', '2001-01-02') returning id", [orgId, jobA])).id;
      await c.query("insert into public.organized_items (org_id, kind, title, category, job_id, document_id, bill_id, status) values ($1, 'receipt', 'TEST 0326', 'Other', $2, $3, $4, 'filed')", [
        orgId,
        jobA,
        other,
        bill,
      ]);
      expect(await refusedWith(async () => { await as(staffId); await show(other, jobA, { kind: "plan" }); })).toBe(
        "This paper is tied to a bill, a supplier invoice or petty cash, so it is never shown to the customer.",
      );
    } finally {
      await c.query("rollback to savepoint money");
      await asServer();
    }
  });

  it("a plan the office showed reaches the customer with the office's title, never the file's name or who shared it", async () => {
    if (!needs()) return;
    await c.query("savepoint shown");
    try {
      const plan = await doc(jobA, "test-0326-scan-output-v1.pdf", "Plan");
      await as(staffId);
      await show(plan, jobA, { kind: "circuit_map", title: "Circuit Map" });
      await asServer();
      const row = await one("select org_id, job_id, file_url_at_share, shared_by, kind, title from public.job_shared_documents where document_id = $1", [plan]);
      expect(row).toMatchObject({ org_id: orgId, job_id: jobA, file_url_at_share: `${orgId}/${jobA}/test-0326-scan-output-v1.pdf`, shared_by: staffId, kind: "circuit_map", title: "Circuit Map" });
      // A crew member renames the document: the customer still reads the office's title.
      await c.query("update public.documents set name = 'TECH RENAMED' where id = $1", [plan]);
      const v = await view(tokenA, jobA);
      expect(v.documents).toEqual([
        { id: plan, kind: "circuit_map", title: "Circuit Map", file_path: `${orgId}/${jobA}/test-0326-scan-output-v1.pdf`, added_at: expect.any(String), shown_at: expect.any(String), is_update: false },
      ]);
      expect(v.photos).toEqual([]);
      expect(JSON.stringify(v)).not.toMatch(/TECH RENAMED|shared_by|scan-output-v1"/);
      // Re-filed as a Receipt after it was shown: it drops off the page on the next read.
      await c.query("update public.documents set category = 'Receipt' where id = $1", [plan]);
      expect(await docIds(tokenA, jobA)).toEqual([]);
    } finally {
      await c.query("rollback to savepoint shown");
      await asServer();
    }
  });

  it("versions: the customer sees only the newest; the older one stays on record with who and when", async () => {
    if (!needs()) return;
    await c.query("savepoint versions");
    try {
      const v1 = await doc(jobA, "test-0326-circuit-v1.pdf", "Plan");
      const v2 = await doc(jobA, "test-0326-circuit-v2.pdf", "Plan");
      const v3 = await doc(jobA, "test-0326-circuit-v3.pdf", "Plan");
      await as(staffId);
      await show(v1, jobA, { kind: "circuit_map", title: "Circuit Map (from the plan scans)" });
      await show(v2, jobA, { kind: "circuit_map", title: "Circuit Map", replaces_document_id: v1 });
      await asServer();
      expect(await docIds(tokenA, jobA)).toEqual([v2]);
      expect((await view(tokenA, jobA)).documents[0].is_update).toBe(true);
      // The older row is still there: shown by whom, replaced by whom and when.
      expect(await one("select removed_at, shared_by from public.job_shared_documents where document_id = $1", [v1])).toEqual({ removed_at: null, shared_by: staffId });
      expect(await one("select replaces_marked_by, replaces_marked_at is not null as at from public.job_shared_documents where document_id = $1", [v2])).toEqual({
        replaces_marked_by: staffId,
        at: true,
      });

      // One live newer version per paper, and no circle.
      expect(
        await refusedWith(async () => {
          await as(staffId);
          await show(v3, jobA, { replaces_document_id: v1 });
        }),
      ).toMatch(/is already replaced by "Circuit Map"/);
      expect(
        await refusedWith(async () => {
          await as(staffId);
          await c.query("update public.job_shared_documents set replaces_document_id = $1 where document_id = $2", [v2, v1]);
        }),
      ).toMatch(/replace each other/);

      // A third version chains on: still only the newest.
      await as(staffId);
      await show(v3, jobA, { replaces_document_id: v2 });
      await asServer();
      expect(await docIds(tokenA, jobA)).toEqual([v3]);

      // Taking the newest down brings the one it replaced back (soft: the row stays, with who).
      await as(staffId);
      await c.query("update public.job_shared_documents set removed_at = now() where document_id = $1", [v3]);
      await asServer();
      expect(await docIds(tokenA, jobA)).toEqual([v2]);
      expect(await one("select removed_by from public.job_shared_documents where document_id = $1", [v3])).toEqual({ removed_by: staffId });

      // Deleting the oldest paper (a crew member may delete documents) lets the link go quietly.
      await as(techId);
      const gone = await c.query("delete from public.documents where id = $1 returning id", [v1]);
      await asServer();
      expect(gone.rowCount).toBe(1);
      expect(await one("select replaces_document_id, title from public.job_shared_documents where document_id = $1", [v2])).toEqual({
        replaces_document_id: null,
        title: "Circuit Map",
      });
      expect(await docIds(tokenA, jobA)).toEqual([v2]);
    } finally {
      await c.query("rollback to savepoint versions");
      await asServer();
    }
  });

  it("a tech cannot show, replace, retitle or take down a paper, nor read the rows", async () => {
    if (!needs()) return;
    await c.query("savepoint tech");
    try {
      const plan = await doc(jobA, "test-0326-tech-plan.pdf", "Plan");
      const newer = await doc(jobA, "test-0326-tech-newer.pdf", "Plan");
      await as(staffId);
      await show(plan, jobA, { kind: "plan", title: "Plan" });
      await asServer();

      expect(await refused(async () => { await as(techId); await show(newer, jobA, { replaces_document_id: plan }); })).toBe("42501");
      // Updates the policy hides are zero rows, not errors: read them back.
      const n = await lookAs(
        () => as(techId),
        async () =>
          (await c.query("update public.job_shared_documents set title = 'TECH', removed_at = now(), replaces_document_id = null where document_id = $1 returning 1", [plan]))
            .rowCount,
      );
      expect(n).toBe(0);
      const seen = await lookAs(
        () => as(techId),
        async () => (await c.query("select 1 from public.job_shared_documents where job_id = $1", [jobA])).rowCount,
      );
      expect(seen).toBe(0);
      expect(await one("select title, removed_at from public.job_shared_documents where document_id = $1", [plan])).toEqual({ title: "Plan", removed_at: null });
      expect(await docIds(tokenA, jobA)).toEqual([plan]);
    } finally {
      await c.query("rollback to savepoint tech");
      await asServer();
    }
  });

  it("isolation: another customer's link, another job's paper, another org's office", async () => {
    if (!needs()) return;
    await c.query("savepoint iso");
    try {
      const mine = await doc(jobA, "test-0326-a-plan.pdf", "Plan");
      const theirs = await doc(jobB, "test-0326-b-plan.pdf", "Plan");
      await as(staffId);
      await show(mine, jobA, { kind: "plan" });
      await show(theirs, jobB, { kind: "plan" });
      await asServer();
      expect(await docIds(tokenA, jobA)).toEqual([mine]);
      expect(await docIds(tokenB, jobB)).toEqual([theirs]);
      // Customer B's link opens nothing of job A's, and A's link nothing of B's.
      expect(await view(tokenB, jobA)).toBeNull();
      expect(await view(tokenA, jobB)).toBeNull();

      // A paper on job B can't be marked as replacing one on job A.
      expect(
        await refusedWith(async () => {
          await as(staffId);
          await c.query("update public.job_shared_documents set replaces_document_id = $1 where document_id = $2", [mine, theirs]);
        }),
      ).toMatch(/never shown on this job's page/);

      // A paper filed in another job's folder can't be shown on this one.
      const misfiled = await doc(jobA, "test-0326-misfiled.pdf", "Plan", jobB);
      expect(await refusedWith(async () => { await as(staffId); await show(misfiled, jobA); })).toBe("Only papers uploaded on this job can be shown to the customer.");

      if (otherStaffId) {
        const seen = await lookAs(
          () => as(otherStaffId),
          async () => (await c.query("select 1 from public.job_shared_documents where job_id in ($1, $2)", [jobA, jobB])).rowCount,
        );
        expect(seen).toBe(0);
        const other = await doc(jobA, "test-0326-other-org.pdf", "Plan");
        expect(await refused(async () => { await as(otherStaffId); await show(other, jobA); })).toBe("42501");
        const n = await lookAs(
          () => as(otherStaffId),
          async () => (await c.query("update public.job_shared_documents set removed_at = now() where document_id = $1 returning 1", [mine])).rowCount,
        );
        expect(n).toBe(0);
      }
      for (const t of ["job_shared_documents", "job_shared_photos"]) {
        expect(await refused(async () => { await asAnon(); await c.query(`select 1 from public.${t} limit 1`); })).toBe("42501");
      }
      for (const who of [() => as(techId), () => as(staffId), () => asAnon()]) {
        expect(await refused(async () => { await who(); await c.query("select public.job_share_shows($1, $2, $3)", [mine, orgId, jobA]); })).toBe("42501");
      }
    } finally {
      await c.query("rollback to savepoint iso");
      await asServer();
    }
  });

  it("photos keep working, through the old name too, and stay in the photo grid", async () => {
    if (!needs()) return;
    await c.query("savepoint photos");
    try {
      const photo = await doc(jobA, "test-0326-panel.jpg", "Photo");
      await as(staffId);
      // An app build from before 0326 writes through job_shared_photos.
      await c.query("insert into public.job_shared_photos (document_id, org_id, job_id, file_url_at_share) values ($1, $2, $3, 'whatever')", [photo, orgId, jobA]);
      await asServer();
      const v = await view(tokenA, jobA);
      expect(v.photos.map((p: { id: string }) => p.id)).toEqual([photo]);
      expect(v.documents).toEqual([]);
      expect(await one("select kind, title from public.job_shared_documents where document_id = $1", [photo])).toEqual({ kind: "photo", title: "test-0326-panel" });
      // Taken down by the new build (soft): gone from the page and from the old name's view.
      await as(staffId);
      await c.query("update public.job_shared_documents set removed_at = now() where document_id = $1", [photo]);
      const old = (await c.query("select 1 from public.job_shared_photos where document_id = $1", [photo])).rowCount;
      await asServer();
      expect(old).toBe(0);
      expect((await view(tokenA, jobA)).photos).toEqual([]);
      // Back up: the file is stamped again as it is now.
      await as(staffId);
      await c.query("update public.job_shared_documents set removed_at = null where document_id = $1", [photo]);
      await asServer();
      expect((await view(tokenA, jobA)).photos.map((p: { id: string }) => p.id)).toEqual([photo]);
    } finally {
      await c.query("rollback to savepoint photos");
      await asServer();
    }
  });

  it("what a share row IS cannot be rewritten: which paper, which job, which file", async () => {
    if (!needs()) return;
    await c.query("savepoint pinned");
    try {
      const plan = await doc(jobA, "test-0326-pinned.pdf", "Plan");
      await as(staffId);
      await show(plan, jobA);
      await c.query("update public.job_shared_documents set file_url_at_share = 'x', job_id = $1, shared_by = null where document_id = $2", [jobB, plan]);
      await asServer();
      expect(await one("select file_url_at_share, job_id, shared_by from public.job_shared_documents where document_id = $1", [plan])).toEqual({
        file_url_at_share: `${orgId}/${jobA}/test-0326-pinned.pdf`,
        job_id: jobA,
        shared_by: staffId,
      });
    } finally {
      await c.query("rollback to savepoint pinned");
      await asServer();
    }
  });
});
