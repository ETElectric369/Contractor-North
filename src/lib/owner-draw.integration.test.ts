import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

/**
 * Migration 0286 — an owner is paid by owner's draw, checked where it actually lives.
 *
 * The app refuses to record wages for an owner (recordPayment, markPeriodPaid, settleMileage), but a
 * refusal in a server action is a convention: a PostgREST insert with a staff session walks past it.
 * The boundary is refuse_wages_for_an_owner on pay_payments and payroll_runs, and the profile_pay view
 * that reads every owner's pay rate as 0. This speaks to the database inside ONE transaction that is
 * always rolled back (the billing test's pattern): it borrows an existing owner, tries the writes,
 * reads what the view says, and leaves nothing behind.
 *
 * Same creds gate as rls.integration.test.ts; skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("an owner is paid by draw (0286)", () => {
  let client: pg.Client;
  let ownerId = "";
  let orgId = "";

  /** Run a statement that SHOULD be refused; return the error message, or null if it went through.
   *  A savepoint keeps a refusal from aborting the shared transaction, and undoes a wrong success. */
  const refused = async (sql: string, params: unknown[]): Promise<string | null> => {
    await client.query("savepoint attempt");
    try {
      await client.query(sql, params);
      await client.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await client.query("rollback to savepoint attempt");
      return (e as Error).message;
    }
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
    await client.query("begin");
    const { rows } = await client.query(
      "select id, org_id from public.profiles where role = 'owner' and active and org_id is not null order by created_at limit 1",
    );
    ownerId = rows[0]?.id ?? "";
    orgId = rows[0]?.org_id ?? "";
  });
  afterAll(async () => {
    await client?.query("rollback").catch(() => undefined);
    await client?.end();
  });

  it("there is an owner to test with", () => {
    expect(ownerId).not.toBe("");
  });

  it("a pay_payments insert for an owner is refused, in plain words", async () => {
    const msg = await refused(
      "insert into public.pay_payments (org_id, profile_id, amount, paid_on, method) values ($1, $2, 100, current_date, 'cash')",
      [orgId, ownerId],
    );
    expect(msg).toMatch(/is the owner and is paid by owner's draw, not wages/);
  });

  it("a payroll_runs insert for an owner is refused too", async () => {
    const msg = await refused(
      "insert into public.payroll_runs (org_id, profile_id, period_start, period_end, kind, hours, rate, gross) values ($1, $2, current_date, current_date + 14, 'base', 1, 0, 0)",
      [orgId, ownerId],
    );
    expect(msg).toMatch(/owner's draw/);
  });

  it("a crew shift carrying a pay rate cannot be moved onto the owner with it; without it, it can", async () => {
    const { rows: crew } = await client.query(
      "select id from public.profiles where org_id = $1 and role <> 'owner' order by created_at limit 1",
      [orgId],
    );
    if (!crew[0]) return; // an org with nobody but its owner has no crew shift to move
    await client.query("savepoint move");
    try {
      const { rows: [e] } = await client.query(
        `insert into public.time_entries (org_id, profile_id, clock_in, clock_out, status, rate_override)
         values ($1, $2, '2026-09-10T15:00:00Z', '2026-09-10T23:00:00Z', 'closed', 40) returning id`,
        [orgId, crew[0].id],
      );
      // Same override, new person: the trigger must look at the move, not only at the rate.
      const msg = await refused("update public.time_entries set profile_id = $2 where id = $1", [e.id, ownerId]);
      expect(msg).toMatch(/owner's draw/);
      // The editor's own move drops the override, and that goes through.
      expect(await refused("update public.time_entries set profile_id = $2, rate_override = null where id = $1", [e.id, ownerId])).toBeNull();
    } finally {
      await client.query("rollback to savepoint move");
    }
  });

  it("profile_pay reads the owner's pay rate as 0 and says paid_by_draw", async () => {
    await client.query("savepoint look");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ownerId, role: "authenticated" })]);
    const { rows } = await client.query("select hourly_rate, paid_by_draw from public.profile_pay where id = $1", [ownerId]);
    await client.query("rollback to savepoint look");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].hourly_rate)).toBe(0);
    expect(rows[0].paid_by_draw).toBe(true);
  });

  it("the three triggers are bound and enabled", async () => {
    const { rows } = await client.query(
      "select tgrelid::regclass::text as tbl, tgname, tgenabled from pg_trigger where not tgisinternal and tgname in ('refuse_wages_for_an_owner', 'refuse_pay_rate_on_owner_entry', 'guard_owner_money_visibility') order by 1",
    );
    const bound = rows.map((r: { tbl: string; tgname: string }) => `${r.tbl}:${r.tgname}`).sort();
    expect(bound).toEqual(
      [
        "organizations:guard_owner_money_visibility",
        "pay_payments:refuse_wages_for_an_owner",
        "payroll_runs:refuse_wages_for_an_owner",
        "time_entries:refuse_pay_rate_on_owner_entry",
      ].sort(),
    );
    for (const r of rows) expect(r.tgenabled).not.toBe("D");
  });
});
