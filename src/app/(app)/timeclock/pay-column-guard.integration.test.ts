import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

/**
 * Migration 0143 — the wage-integrity invariant, checked where it actually lives.
 *
 * The staff-only rule on time-entry corrections is enforced in updateTimeEntry
 * (requireStaff), which a direct PostgREST PATCH with the caller's own session token
 * walks straight past: 0004's time_entries_update policy has no column restriction and
 * 0095's trigger only guarded ALREADY-PAID rows. A tech could move ten unpaid clock_in
 * values back two hours and /payroll would snapshot the inflated gross into payroll_runs.
 *
 * RLS is the real write boundary, so the guard has to be in the DB — and this test
 * asserts it IS, read-only, from the catalog. Same creds gate as rls.integration.test.ts:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("time_entries pay-column tamper guard (0143)", () => {
  let client: pg.Client;
  let body = "";

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
    const { rows } = await client.query(
      "select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='guard_paid_time_entry'",
    );
    body = rows[0]?.def ?? "";
  });
  afterAll(async () => {
    await client?.end();
  });

  it("the guard trigger is bound to time_entries UPDATE", async () => {
    const { rows } = await client.query(
      "select tgname, tgenabled from pg_trigger where tgrelid = 'public.time_entries'::regclass and not tgisinternal and tgname = 'guard_paid_time_entry'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tgenabled).not.toBe("D"); // never shipped disabled
  });

  it("the guard function exists and runs only for non-staff", () => {
    expect(body).not.toBe("");
    expect(body).toMatch(/if not public\.is_org_staff\(\)/);
  });

  it("a member cannot move a shift start or set their own pay rate", () => {
    expect(body).toMatch(/new\.clock_in is distinct from old\.clock_in/);
    expect(body).toMatch(/new\.rate_override is distinct from old\.rate_override/);
  });

  it("a member cannot rewrite a CLOSED shift's clock_out or miles", () => {
    expect(body).toMatch(/old\.status = 'closed'/);
    expect(body).toMatch(/new\.clock_out is distinct from old\.clock_out/);
    expect(body).toMatch(/new\.miles is distinct from old\.miles/);
  });

  it("still freezes settled rows and the payroll locks themselves (0095, unchanged)", () => {
    expect(body).toMatch(/old\.paid_at is not null or old\.mileage_paid_at is not null/);
    expect(body).toMatch(/new\.paid_at is distinct from old\.paid_at/);
  });

  /**
   * THE 0169 WAGE PROTECTIONS (audit v921).
   *
   * Everything above pins the 0143 body. 0169 later added the clauses a punch can actually be
   * abused through, and nothing asserted them: a `create or replace function
   * guard_paid_time_entry()` that restored the 0143 body left all six tests green while a tech
   * could PATCH lunch_minutes 30→0 on a closed 8-hour shift and be paid half an hour a day for
   * it. These are read from the same catalog definition, one `it` per protection so a dropped
   * clause names itself in the failure.
   */
  it("a member cannot lower the lunch on a finished shift (0169)", () => {
    expect(body).toMatch(/coalesce\(new\.lunch_minutes, ?0\) < coalesce\(old\.lunch_minutes, ?0\)/);
  });

  it("a shift over five hours cannot be closed without the 30-minute lunch (0169)", () => {
    expect(body).toMatch(/gross_hours > 5/);
    expect(body).toMatch(/coalesce\(new\.lunch_minutes, ?0\) < 30/);
  });

  it("a shift longer than a day cannot be closed by its owner (0169)", () => {
    expect(body).toMatch(/interval '18 hours'/);
  });

  it("a backdated punch cannot be laid on top of a shift already recorded (0169)", () => {
    expect(body).toMatch(/coalesce\(t\.clock_out, now\(\)\) > new\.clock_in \+ interval '1 minute'/);
  });

  it("a self-punch may only reach back 45 minutes live / 4h15m offline (0169)", () => {
    expect(body).toMatch(/max_backdate/);
    expect(body).toMatch(/interval '4 hours 15 minutes'/);
    expect(body).toMatch(/interval '45 minutes'/);
    expect(body).toMatch(/new\.clock_in < now\(\) - max_backdate/);
  });

  it("a member cannot rewrite how a punch was recorded, except the geofence's own close (0169)", () => {
    expect(body).toMatch(/new\.source is distinct from old\.source/);
    expect(body).toMatch(/new\.source = 'auto_gps'/);
  });

  it("leaves the legitimate tech write-paths open (notes, gps_in, job_id, closing an open shift)", () => {
    // The guard names only pay-relevant columns — a switchJob/saveEntryNotes/clockOut
    // write must never start failing for the crew mid-shift.
    for (const col of ["notes", "gps_in", "job_id", "job_code", "translated_notes"]) {
      expect(body).not.toMatch(new RegExp(`new\\.${col} is distinct from old\\.${col}`));
    }
  });
});
