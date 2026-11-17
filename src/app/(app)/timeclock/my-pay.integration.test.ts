import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * Migration 0410 (cn-v1166, My Pay Periods): a worker reads his own pay runs, exercised where the rule
 * lives. The owner, 2026-11-16: "yes for tech sees all their own data and past pay periods".
 *
 * Runs as a tech, office staff and a deactivated tech by planting request.jwt.claims and `set local
 * role`, exactly as PostgREST does, inside ONE transaction that is always rolled back. Two TEST
 * companies are minted in it (lib/throwaway-org.db-fixture): the first with its owner and three techs
 * (the reader, a teammate, and one whose seat is cut), the second with one tech. Every row sits on
 * 2001 pay periods, days nobody worked.
 *
 * It proves: a tech reads exactly his own runs (base and mileage) and his own payments, none of his
 * teammate's and none of another company's; his insert on payroll_runs is refused and his update and
 * delete change nothing; staff still read every run and payment of their company; a deactivated tech
 * reads nothing.
 *
 * BEFORE 0410 IS APPLIED each case says so through notOnThisDatabase (it throws in CI). Set
 * TEST_APPLY_PENDING=1 to load the file INSIDE the rolled-back transaction and exercise it anyway: that
 * replaces a policy on payroll_runs for the few seconds the suite runs, so it is for a practice run,
 * never for CI.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [TEST_APPLY_PENDING=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, TEST_APPLY_PENDING } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const MIGRATION = "0410_a_worker_reads_his_own_pay_periods.sql";

