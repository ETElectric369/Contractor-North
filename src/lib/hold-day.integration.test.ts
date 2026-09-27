import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * EVERY WAIT HAS A DAY (0366, jobs_hold_day), where the rule lives: the database.
 *
 *   · a job entering hold with no day comes back on the COMPANY's today + 7: two throwaway companies
 *     a day apart (Kiritimati, UTC+14, and Pago Pago, UTC-11: 25 hours, so their dates always differ)
 *     get two different days, and neither is Los Angeles' unless it happens to be the same date;
 *   · a day the writer picked is kept; a job inserted on hold (an import) gets a day too;
 *   · who held it is the signed-in person, never a hold_by the client sent, and it stays theirs
 *     through a snooze that moves the day;
 *   · a server (service client) write names nobody: hold_by stays null when it holds a job, and its
 *     promotion off hold (the clock's shared promote) clears everything;
 *   · leaving hold by ANY door clears the reason, the day and who held it; a job not on hold can't
 *     carry any of them;
 *   · (0366's invoices.due_date_by_hand) every invoice already there when 0366 adds the column reads
 *     true, so a due date typed before it is never restamped at Send; a draft made after starts
 *     false, and a second run of the file marks nothing new.
 *
 * Everything happens inside ONE transaction that is always rolled back, on throwaway companies
 * (lib/throwaway-org.db-fixture). 0366 is applied inside that transaction (the file on this branch,
 * so what is asserted is exactly what ships; it is safe to run twice, so a database that already has
 * it just runs it again). People speak by planted request.jwt.claims under `set local role
 * authenticated`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0366 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0366_"))!), "utf8");

d("every wait has a day (0366 jobs_hold_day)", () => {
  let c: pg.Client;
  let ready = false;
  let orgA = "";
  let orgB = "";
  let ownerA = "";
  let ownerB = "";
  let techA = "";
  // THE INVOICES THAT WERE THERE BEFORE 0366 (due_date_by_hand): made before the file runs, when the
  // database doesn't have the column yet (the test database is at 0365); empty when it already has it.
  let hadByHand = true;
  let orgL = "";
  let legacyDraft = "";

  const it = (name: string, fn: () => Promise<void>) =>
    vitestIt(name, async (ctx) => {
      if (!ready) return ctx.skip();
      await fn();
    });
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run as `uid` (a signed-in person), then back to the server. */
  const asPerson = async <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
    try {
      return await fn();
    } finally {
      await asServer();
    }
  };
  const job = async (org: string, status = "in_progress") =>
    (await one("insert into public.jobs (org_id, name, status) values ($1, 'TEST 0366 job', $2::job_status) returning id::text as id", [org, status])).id as string;
  const hold = (id: string) =>
    one(
      "select status::text as status, hold_reason, hold_until::text as hold_until, hold_by::text as hold_by from public.jobs where id = $1",
      [id],
    );
  const todayIn = async (tz: string) => (await one("select (now() at time zone $1)::date::text as d", [tz])).d as string;
  const plus = async (ymd: string, days: number) => (await one("select ($1::date + $2::int)::text as d", [ymd, days])).d as string;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    const had = (await one("select to_regprocedure('public.jobs_hold_day()') is not null as ok")).ok;
    hadByHand = (
      await one("select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name = 'due_date_by_hand') as yes")
    ).yes as boolean;
    if (!hadByHand) {
      // A draft whose due date someone typed on main (setInvoiceDueDate wrote due_date alone: no flag).
      const l = await mintThrowawayOrg(c, { label: "0366 invoices before", techs: 0 });
      orgL = l.orgId;
      const lj = (await one("insert into public.jobs (org_id, name, status) values ($1, 'TEST 0366 invoice job', 'in_progress') returning id::text as id", [orgL])).id;
      legacyDraft = (
        await one(
          "insert into public.invoices (org_id, job_id, invoice_number, status, invoice_kind, title, due_date) values ($1, $2, 'TEST-0366-L1', 'draft', 'standard', 'TEST typed before 0366', '2026-11-01') returning id::text as id",
          [orgL, lj],
        )
      ).id;
    }
    await c.query(M0366);
    console.warn(`[hold-day] 0366 ${had ? "was already on this database; ran it again" : "applied"} inside the test's own transaction, which is rolled back.`);
    await c.query("set local statement_timeout = '30s'");

    const a = await mintThrowawayOrg(c, { label: "0366 holds Kiritimati", techs: 1 });
    const b = await mintThrowawayOrg(c, { label: "0366 holds Pago Pago", techs: 0 });
    orgA = a.orgId;
    orgB = b.orgId;
    ownerA = a.owner.id;
    ownerB = b.owner.id;
    techA = a.techs[0].id;
    const tz = await c.query(
      "update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('timezone', case when id = $1 then 'Pacific/Kiritimati' else 'Pacific/Pago_Pago' end) where id = any($2::uuid[]) returning id",
      [orgA, [orgA, orgB]],
    );
    expect(tz.rowCount).toBe(2);
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("entering hold with no day: the company's own today + 7, in its own timezone", async () => {
    const [ja, jb] = [await job(orgA), await job(orgB)];
    await asPerson(ownerA, () => c.query("update public.jobs set status = 'on_hold', hold_reason = 'Waiting on the permit' where id = $1", [ja]));
    await asPerson(ownerB, () => c.query("update public.jobs set status = 'on_hold', hold_reason = 'Waiting on the permit' where id = $1", [jb]));
    const [ha, hb] = [await hold(ja), await hold(jb)];
    expect(ha.hold_until).toBe(await plus(await todayIn("Pacific/Kiritimati"), 7));
    expect(hb.hold_until).toBe(await plus(await todayIn("Pacific/Pago_Pago"), 7));
    // Twenty-five hours apart: never the same date, so one fixed zone could not have given both.
    expect(ha.hold_until).not.toBe(hb.hold_until);
    expect(ha).toMatchObject({ status: "on_hold", hold_reason: "Waiting on the permit", hold_by: ownerA });
    expect(hb.hold_by).toBe(ownerB);
  });

  it("a day the writer picked is kept, and hold_by is the signed-in person, never the one it sent", async () => {
    const j = await job(orgA);
    const picked = await plus(await todayIn("Pacific/Kiritimati"), 3);
    await asPerson(ownerA, () =>
      c.query("update public.jobs set status = 'on_hold', hold_reason = 'Customer traveling', hold_until = $2::date, hold_by = $3 where id = $1", [j, picked, techA]),
    );
    expect(await hold(j)).toMatchObject({ hold_until: picked, hold_by: ownerA });
  });

  it("staying on hold: a snooze moves the day and keeps who held it, whatever hold_by it sends", async () => {
    const j = await job(orgA);
    await asPerson(ownerA, () => c.query("update public.jobs set status = 'on_hold', hold_reason = 'Waiting on the permit' where id = $1", [j]));
    const later = await plus(await todayIn("Pacific/Kiritimati"), 12);
    await asPerson(ownerA, () => c.query("update public.jobs set hold_until = $2::date, hold_by = $3 where id = $1", [j, later, techA]));
    expect(await hold(j)).toMatchObject({ status: "on_hold", hold_reason: "Waiting on the permit", hold_until: later, hold_by: ownerA });
  });

  it("a server write names nobody, and a job inserted on hold (an import) still gets a day", async () => {
    const j = await job(orgA);
    await c.query("update public.jobs set status = 'on_hold', hold_reason = 'Waiting on the utility' where id = $1", [j]);
    const h = await hold(j);
    expect(h.hold_by).toBeNull();
    expect(h.hold_until).toBe(await plus(await todayIn("Pacific/Kiritimati"), 7));
    // An import (lane 4's importJobs) lands a job already on hold: it gets its company's day, and
    // no reason ("No reason saved" on its row), which is acceptable.
    const imported = await job(orgB, "on_hold");
    expect(await hold(imported)).toMatchObject({ status: "on_hold", hold_reason: null, hold_by: null, hold_until: await plus(await todayIn("Pacific/Pago_Pago"), 7) });
  });

  it("the clock's promotion (a service-client write) takes a job off hold and clears everything", async () => {
    const j = await job(orgA);
    await asPerson(ownerA, () => c.query("update public.jobs set status = 'on_hold', hold_reason = 'Waiting on the permit' where id = $1", [j]));
    // lib/job-promote: the service client, only while it is still on hold.
    const woke = await c.query("update public.jobs set status = 'in_progress' where id = $1 and org_id = $2 and status = 'on_hold' returning id", [j, orgA]);
    expect(woke.rowCount).toBe(1);
    expect(await hold(j)).toEqual({ status: "in_progress", hold_reason: null, hold_until: null, hold_by: null });
  });

  it("leaving hold by any door clears the reason, the day and who held it", async () => {
    for (const next of ["scheduled", "to_be_scheduled", "complete", "cancelled"]) {
      const j = await job(orgA);
      await asPerson(ownerA, () => c.query("update public.jobs set status = 'on_hold', hold_reason = 'Waiting on the permit' where id = $1", [j]));
      expect((await hold(j)).hold_until, next).not.toBeNull();
      await asPerson(ownerA, () => c.query("update public.jobs set status = $2::job_status where id = $1", [j, next]));
      expect(await hold(j), next).toEqual({ status: next, hold_reason: null, hold_until: null, hold_by: null });
    }
  });

  it("a job not on hold can't carry a hold's reason, day or holder", async () => {
    const j = await job(orgA, "scheduled");
    const someday = await plus(await todayIn("Pacific/Kiritimati"), 5);
    await asPerson(ownerA, () =>
      c.query("update public.jobs set hold_reason = 'sneaky', hold_until = $2::date, hold_by = $3 where id = $1", [j, someday, ownerA]),
    );
    expect(await hold(j)).toEqual({ status: "scheduled", hold_reason: null, hold_until: null, hold_by: null });
  });

  it("the holder is a real person: jobs_hold_by_fkey names profiles, and a tech still can't write a job", async () => {
    const fk = await one(
      "select confrelid::regclass::text as tbl, confdeltype from pg_constraint where conname = 'jobs_hold_by_fkey' and conrelid = 'public.jobs'::regclass",
    );
    expect(fk).toEqual({ tbl: "profiles", confdeltype: "n" });
    const j = await job(orgA);
    const r = await asPerson(techA, () => c.query("update public.jobs set status = 'on_hold', hold_reason = 'tech says so' where id = $1 returning id", [j]));
    expect(r.rowCount).toBe(0);
    expect((await hold(j)).status).toBe("in_progress");
  });

  vitestIt("0366 marks every invoice already there as dated by hand, so Send keeps a date typed before it; a draft made after starts false, and a second run changes neither", async (ctx) => {
    if (!ready || hadByHand) return ctx.skip(); // the database already had the column: nothing from before to check
    const byHand = async (id: string) => (await one("select due_date_by_hand as h, due_date::text as d from public.invoices where id = $1", [id])) as { h: boolean; d: string };
    // markInvoiceSent's restamp, guard and all (restampDueOnFirstSend).
    const restamp = async (id: string) =>
      (await c.query("update public.invoices set due_date = '2026-10-11' where id = $1 and org_id = $2 and due_date_by_hand = false returning id", [id, orgL])).rowCount;

    expect(await byHand(legacyDraft)).toEqual({ h: true, d: "2026-11-01" });
    const lj = (await one("select job_id::text as j from public.invoices where id = $1", [legacyDraft])).j;
    const fresh = (
      await one(
        "insert into public.invoices (org_id, job_id, invoice_number, status, invoice_kind, title, due_date) values ($1, $2, 'TEST-0366-L2', 'draft', 'standard', 'TEST made after 0366', '2026-10-30') returning id::text as id",
        [orgL, lj],
      )
    ).id as string;
    expect((await byHand(fresh)).h).toBe(false);

    // Safe to run twice: the second run finds the column and marks nothing.
    await c.query(M0366);
    await c.query("set local statement_timeout = '30s'");
    expect((await byHand(fresh)).h).toBe(false);
    expect((await byHand(legacyDraft)).h).toBe(true);

    // The first send: the date typed before 0366 stays; the untouched draft made after moves.
    expect(await restamp(legacyDraft)).toBe(0);
    expect(await restamp(fresh)).toBe(1);
    expect(await byHand(legacyDraft)).toEqual({ h: true, d: "2026-11-01" });
    expect((await byHand(fresh)).d).toBe("2026-10-11");
  });
});
