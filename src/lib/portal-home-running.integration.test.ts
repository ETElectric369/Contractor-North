import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import pg from "pg";
import { portalHomeRunning } from "./portal/home-shape";

/**
 * Migration 0323: the portal home's running bills and glass color, and which shown photos the
 * customer still sees (job_shared_photo_state).
 *
 * ONE connection, BEGIN before anything, ROLLBACK at the end: nothing here can outlive the run. It
 * borrows an active tech and an active office member of one org and makes its own customers, jobs,
 * bills and documents, named TEST 0323 and dated 2001, so no real row is read or touched. When 0323
 * is not on the database yet, the file itself is run INSIDE the same transaction (a practice run)
 * and rolled back with everything else; once 0323 is applied, the database's own functions are
 * tested as they are.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = path.join(__dirname, "../../supabase/migrations/0323_the_portal_home_knows_the_running_bill.sql");

d("the portal home's running bills and the office's photo check (0323)", { timeout: 30_000 }, () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let techId = "";
  let staffId = "";
  let otherStaffId = "";
  let tokenA = "";
  let jobA = "";
  let jobA2 = "";
  let jobB = "";
  let jobEstimate = "";
  let photo = "";

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
  const lookAs = async <T,>(who: () => Promise<void>, fn: () => Promise<T>): Promise<T | string> => {
    await c.query("savepoint look");
    try {
      await who();
      return await fn();
    } catch (e) {
      return String((e as { code?: string }).code ?? (e as Error).message);
    } finally {
      await c.query("rollback to savepoint look");
      await asServer();
    }
  };
  const home = async () => (await one("select public.customer_portal($1) as j", [tokenA])).j;
  const photoState = async () => (await c.query("select document_id, still_shown from public.job_shared_photo_state($1)", [jobA])).rows;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("begin");
    const base = (
      await one(
        `select to_regprocedure('public.customer_portal(text)') is not null
            and to_regclass('public.job_shared_photos') is not null as ok`,
      )
    ).ok;
    if (!base) return;
    if (!(await one("select to_regprocedure('public.job_shared_photo_state(uuid)') is not null as ok")).ok) {
      // 0323 not applied yet: practice-run it inside this transaction (rolled back in afterAll).
      await c.query(fs.readFileSync(MIGRATION, "utf8"));
    }
    ready = true;

    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and coalesce(s.active, true)
        where t.role = 'tech' and coalesce(t.active, true)
        limit 1`,
    );
    if (!fx) throw new Error("0323 test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;
    otherStaffId =
      (await one("select id from public.profiles where org_id <> $1 and role in ('owner','admin','office') and coalesce(active, true) limit 1", [orgId]))?.id ?? "";

    const cust = async (name: string) => (await one("insert into public.customers (org_id, name) values ($1, $2) returning id", [orgId, name])).id as string;
    const custA = await cust("TEST 0323 A");
    const custB = await cust("TEST 0323 B");
    const job = async (customerId: string, name: string, status: string) =>
      (await one("insert into public.jobs (org_id, name, job_number, status, billing_type, customer_id) values ($1, $2, $2, $3, 'tm', $4) returning id", [orgId, name, status, customerId]))
        .id as string;
    jobA = await job(custA, "TEST-0323-A", "in_progress");
    jobA2 = await job(custA, "TEST-0323-A2", "complete");
    jobB = await job(custB, "TEST-0323-B", "in_progress");
    jobEstimate = await job(custA, "TEST-0323-E", "estimate");
    const invoice = async (customerId: string, jobId: string, number: string, status: string, total: number, paid: number) =>
      one(
        `insert into public.invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, subtotal, total, amount_paid)
         values ($1, $2, $3, $4, $5, 'standard', $6, $6, $7) returning id`,
        [orgId, customerId, jobId, number, status, total, paid],
      );
    // Job A: two drafts (one running bill of $300.10, $100 paid), a sent bill and a void one.
    await invoice(custA, jobA, "TEST-0323-1", "draft", 250.1, 100);
    await invoice(custA, jobA, "TEST-0323-2", "draft", 50, 0);
    await invoice(custA, jobA, "TEST-0323-3", "sent", 999, 0);
    await invoice(custA, jobA, "TEST-0323-4", "void", 777, 0);
    // A2: paid ahead on its draft. B: another customer's draft. The estimate job: never shown.
    await invoice(custA, jobA2, "TEST-0323-5", "draft", 100, 150);
    await invoice(custB, jobB, "TEST-0323-6", "draft", 555, 0);
    await invoice(custA, jobEstimate, "TEST-0323-7", "draft", 444, 0);
    // A bill on A's job but billed to B: B's paper, not a running bill of A's.
    await invoice(custB, jobA, "TEST-0323-8", "draft", 333, 0);
    tokenA = (await one("select token from public.customer_portal_access where customer_id = $1", [custA])).token;

    photo = (
      await one("insert into public.documents (org_id, job_id, name, kind, category, file_url) values ($1, $2, 'test-0323.jpg', 'other', 'Photo', $3) returning id", [
        orgId,
        jobA,
        `${orgId}/${jobA}/test-0323.jpg`,
      ])
    ).id;
    await as(staffId);
    await c.query("insert into public.job_shared_photos (document_id, org_id, job_id, file_url_at_share) values ($1, $2, $3, '')", [photo, orgId, jobA]);
    await asServer();
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  const needs = () => {
    if (!ready) console.warn("[portal-home-running] customer_portal / job_shared_photos are not on this database; nothing was exercised.");
    return ready;
  };

  it("the home lists each of the customer's jobs with a draft as one running bill, summed, and nothing else", async () => {
    if (!needs()) return;
    const p = await home();
    const rows = portalHomeRunning(p.running);
    expect(rows.map((r) => [r.name, r.total, r.paid, r.balance]).sort()).toEqual(
      [
        ["TEST-0323-A", 300.1, 100, 200.1],
        ["TEST-0323-A2", 100, 150, -50],
      ].sort(),
    );
    // Only figures and the job: no bill number, no token, no pay door.
    for (const r of p.running) expect(Object.keys(r).sort()).toEqual(["amount_paid", "job_id", "job_name", "job_number", "total"]);
    const text = JSON.stringify(p.running);
    for (const never of ["TEST-0323-B", "TEST-0323-E", "555", "444", "333", "777", "999"]) expect(text).not.toContain(never);
    // The sent bill is still in the invoice list, and the drafts are not.
    expect(p.invoices.map((i: { invoice_number: string }) => i.invoice_number)).toEqual(["TEST-0323-3"]);
  });

  it("the home's org carries the org's glass color (DD2)", async () => {
    if (!needs()) return;
    const p = await home();
    const live = (await one("select settings->>'glass_tint' as t from public.organizations where id = $1", [orgId])).t;
    expect(Object.keys(p.org)).toContain("glass_tint");
    expect(p.org.glass_tint).toBe(live);
  });

  it("only the service role runs the home", async () => {
    if (!needs()) return;
    expect(await lookAs(asAnon, () => one("select public.customer_portal($1) as j", [tokenA]))).toBe("42501");
    expect(await lookAs(() => as(staffId), () => one("select public.customer_portal($1) as j", [tokenA]))).toBe("42501");
  });

  it("a shown photo reads still shown, and not once its file changed (PL4)", async () => {
    if (!needs()) return;
    expect(await lookAs(() => as(staffId), photoState)).toEqual([{ document_id: photo, still_shown: true }]);
    await c.query("savepoint changed");
    try {
      // The document re-pointed at another file (as the server, which may): the share still names
      // the file that was shown. Not a rewrite of the share row, which 0326's stamp pins.
      await c.query("update public.documents set file_url = $2 where id = $1", [photo, `${orgId}/${jobA}/test-0323-other-file.jpg`]);
      expect(await lookAs(() => as(staffId), photoState)).toEqual([{ document_id: photo, still_shown: false }]);
    } finally {
      await c.query("rollback to savepoint changed");
    }
  });

  it("only the job's own office reads the photo check: not the crew, not another org, not anon", async () => {
    if (!needs()) return;
    expect(await lookAs(() => as(techId), photoState)).toEqual([]);
    if (otherStaffId) expect(await lookAs(() => as(otherStaffId), photoState)).toEqual([]);
    expect(await lookAs(asAnon, photoState)).toBe("42501");
  });
});