d("0410: a worker reads his own pay periods", () => {
  let c: pg.Client;
  let has0410 = false;
  let orgId = "";
  let ownerId = "";
  let techId = "";
  let mateId = "";
  let goneId = "";
  let otherTechId = "";
  /** Run ids and payment ids by whose they are. */
  const runs: Record<string, string[]> = {};
  const payments: Record<string, string[]> = {};

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Runs inside its own savepoint and gives back what fn returned, or the error it was refused with.
   *  Either way nothing it did survives into the next case, and the role is the server's again. */
  const attempt = async <T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null }> => {
    await c.query("savepoint attempt");
    try {
      return { value: await fn(), error: null };
    } catch (e) {
      return { value: null, error: String((e as Error)?.message ?? e) };
    } finally {
      await c.query("rollback to savepoint attempt");
      await asServer();
    }
  };
  /** What `uid` reads, as that person, by RLS alone (no filter of our own). */
  const idsAs = async (uid: string, table: "payroll_runs" | "pay_payments"): Promise<string[]> => {
    const r = await attempt(async () => {
      await as(uid);
      return (await c.query(`select id::text as id from public.${table} order by id`)).rows.map((x) => String(x.id));
    });
    if (r.error) throw new Error(r.error);
    return r.value ?? [];
  };
  const needs = () =>
    has0410 || notOnThisDatabase(`[my-pay] migration 0410 is not on this database yet; apply it (or TEST_APPLY_PENDING=1) to exercise this case.`);

  /** A run, written as the server (a privileged writer, the way markPeriodPaid's lock lands). */
  const baseRun = async (org: string, who: string, start: string, end: string, gross: number) =>
    (
      await one(
        `insert into public.payroll_runs (org_id, profile_id, period_start, period_end, kind, hours, miles, rate, gross, note)
         values ($1, $2, $3::date, $4::date, 'base', 8, 0, $5::numeric / 8, $5, 'TEST my-pay office note') returning id::text as id`,
        [org, who, start, end, gross],
      )
    ).id as string;
  const mileageRun = async (org: string, who: string, start: string, end: string, amount: number) =>
    (
      await one(
        `insert into public.payroll_runs (org_id, profile_id, period_start, period_end, kind, hours, miles, rate, gross, mileage_amount)
         values ($1, $2, $3::date, $4::date, 'mileage', 0, 30, 0, 0, $5) returning id::text as id`,
        [org, who, start, end, amount],
      )
    ).id as string;
  const payment = async (org: string, who: string, amount: number, paidOn: string) =>
    (
      await one(
        `insert into public.pay_payments (org_id, profile_id, amount, paid_on, method, note)
         values ($1, $2, $3, $4::date, 'check', 'TEST my-pay office note') returning id::text as id`,
        [org, who, amount, paidOn],
      )
    ).id as string;
  const sorted = (a: string[]) => [...a].sort();

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    await assertTestDatabase(c);
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");

    const probe = async () => {
      const p = await one(
        `select qual from pg_policies where schemaname = 'public' and tablename = 'payroll_runs' and policyname = 'payroll_runs_read'`,
      );
      has0410 = !!p?.qual && String(p.qual).includes("auth.uid()");
    };
    await probe();
    if (!has0410 && TEST_APPLY_PENDING === "1") {
      await c.query(fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8"));
      await probe();
    }

    // Minted here and rolled back (never a live company).
    const org = await mintThrowawayOrg(c, { label: "0410 my pay", techs: 3 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    [techId, mateId, goneId] = org.techs.map((t) => t.id);
    const other = await mintThrowawayOrg(c, { label: "0410 my pay stranger", techs: 1 });
    otherTechId = other.techs[0].id;

    runs[techId] = [await baseRun(orgId, techId, "2001-01-01", "2001-01-15", 320), await mileageRun(orgId, techId, "2001-01-01", "2001-01-15", 21.5)];
    runs[mateId] = [await baseRun(orgId, mateId, "2001-01-01", "2001-01-15", 400)];
    runs[goneId] = [await baseRun(orgId, goneId, "2001-01-01", "2001-01-15", 280)];
    runs[otherTechId] = [await baseRun(other.orgId, otherTechId, "2001-01-01", "2001-01-15", 360)];
    payments[techId] = [await payment(orgId, techId, 320, "2001-01-15"), await payment(orgId, techId, 50, "2001-01-20")];
    payments[mateId] = [await payment(orgId, mateId, 400, "2001-01-15")];
    payments[goneId] = [await payment(orgId, goneId, 280, "2001-01-15")];
    payments[otherTechId] = [await payment(other.orgId, otherTechId, 360, "2001-01-15")];

    // The seat that is cut: an offboarding, as the server.
    const cut = await c.query("update public.profiles set active = false where id = $1 returning active", [goneId]);
    expect(cut.rows[0].active).toBe(false);
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("a tech reads exactly his own runs, base and mileage, and none of his teammate's or another company's", async () => {
    if (!needs()) return;
    const mine = await idsAs(techId, "payroll_runs");
    expect(sorted(mine)).toEqual(sorted(runs[techId]));
    for (const not of [...runs[mateId], ...runs[goneId], ...runs[otherTechId]]) expect(mine).not.toContain(not);
    // And both kinds came back, with the figures he is owed the truth of.
    const r = await attempt(async () => {
      await as(techId);
      return (await c.query("select kind, gross::float8 as gross, mileage_amount::float8 as mileage_amount from public.payroll_runs order by kind")).rows;
    });
    expect(r.error).toBeNull();
    expect(r.value).toEqual([
      { kind: "base", gross: 320, mileage_amount: null },
      { kind: "mileage", gross: 0, mileage_amount: 21.5 },
    ]);
  });

  it("a tech reads exactly his own payments, none of anyone else's (0264, unchanged)", async () => {
    const mine = await idsAs(techId, "pay_payments");
    expect(sorted(mine)).toEqual(sorted(payments[techId]));
  });

  it("a teammate reads his own and not the tech's", async () => {
    if (!needs()) return;
    expect(sorted(await idsAs(mateId, "payroll_runs"))).toEqual(sorted(runs[mateId]));
    expect(sorted(await idsAs(mateId, "pay_payments"))).toEqual(sorted(payments[mateId]));
  });

  it("his insert on payroll_runs is refused: recording a lock stays an office act", async () => {
    const r = await attempt(async () => {
      await as(techId);
      await c.query(
        `insert into public.payroll_runs (org_id, profile_id, period_start, period_end, kind, hours, miles, rate, gross)
         values ($1, $2, '2001-02-01', '2001-02-15', 'base', 80, 0, 100, 8000)`,
        [orgId, techId],
      );
    });
    expect(r.error).toMatch(/row-level security|permission denied/);
  });

  it("his update and delete on payroll_runs change nothing", async () => {
    const upd = await attempt(async () => {
      await as(techId);
      return (await c.query("update public.payroll_runs set gross = 9999 where id = $1", [runs[techId][0]])).rowCount;
    });
    expect(upd.error).toBeNull();
    expect(upd.value).toBe(0);
    const del = await attempt(async () => {
      await as(techId);
      return (await c.query("delete from public.payroll_runs where id = any($1::uuid[])", [runs[techId]])).rowCount;
    });
    expect(del.error).toBeNull();
    expect(del.value).toBe(0);
    // Read back as the server: the rows stand as written.
    const still = await one("select count(*)::int as n, sum(gross)::float8 as g from public.payroll_runs where id = any($1::uuid[])", [runs[techId]]);
    expect(still).toEqual({ n: 2, g: 320 });
  });

  it("staff still read every run and every payment of their company, and none of another's", async () => {
    const ours = [...runs[techId], ...runs[mateId], ...runs[goneId]];
    expect(sorted(await idsAs(ownerId, "payroll_runs"))).toEqual(sorted(ours));
    expect(sorted(await idsAs(ownerId, "pay_payments"))).toEqual(sorted([...payments[techId], ...payments[mateId], ...payments[goneId]]));
  });

  it("a deactivated tech reads nothing: not his runs, not his payments", async () => {
    expect(await idsAs(goneId, "payroll_runs")).toEqual([]);
    expect(await idsAs(goneId, "pay_payments")).toEqual([]);
  });

  it("another company's tech reads his own and nothing of this company's", async () => {
    if (!needs()) return;
    expect(sorted(await idsAs(otherTechId, "payroll_runs"))).toEqual(sorted(runs[otherTechId]));
    expect(sorted(await idsAs(otherTechId, "pay_payments"))).toEqual(sorted(payments[otherTechId]));
  });
});
