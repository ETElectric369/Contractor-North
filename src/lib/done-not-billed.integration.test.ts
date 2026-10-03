import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES, postgrestShim } from "@/lib/postgrest-shim.db-fixture";
import { doneRowItems, legacyDoneItems, type DoneRow, type DoneSeen } from "@/lib/action-items/done-not-billed";

/**
 * DONE, NOT BILLED, READ WHOLE (W1-FU-misc A): migration 0371's needs_you_done_not_billed, where the
 * rules live.
 *
 * Proven here, inside ONE transaction that applies 0371 (create or replace: the file as it is on
 * this branch, whether or not the test database carries it yet) and is always rolled back:
 *   · 150 billed visits and 1 old unbilled service call: the call still comes back, first (the old
 *     newest-first read of 100 cut exactly that one);
 *   · a paid anchor hides a visit; an unpaid anchor comes back with open_invoice_id; a void anchor
 *     settles nothing; a visit on a job with real billing is hidden; a job whose only invoice is a
 *     draft (or void) still comes back; absorbed, unfinished, other-type and before-the-floor rows
 *     never do; the floor is the org's midnight, an instant, not UTC's;
 *   · another company's rows never come back, and a tech gets zero rows;
 *   · old = new: for the same fixtures, the function's rows as Needs You rows are exactly what
 *     today's two reads and today's loop (legacyDoneItems) made, row for row, including the two
 *     rules that stay in code;
 *   · total_count is the whole count whatever the limit, and the limit keeps the oldest.
 *
 * Two TEST companies minted inside the transaction (throwaway-org.db-fixture.ts), every fixture named
 * TEST and dated 2001. It speaks as each person exactly as PostgREST does (the shim).
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** The org's midnight (Pacific) of a day in 2001: what query.ts hands the function (dayStartIso). */
const PACIFIC_MIDNIGHT_2001_01_01 = "2001-01-01T08:00:00.000Z";

