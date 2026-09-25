import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Migrations 0319, 0320 and 0321 (audit v994, the time clock wave), exercised where the rules live.
 *
 *   0319  a piece of a split shift (or its first entry) is never handed to another person (SW7);
 *   0320  joining a PAID split keeps its rounded paid hours (SW9);
 *   0321  a crew member cannot switch off the office's long-shift bell and buzz (TL3).
 *
 * Runs as office staff, a tech and the service role by planting request.jwt.claims and `set local
 * role`, exactly as PostgREST does, inside ONE transaction that is always rolled back. Every fixture
 * sits on 2001-01-01, a day nobody worked.
 *
 * BEFORE THE MIGRATIONS ARE APPLIED each case says so on the console and returns (loud, not a green
 * lie). Set TEST_APPLY_PENDING=1 to load the three files INSIDE the rolled-back transaction and
 * exercise them anyway: that takes a lock on time_entries for the few seconds the suite runs, so it
 * is for a practice run, never for CI.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… [TEST_APPLY_PENDING=1] npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, TEST_APPLY_PENDING } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const MIGRATIONS = [
  "0319_a_split_shift_stays_with_its_person.sql",
  "0320_joining_a_paid_split_keeps_its_hours.sql",
  "0321_the_office_bell_is_not_the_crews_to_silence.sql",
];

const SPLIT_PERSON = /This shift was split into parts\. Join the split back first, then move the shift to someone else\./;
const JOIN_PAID = /Joining these would change the paid hours on this shift by 0\.01 h\. Leave them split, or undo the pay on Payroll first\./;
const CLAIMS = /Only the office's long-shift check can mark a shift as asked about\./;

