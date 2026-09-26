import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * Migration 0291: a running clock can be stopped, but never in the future, by anybody.
 *
 * 0248's "A shift cannot end in the future" lives in guard_paid_time_entry, which skips staff, so the
 * office editor or Nort's time.fixEntry could close a live shift at 5 PM while it was 4:30 PM.
 * guard_time_entry_close_in_time is the same rule for every session caller. 0291 also rewords the
 * 18-hour refusal so it stops offering a note as the way out (the exemption keys on
 * auto_closed_reason, and the editor nulls that column on every save).
 *
 * Runs as office staff by planting request.jwt.claims and `set local role authenticated`, exactly as
 * PostgREST does, inside ONE transaction that is always rolled back; the rows it made are also
 * deleted by id first, and only those. Every fixture sits on 2001-01-01, a day nobody worked.
 *
 * Before 0291 is applied, each case says so on the console and returns: loud, not a green lie.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const FUTURE = /A shift cannot end in the future\. Pick the time it really stopped\./;
const LONG = /That shift is [\d.]+ hours long, so a punch was probably forgotten\. Change the end to when it really stopped\./;

d("a running clock can be stopped, never in the future (0291)", () => {
  let c: pg.Client;
  let has0291 = false;
  let orgId = "";
  let staffId = "";
  /** Somebody with nothing on the clock: one_open_entry_per_user allows them one open fixture. */
  let idleId = "";
  const made: string[] = [];

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

  const asStaff = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: staffId, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The error a statement is refused with, or null when it went through (then undone). */
  const refusal = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return String((e as Error)?.message ?? e);
    } finally {
      await asServer();
    }
  };
  const needs = () => {
    if (!has0291) console.warn("[close-in-time] migration 0291 is not on this database yet; apply it to exercise this case.");
    return has0291;
  };
  /** A fixture row, written as the server (a privileged writer), remembered for cleanup. */
  const entry = async (clockIn: string, clockOut: string | null): Promise<string> => {
    const r = await one(
      `insert into public.time_entries (org_id, profile_id, clock_in, clock_out, status, source, notes)
       values ($1, $2, $3, $4, $5, 'manual', 'TEST 0291') returning id`,
      [orgId, idleId, clockIn, clockOut, clockOut ? "closed" : "open"],
    );
    made.push(r.id);
    return r.id;
  };

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
    // Both of the long-shift job's claims: the office's bell line at 10 hours, the question at 12.
    const col = await one(
      `select count(*) = 2 as ok from pg_attribute
        where attrelid = 'public.time_entries'::regclass
          and attname in ('long_shift_warned_at', 'long_shift_nudged_at')
          and atttypid = 'timestamptz'::regtype
          and not attisdropped`,
    );
    const trg = await one(
      `select 1 as ok from pg_trigger
        where tgrelid = 'public.time_entries'::regclass and tgname = 'guard_time_entry_close_in_time' and tgenabled <> 'D'`,
    );
    has0291 = !!col?.ok && !!trg;

    // Minted here and rolled back (never a live one): a fresh tech has nothing on the clock.
    const fx = await mintOrgAndStranger(c, "close-in-time");
    staffId = fx.staffId;
    orgId = fx.orgId;
    idleId = fx.techId;
  });

  /** Deletes the rows this suite made, and only those. After every case, because the person has
   *  room for one open shift and a punch-in closes a forgotten one (0193). */
  const cleanup = async () => {
    if (!c || !made.length) return;
    await asServer();
    await c.query("delete from public.time_entries where id = any($1::uuid[])", [made.splice(0)]);
  };
  afterEach(cleanup);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await c?.query("rollback").catch(() => undefined);
      await c?.end();
    }
  });

  it("the office cannot close an open shift at tomorrow", async () => {
    if (!needs()) return;
    const id = await entry("2001-01-01T16:00:00Z", null);
    const msg = await refusal(async () => {
      await asStaff();
      await c.query("update public.time_entries set clock_out = now() + interval '1 day', status = 'closed' where id = $1", [id]);
    });
    expect(msg).toMatch(FUTURE);
  });

  it("the same shift closed at the time it really stopped goes through", async () => {
    if (!needs()) return;
    const id = await entry("2001-01-01T16:00:00Z", null);
    const msg = await refusal(async () => {
      await asStaff();
      const r = await c.query(
        "update public.time_entries set clock_out = '2001-01-02T00:00:00Z', status = 'closed' where id = $1 returning id",
        [id],
      );
      expect(r.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });

  it("the office cannot insert a finished shift that ends tomorrow", async () => {
    if (!needs()) return;
    const msg = await refusal(async () => {
      await asStaff();
      await c.query(
        `insert into public.time_entries (org_id, profile_id, clock_in, clock_out, status, source)
         values ($1, $2, now() + interval '20 hours', now() + interval '1 day', 'closed', 'manual')`,
        [orgId, idleId],
      );
    });
    expect(msg).toMatch(FUTURE);
  });

  it("a notes-only fix on a finished 2001 shift still saves", async () => {
    if (!needs()) return;
    const id = await entry("2001-01-01T16:00:00Z", "2001-01-02T00:00:00Z");
    const msg = await refusal(async () => {
      await asStaff();
      const r = await c.query("update public.time_entries set notes = 'TEST 0291 fixed' where id = $1 returning id", [id]);
      expect(r.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });

  it("a shift over 18 hours is refused with a sentence that no longer offers a note", async () => {
    if (!needs()) return;
    const id = await entry("2001-01-01T16:00:00Z", null);
    const msg = await refusal(async () => {
      await asStaff();
      // 08:00 Pacific to 06:00 the next morning: 22 hours.
      await c.query("update public.time_entries set clock_out = '2001-01-02T14:00:00Z', status = 'closed' where id = $1", [id]);
    });
    expect(msg).toMatch(LONG);
    expect(msg).not.toMatch(/note/i);
  });

  it("each long-shift step claims its own column, once", async () => {
    if (!needs()) return;
    const id = await entry("2001-01-01T16:00:00Z", null);
    const msg = await refusal(async () => {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await c.query("set local role service_role");
      const claim = (col: "long_shift_warned_at" | "long_shift_nudged_at") =>
        c.query(`update public.time_entries set ${col} = now() where id = $1 and status = 'open' and ${col} is null returning id`, [id]);
      // The 10-hour bell line claims, and a second run's claim of it matches nothing.
      expect((await claim("long_shift_warned_at")).rows).toHaveLength(1);
      expect((await claim("long_shift_warned_at")).rows).toHaveLength(0);
      // The bell never stands in for the 12-hour question: that claim is still free, and also once.
      expect((await claim("long_shift_nudged_at")).rows).toHaveLength(1);
      expect((await claim("long_shift_nudged_at")).rows).toHaveLength(0);
    });
    expect(msg).toBeNull();
  });

  it("the service role can claim an open shift for the long-shift nudge", async () => {
    if (!needs()) return;
    const id = await entry("2001-01-01T16:00:00Z", null);
    const msg = await refusal(async () => {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await c.query("set local role service_role");
      const r = await c.query(
        "update public.time_entries set long_shift_nudged_at = now() where id = $1 and long_shift_nudged_at is null returning id",
        [id],
      );
      expect(r.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });
});