d("Done, Not Billed read whole (0371): every unbilled row, oldest first, never the billed ones", () => {
  let c: pg.Client;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherOrgId = "";
  let otherStaffId = "";
  let jobFloor = "";
  const ids: Record<string, string> = {};

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = (uid: string) => postgrestShim(c, uid);
  const call = async (uid: string, visitFrom = PACIFIC_MIDNIGHT_2001_01_01, jobFrom = jobFloor, limit?: number) => {
    const res = await as(uid).rpc("needs_you_done_not_billed", { p_visit_from: visitFrom, p_job_from: jobFrom, ...(limit != null ? { p_limit: limit } : {}) });
    expect(res.error).toBeNull();
    return (res.data ?? []) as DoneRow[];
  };

  const visit = async (org: string, key: string, o: { type?: string; status?: string; startsAt: string; jobId?: string | null; absorbed?: boolean; customerId?: string | null; inquiryId?: string | null }) => {
    ids[key] = (
      await one(
        `insert into public.appointments (org_id, type, title, starts_at, status, job_id, absorbed, customer_id, inquiry_id)
         values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9) returning id::text as id`,
        [org, o.type ?? "service_call", `TEST ${key}`, o.startsAt, o.status ?? "completed", o.jobId ?? null, o.absorbed ?? false, o.customerId ?? null, o.inquiryId ?? null],
      )
    ).id;
    return ids[key];
  };
  const job = async (org: string, key: string, status = "complete") => {
    ids[key] = (
      await one("insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, $2, $3, $4, 'tm') returning id::text as id", [
        org,
        `TEST ${key}`,
        `TEST-DNB-${key}`,
        status,
      ])
    ).id;
    return ids[key];
  };
  let invSeq = 0;
  const invoice = async (org: string, o: { status: string; paid?: number; appointmentId?: string | null; jobId?: string | null }) =>
    (
      await one(
        `insert into public.invoices (org_id, job_id, appointment_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1, $2, $3, $4, $5, 'standard', 100, $6) returning id::text as id`,
        [org, o.jobId ?? null, o.appointmentId ?? null, `TEST-DNB-INV-${++invSeq}`, o.status, o.paid ?? 0],
      )
    ).id as string;

  /** TODAY'S TWO READS AND TODAY'S LOOP, as the build ran them (query.ts before 0371), as `uid`. */
  const legacy = async (uid: string, seen: DoneSeen) => {
    const sb = as(uid);
    const [doneWork, doneJobs, billed] = await Promise.all([
      sb
        .from("appointments")
        .select("id, type, title, status, starts_at, job_id, customers(name), inquiries(name)")
        .eq("absorbed", false)
        .in("type", ["service_call", "job"])
        .eq("status", "completed")
        .gte("starts_at", PACIFIC_MIDNIGHT_2001_01_01)
        .order("starts_at", { ascending: false })
        .limit(100),
      sb
        .from("jobs")
        .select("id, job_number, name, status, updated_at, customers(name)")
        .eq("status", "complete")
        .gte("updated_at", jobFloor)
        .order("updated_at", { ascending: false })
        .limit(50),
      sb.from("invoices").select("job_id").not("job_id", "is", null).not("status", "in", "(draft,void)").limit(5000),
    ]);
    for (const r of [doneWork, doneJobs, billed]) expect(r.error).toBeNull();
    const visitIds = ((doneWork.data ?? []) as { id: string }[]).map((a) => a.id);
    const settled = visitIds.length
      ? await sb.from("invoices").select("id, appointment_id, amount_paid").in("appointment_id", visitIds).neq("status", "void").limit(400)
      : { data: [], error: null };
    expect(settled.error).toBeNull();
    return legacyDoneItems({
      doneWork: doneWork.data ?? [],
      doneJobs: doneJobs.data ?? [],
      settled: (settled.data ?? []) as any[],
      billedJobs: new Set(((billed.data ?? []) as { job_id: string }[]).map((r) => r.job_id)),
      seen,
    });
  };
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      types: PG_TYPES,
    });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: the migration and every fixture live only inside this transaction.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    // 0371 as it is on this branch (a new function: no lock on any table).
    await c.query(readFileSync(fileURLToPath(new URL("../../supabase/migrations/0371_done_work_is_read_whole.sql", import.meta.url)), "utf8"));
    const fx = await mintOrgAndStranger(c, "done-not-billed");
    orgId = fx.orgId;
    staffId = fx.staffId;
    techId = fx.techId;
    otherOrgId = fx.otherOrgId;
    otherStaffId = fx.otherStaffId;

    // ── THE RULES, in the first company ──
    const rita = (await one("insert into public.customers (org_id, name) values ($1, 'TEST Rita Moss') returning id::text as id", [orgId])).id;
    const sam = (await one("insert into public.inquiries (org_id, name) values ($1, 'TEST Sam Lee') returning id::text as id", [orgId])).id;
    // Finished visits with no bill at all: one on a customer, one on a lead, one on a job billed only by a draft.
    await visit(orgId, "free visit", { startsAt: "2001-02-01T18:00:00Z", customerId: rita });
    await visit(orgId, "lead visit", { type: "job", startsAt: "2001-02-02T18:00:00Z", inquiryId: sam });
    const draftJob = await job(orgId, "draft-billed job", "in_progress");
    await invoice(orgId, { status: "draft", jobId: draftJob });
    await visit(orgId, "visit on draft job", { startsAt: "2001-02-03T18:00:00Z", jobId: draftJob });
    // Anchored and paid: settled, hidden. Anchored, unpaid: back, with its invoice.
    const paid = await visit(orgId, "paid visit", { startsAt: "2001-02-04T18:00:00Z", customerId: rita });
    await invoice(orgId, { status: "paid", paid: 100, appointmentId: paid });
    const owed = await visit(orgId, "owed visit", { startsAt: "2001-02-05T18:00:00Z", customerId: rita });
    ids["owed invoice"] = await invoice(orgId, { status: "sent", appointmentId: owed });
    // A void anchor settles nothing, whatever it says was paid.
    const voided = await visit(orgId, "void-anchor visit", { startsAt: "2001-02-06T18:00:00Z" });
    await invoice(orgId, { status: "void", paid: 100, appointmentId: voided });
    // On a job with real billing: hidden.
    const billedJob = await job(orgId, "billed job", "in_progress");
    await invoice(orgId, { status: "sent", jobId: billedJob });
    await visit(orgId, "visit on billed job", { startsAt: "2001-02-07T18:00:00Z", jobId: billedJob });
    // Never candidates: absorbed into its job, not finished, not a service call or job-day, before the floor.
    await visit(orgId, "absorbed visit", { startsAt: "2001-02-08T18:00:00Z", absorbed: true });
    await visit(orgId, "scheduled visit", { startsAt: "2001-02-09T18:00:00Z", status: "scheduled" });
    await visit(orgId, "inspection", { type: "inspection", startsAt: "2001-02-10T18:00:00Z" });
    // 11:30 PM Pacific on Dec 31, 2000 is 07:30 UTC on Jan 1: before the org's midnight floor.
    await visit(orgId, "the night before the floor", { startsAt: "2001-01-01T07:30:00Z" });
    // Finished jobs: no invoice, only a draft, only a void (all back); a sent invoice (hidden).
    await job(orgId, "done job");
    const doneDraft = await job(orgId, "done job, draft only");
    await invoice(orgId, { status: "draft", jobId: doneDraft });
    const doneVoid = await job(orgId, "done job, void only");
    await invoice(orgId, { status: "void", jobId: doneVoid });
    const doneBilled = await job(orgId, "done job, billed");
    await invoice(orgId, { status: "sent", jobId: doneBilled });
    await job(orgId, "job still going", "in_progress");

    // ── MANY BILLED, ONE OLD UNBILLED, in the second company ──
    await visit(otherOrgId, "old unbilled call", { startsAt: "2001-01-15T18:00:00Z" });
    await c.query(
      `with v as (
         insert into public.appointments (org_id, type, title, starts_at, status)
         select $1, 'service_call', 'TEST billed ' || g, timestamptz '2001-06-01T18:00:00Z' + g * interval '1 hour', 'completed'
           from generate_series(1, 150) g
         returning id
       )
       insert into public.invoices (org_id, appointment_id, invoice_number, status, invoice_kind, total, amount_paid)
       select $1, v.id, 'TEST-DNB-MANY-' || row_number() over (), 'paid', 'standard', 100, 100 from v`,
      [otherOrgId],
    );
    // The jobs' floor: the moment these rows were written (updated_at is the transaction's clock).
    jobFloor = (await one("select min(updated_at)::text as at from public.jobs where org_id = $1", [orgId])).at;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("150 billed visits and one old unbilled service call: the call comes back, first", async () => {
    const rows = await call(otherStaffId);
    expect(rows.map((r) => r.id)).toEqual([ids["old unbilled call"]]);
    expect(rows[0]).toMatchObject({ src: "visit", title: "TEST old unbilled call", open_invoice_id: null, total_count: 1 });
    // The read it replaced (newest first, 100) never reached it: the pile went quiet on the oldest money.
    const old = await legacy(otherStaffId, { overdueEmitted: new Set(), draftOnNowJobs: new Set() });
    expect(old).toEqual([]);
  });

  it("the rules: unbilled visits and jobs come back oldest first; billed, absorbed, unfinished and early ones never do", async () => {
    const rows = await call(staffId);
    const byKey = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    expect(rows.map((r) => byKey[r.id])).toEqual([
      "free visit",
      "lead visit",
      "visit on draft job",
      "owed visit",
      "void-anchor visit",
      // the jobs, updated when they were written (this transaction's clock), after every 2001 visit
      ...rows.filter((r) => r.src === "job").map((r) => byKey[r.id]),
    ]);
    expect(rows.filter((r) => r.src === "job").map((r) => byKey[r.id]).sort()).toEqual(["done job", "done job, draft only", "done job, void only"].sort());
    expect(rows.every((r) => Number(r.total_count) === rows.length)).toBe(true);
    const row = (key: string) => rows.find((r) => r.id === ids[key])!;
    expect(row("free visit")).toMatchObject({ customer_name: "TEST Rita Moss", job_id: null, open_invoice_id: null });
    expect(row("lead visit")).toMatchObject({ customer_name: "TEST Sam Lee" });
    expect(row("visit on draft job")).toMatchObject({ job_id: ids["draft-billed job"], job_name: "TEST draft-billed job", job_number: "TEST-DNB-draft-billed job" });
    // An unpaid anchor comes back with its invoice (Billed, Not Paid); a paid anchor hides the visit.
    expect(row("owed visit").open_invoice_id).toBe(ids["owed invoice"]);
    expect(rows.some((r) => r.id === ids["paid visit"])).toBe(false);
    expect(row("void-anchor visit").open_invoice_id).toBeNull();
    for (const hidden of ["visit on billed job", "absorbed visit", "scheduled visit", "inspection", "the night before the floor", "done job, billed", "job still going"]) {
      expect(rows.some((r) => r.id === ids[hidden]), hidden).toBe(false);
    }
    // The floor is the org's midnight, an instant: a floor read as UTC midnight would take the night before.
    const utc = await call(staffId, "2001-01-01T00:00:00.000Z");
    expect(utc.some((r) => r.id === ids["the night before the floor"])).toBe(true);
  });

  it("old = new: the same rows as today's two reads and today's loop, including the two rules left in code", async () => {
    const none = { overdueEmitted: new Set<string>(), draftOnNowJobs: new Set<string>() };
    expect(byId(doneRowItems(await call(staffId), none))).toEqual(byId(await legacy(staffId, none)));
    // The rules that depend on other rows: an open invoice on Late Invoices, a job's draft on Now.
    const seen = { overdueEmitted: new Set([ids["owed invoice"]]), draftOnNowJobs: new Set([ids["done job, draft only"]]) };
    const now = doneRowItems(await call(staffId), seen);
    expect(byId(now)).toEqual(byId(await legacy(staffId, seen)));
    expect(now.some((i) => i.id === `unbilled-${ids["owed visit"]}`)).toBe(false);
    expect(now.some((i) => i.id === `jdone-${ids["done job, draft only"]}`)).toBe(false);
    expect(now.find((i) => i.id === `unbilled-${ids["free visit"]}`)).toMatchObject({ title: "TEST free visit", subtitle: "TEST Rita Moss", href: `/appointments/${ids["free visit"]}` });
  });

  it("another company's rows never come back, and a tech gets zero rows", async () => {
    const mine = await call(staffId);
    expect(mine.some((r) => r.id === ids["old unbilled call"])).toBe(false);
    const theirs = await call(otherStaffId);
    expect(theirs.some((r) => mine.some((m) => m.id === r.id))).toBe(false);
    expect(await call(techId)).toEqual([]);
  });

  it("total_count is the whole count whatever the limit, and the limit keeps the oldest", async () => {
    const all = await call(staffId);
    const first = await call(staffId, PACIFIC_MIDNIGHT_2001_01_01, jobFloor, 2);
    expect(first.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
    expect(first.every((r) => Number(r.total_count) === all.length)).toBe(true);
  });

  it("the signed-in role alone may call it", async () => {
    const grants = (
      await c.query(
        `select r.rolname, has_function_privilege(r.rolname, 'public.needs_you_done_not_billed(timestamptz, timestamptz, integer)', 'execute') as may
           from pg_roles r where r.rolname in ('anon', 'authenticated') order by r.rolname`,
      )
    ).rows;
    expect(grants).toEqual([
      { rolname: "anon", may: false },
      { rolname: "authenticated", may: true },
    ]);
    const fn = await one(
      "select p.prosecdef as definer, p.provolatile as volatility from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'needs_you_done_not_billed'",
    );
    expect(fn).toEqual({ definer: false, volatility: "s" });
  });
});