d("audit v994 time wave: 0319, 0320, 0321", () => {
  let c: pg.Client;
  const has = { "0319": false, "0320": false, "0321": false };
  let orgId = "";
  let staffId = "";
  let techId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asService = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await c.query("set local role service_role");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Runs inside its own savepoint: the error it was refused with, or null when it went through.
   *  Either way nothing it did survives into the next case. */
  const attempt = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      return null;
    } catch (e) {
      return String((e as Error)?.message ?? e);
    } finally {
      await c.query("rollback to savepoint attempt");
      await asServer();
    }
  };
  const needs = (m: keyof typeof has) => {
    if (!has[m]) console.warn(`[audit994-time] migration ${m} is not on this database yet; apply it (or TEST_APPLY_PENDING=1) to exercise this case.`);
    return has[m];
  };
  /** A fixture row, written as the server (a privileged writer). */
  const entry = async (e: {
    profile: string;
    in: string;
    out?: string | null;
    lunch?: number;
    paid?: boolean;
    splitFrom?: string | null;
    how?: string | null;
  }): Promise<string> =>
    (
      await one(
        `insert into public.time_entries (org_id, profile_id, clock_in, clock_out, status, source, lunch_minutes, paid_at,
                                          split_from, split_how, notes)
         values ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, 'TEST audit994') returning id`,
        [
          orgId,
          e.profile,
          e.in,
          e.out ?? null,
          e.out ? "closed" : "open",
          e.lunch ?? 0,
          e.paid ? "2001-01-05T00:00:00Z" : null,
          e.splitFrom ?? null,
          e.how ?? null,
        ],
      )
    ).id;

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
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");

    const probe = async () => {
      const cols = await one(
        `select string_agg(a.attname, ',' order by a.attname) as cols
           from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
          where t.tgrelid = 'public.time_entries'::regclass and t.tgname = 'guard_time_entry_split_link'`,
      );
      has["0319"] = cols?.cols === "profile_id,split_from,split_how";
      const join = await one(
        `select prosrc ilike '%Joining these would change the paid hours%' as ok
           from pg_proc where oid = to_regprocedure('public.join_time_entries(uuid, uuid)')`,
      );
      has["0320"] = !!join?.ok;
      const claims = await one(
        `select 1 as ok from pg_trigger
          where tgrelid = 'public.time_entries'::regclass and tgname = 'guard_time_entry_long_shift_claims' and tgenabled <> 'D'`,
      );
      has["0321"] = !!claims?.ok;
    };
    await probe();
    if (TEST_APPLY_PENDING === "1") {
      const dir = path.join(process.cwd(), "supabase", "migrations");
      for (const f of MIGRATIONS) await c.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await probe();
    }

    // An org with an active tech who has nothing on the clock, and active office staff.
    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner', 'admin', 'office') and coalesce(s.active, true)
        where t.role = 'tech' and coalesce(t.active, true)
          and not exists (select 1 from public.time_entries x where x.profile_id = t.id and x.status = 'open')
          and not exists (select 1 from public.time_entries x
                           where x.profile_id in (t.id, s.id) and x.clock_in < '2001-01-03' and x.clock_out > '2000-12-31')
        order by (s.role = 'owner') desc, t.id
        limit 1`,
    );
    if (!fx) throw new Error("audit994-time fixture: no org has an idle active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  // ── 0319 ─────────────────────────────────────────────────────────────────────────────────────
  it("0319: the office cannot hand a piece of a split shift to another person", async () => {
    if (!needs("0319")) return;
    const msg = await attempt(async () => {
      const head = await entry({ profile: techId, in: "2001-01-01T16:00:00Z", out: "2001-01-01T19:00:00Z" });
      const piece = await entry({ profile: techId, in: "2001-01-01T19:00:00Z", out: "2001-01-01T22:00:00Z", splitFrom: head, how: "after" });
      await as(staffId);
      await c.query("update public.time_entries set profile_id = $2 where id = $1", [piece, staffId]);
    });
    expect(msg).toMatch(SPLIT_PERSON);
  });

  it("0319: nor the split shift's first entry", async () => {
    if (!needs("0319")) return;
    const msg = await attempt(async () => {
      const head = await entry({ profile: techId, in: "2001-01-01T16:00:00Z", out: "2001-01-01T19:00:00Z" });
      await entry({ profile: techId, in: "2001-01-01T19:00:00Z", out: "2001-01-01T22:00:00Z", splitFrom: head, how: "after" });
      await as(staffId);
      await c.query("update public.time_entries set profile_id = $2 where id = $1", [head, staffId]);
    });
    expect(msg).toMatch(SPLIT_PERSON);
  });

  it("0319: an ordinary shift still moves to someone else", async () => {
    if (!needs("0319")) return;
    const msg = await attempt(async () => {
      const id = await entry({ profile: techId, in: "2001-01-01T16:00:00Z", out: "2001-01-01T19:00:00Z" });
      await as(staffId);
      const r = await c.query("update public.time_entries set profile_id = $2 where id = $1 returning id", [id, staffId]);
      expect(r.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });

  it("0319: a notes fix on a split piece still saves", async () => {
    if (!needs("0319")) return;
    const msg = await attempt(async () => {
      const head = await entry({ profile: techId, in: "2001-01-01T16:00:00Z", out: "2001-01-01T19:00:00Z" });
      const piece = await entry({ profile: techId, in: "2001-01-01T19:00:00Z", out: "2001-01-01T22:00:00Z", splitFrom: head, how: "after" });
      await as(staffId);
      const r = await c.query("update public.time_entries set notes = 'TEST audit994 fixed' where id = $1 returning id", [piece]);
      expect(r.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });

  // ── 0320 ─────────────────────────────────────────────────────────────────────────────────────
  it("0320: two paid 10-minute pieces (0.17 + 0.17 h) are not joined into 0.33 h", async () => {
    if (!needs("0320")) return;
    const msg = await attempt(async () => {
      const l = await entry({ profile: techId, in: "2001-01-01T18:00:00Z", out: "2001-01-01T18:10:00Z", paid: true });
      const r = await entry({ profile: techId, in: "2001-01-01T18:10:00Z", out: "2001-01-01T18:20:00Z", paid: true, splitFrom: l, how: "after" });
      await as(staffId);
      await c.query("select public.join_time_entries($1, $2)", [l, r]);
    });
    expect(msg).toMatch(JOIN_PAID);
  });

  it("0320: a paid pair whose rounded hours add up still joins", async () => {
    if (!needs("0320")) return;
    const msg = await attempt(async () => {
      const l = await entry({ profile: techId, in: "2001-01-01T18:00:00Z", out: "2001-01-01T18:30:00Z", paid: true });
      const r = await entry({ profile: techId, in: "2001-01-01T18:30:00Z", out: "2001-01-01T19:00:00Z", paid: true, splitFrom: l, how: "after" });
      await as(staffId);
      const res = await one("select public.join_time_entries($1, $2) as j", [l, r]);
      expect(Number(res.j.hours)).toBe(1);
    });
    expect(msg).toBeNull();
  });

  it("0320: an unpaid pair joins whatever the rounding (nothing was paid on it)", async () => {
    if (!needs("0320")) return;
    const msg = await attempt(async () => {
      const l = await entry({ profile: techId, in: "2001-01-01T18:00:00Z", out: "2001-01-01T18:10:00Z" });
      const r = await entry({ profile: techId, in: "2001-01-01T18:10:00Z", out: "2001-01-01T18:20:00Z", splitFrom: l, how: "after" });
      await as(staffId);
      const res = await one("select public.join_time_entries($1, $2) as j", [l, r]);
      expect(Number(res.j.hours)).toBe(0.33);
    });
    expect(msg).toBeNull();
  });

  // ── 0321 ─────────────────────────────────────────────────────────────────────────────────────
  it("0321: a tech cannot mark his own running clock as already asked about", async () => {
    if (!needs("0321")) return;
    for (const col of ["long_shift_warned_at", "long_shift_nudged_at"]) {
      const msg = await attempt(async () => {
        const id = await entry({ profile: techId, in: "2001-01-01T16:00:00Z" });
        await as(techId);
        await c.query(`update public.time_entries set ${col} = now() where id = $1`, [id]);
      });
      expect(msg).toMatch(CLAIMS);
    }
  });

  it("0321: nor clock in with the claims already set", async () => {
    if (!needs("0321")) return;
    const msg = await attempt(async () => {
      await as(techId);
      await c.query(
        `insert into public.time_entries (org_id, profile_id, clock_in, status, source, long_shift_warned_at, long_shift_nudged_at)
         values ($1, $2, now(), 'open', 'app', now(), now())`,
        [orgId, techId],
      );
    });
    expect(msg).toMatch(CLAIMS);
  });

  it("0321: a tech's own ordinary edits and a clock-in with empty claims still go through", async () => {
    if (!needs("0321")) return;
    const msg = await attempt(async () => {
      const id = await entry({ profile: techId, in: "2001-01-01T16:00:00Z" });
      await as(techId);
      const r = await c.query("update public.time_entries set notes = 'TEST audit994 note' where id = $1 returning id", [id]);
      expect(r.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });

  it("0321: the long-shift job (service role) still claims both steps, and the office may too", async () => {
    if (!needs("0321")) return;
    const msg = await attempt(async () => {
      const id = await entry({ profile: techId, in: "2001-01-01T16:00:00Z" });
      await asService();
      const r = await c.query(
        "update public.time_entries set long_shift_warned_at = now(), long_shift_nudged_at = now() where id = $1 returning id",
        [id],
      );
      expect(r.rows).toHaveLength(1);
      await asServer();
      await as(staffId);
      const r2 = await c.query("update public.time_entries set long_shift_warned_at = null where id = $1 returning id", [id]);
      expect(r2.rows).toHaveLength(1);
    });
    expect(msg).toBeNull();
  });
});
