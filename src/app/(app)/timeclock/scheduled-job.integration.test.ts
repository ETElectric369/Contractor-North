import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { NOTHING_SCHEDULED, scheduledJobFor } from "./scheduled-job";

/**
 * WHERE THE SCHEDULE PUT SOMEONE, READ BY THE OFFICE, on the TEST database (Wave 2, W2-03).
 *
 * Add Time Entry starts its Job field on where the schedule put the person that day. The office is
 * adding hours for SOMEBODY ELSE, so the reads run as the office, not as the person: the RLS client
 * of an owner must read another member's crew_day_assignments row (0139's read policy is the whole
 * company's, the way the crew board reads it), the roster (jobs.assigned_to) and the segments.
 * scheduledJobFor itself runs here, through a small adapter that turns its supabase-js calls into the
 * same SQL PostgREST would run, under `set local role authenticated` and planted JWT claims: the real
 * column names, the real filters, the real policies.
 *
 * ONE connection, BEGIN first, a throwaway company minted inside the transaction, ROLLBACK at the
 * end. Every read and write names this company's id; nothing touches a live company.
 *
 *   CI=true TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const TZ = "America/Los_Angeles";
const TIMESTAMPTZ = 1184;
const DATE = 1082;

/**
 * The supabase-js calls scheduledJobFor makes (select / eq / in / contains / lte / gte, then
 * maybeSingle or a plain await), run as SQL on this connection. A date comes back as the
 * "YYYY-MM-DD" PostgREST sends; a timestamptz as an ISO string.
 */
function pgAdapter(c: pg.Client) {
  const types = {
    getTypeParser: (oid: number, format?: string) => {
      if (oid === DATE) return (v: string) => v;
      const base = pg.types.getTypeParser(oid, (format ?? "text") as "text");
      if (oid === TIMESTAMPTZ) return (v: string) => (base(v) as Date).toISOString();
      return base;
    },
  };
  return {
    from(table: string) {
      let cols = "*";
      const where: string[] = [];
      const values: unknown[] = [];
      const param = (v: unknown) => {
        values.push(v);
        return `$${values.length}`;
      };
      const run = (): Promise<pg.QueryResult> =>
        c.query({ text: `select ${cols} from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""}`, values, types } as any);
      const chain: any = {
        select(s: string) {
          cols = s;
          return chain;
        },
        eq(col: string, v: unknown) {
          where.push(`${col} = ${param(v)}`);
          return chain;
        },
        in(col: string, vs: unknown[]) {
          where.push(`${col}::text = any(${param(vs)}::text[])`);
          return chain;
        },
        contains(col: string, vs: unknown[]) {
          where.push(`${col} @> ${param(vs)}`);
          return chain;
        },
        lte(col: string, v: unknown) {
          where.push(`${col} <= ${param(v)}`);
          return chain;
        },
        gte(col: string, v: unknown) {
          where.push(`${col} >= ${param(v)}`);
          return chain;
        },
        async maybeSingle() {
          const r = await run();
          if (r.rows.length > 1) return { data: null, error: { message: "more than one row" } };
          return { data: r.rows[0] ?? null, error: null };
        },
        then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
          return run().then((r) => ({ data: r.rows, error: null }), err).then(ok, err);
        },
      };
      return chain;
    },
  };
}

d("where the schedule put someone, read by the office (scheduledJobFor on the TEST database)", () => {
  let c: pg.Client;
  let orgId = "";
  let ownerId = "";
  let brianId = "";
  let jimmyId = "";
  let strangerId = "";
  const jobs = { tuesday: "", segment: "", dayRow: "", evening: "", finished: "", gap: "", siskin: "" };

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** Run as `uid` (a real sign-in's claims under the authenticated role), inside a savepoint so a
   *  refusal never ends the transaction; always back to the server after. */
  const as = async <T,>(uid: string, fn: () => Promise<T>): Promise<T> => {
    await c.query("savepoint as_person");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await c.query("set local role authenticated");
      const out = await fn();
      await c.query("release savepoint as_person");
      return out;
    } catch (e) {
      await c.query("rollback to savepoint as_person");
      throw e;
    } finally {
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
    }
  };
  const job = async (name: string, status: string, start: string | null, end: string | null, crew: string[]) =>
    String(
      (
        await one(
          `insert into jobs (org_id, name, job_number, status, billing_type, assigned_to, scheduled_start, scheduled_end)
           values ($1, $2, $3, $4, 'tm', $5::uuid[], $6, $7) returning id`,
          [orgId, `TEST ${name}`, `TEST-SJ-${name}`, status, crew, start, end],
        )
      ).id,
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const org = await mintThrowawayOrg(c, { label: "scheduled job", techs: 2 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    brianId = org.techs[0].id;
    jimmyId = org.techs[1].id;
    strangerId = (await mintThrowawayOrg(c, { label: "scheduled job stranger", techs: 0 })).owner.id;

    // Brian's January (January is Pacific STANDARD time: UTC-8).
    // Tue Jan 2, 8 AM to 5 PM: the 5 PM is Jan 3, 01:00 UTC.
    jobs.tuesday = await job("tuesday", "in_progress", "2001-01-02 16:00+00", "2001-01-03 01:00+00", [brianId]);
    // A job whose days are its segments: Wed Jan 10 only, 8 AM to 5 PM (the job's own dates mirror
    // its segments' first and last day, 0040).
    jobs.segment = await job("segment", "scheduled", "2001-01-10 16:00+00", "2001-01-11 01:00+00", [brianId]);
    await c.query("insert into job_schedule_segments (org_id, job_id, start_date, end_date) values ($1, $2, '2001-01-10', '2001-01-10')", [orgId, jobs.segment]);
    // A GAP: day rows on Mon Jan 22 and Fri Jan 26 only, its window mirroring them (Jan 22 8 AM to
    // Jan 26 5 PM). Siskin is booked Tue Jan 23 at 10 AM with no day rows (its window answers).
    jobs.gap = await job("gap", "scheduled", "2001-01-22 16:00+00", "2001-01-27 01:00+00", [brianId]);
    await c.query(
      "insert into job_schedule_segments (org_id, job_id, start_date, end_date) values ($1, $2, '2001-01-22', '2001-01-22'), ($1, $2, '2001-01-26', '2001-01-26')",
      [orgId, jobs.gap],
    );
    jobs.siskin = await job("siskin", "scheduled", "2001-01-23 18:00+00", null, [brianId]);
    // Booked for Mon Jan 15 at 6 PM: stored as Jan 16, 02:00 UTC.
    jobs.evening = await job("evening", "scheduled", "2001-01-16 02:00+00", null, [brianId]);
    // The office put Brian on this one for Fri Jan 5 on the crew board; nobody rostered him on it.
    jobs.dayRow = await job("dayrow", "scheduled", null, null, [jimmyId]);
    // Finished: a day row naming it is not resurrected.
    jobs.finished = await job("finished", "complete", null, null, [brianId]);
    for (const [day, kind, jobId] of [
      ["2001-01-05", "job", jobs.dayRow],
      ["2001-01-06", "off", null],
      ["2001-01-02", "job", jobs.finished],
    ] as const) {
      await c.query(
        "insert into crew_day_assignments (org_id, profile_id, work_date, kind, job_id) values ($1, $2, $3, $4, $5)",
        [orgId, brianId, day, kind, jobId],
      );
    }
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the office's own RLS client reads ANOTHER member's day row, the way the crew board does", async () => {
    const rows = await as(ownerId, async () =>
      (
        await c.query("select job_id::text as job_id, kind from crew_day_assignments where org_id = $1 and profile_id = $2 order by work_date", [
          orgId,
          brianId,
        ])
      ).rows,
    );
    expect(rows).toEqual([
      { job_id: jobs.finished, kind: "job" },
      { job_id: jobs.dayRow, kind: "job" },
      { job_id: null, kind: "off" },
    ]);
  });

  it("another company's office reads none of it", async () => {
    const n = await as(strangerId, async () => (await one("select count(*)::int as n from crew_day_assignments where org_id = $1", [orgId])).n);
    expect(n).toBe(0);
  });

  it("scheduledJobFor, as the office, for Brian: the day row wins, and OFF fails closed", async () => {
    const sb = pgAdapter(c) as any;
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-05", TZ))).toEqual({ off: false, jobId: jobs.dayRow });
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-06", TZ))).toEqual({ off: true, jobId: null });
  });

  it("a day row naming a finished job falls through to the roster: Tuesday's own window", async () => {
    const sb = pgAdapter(c) as any;
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-02", TZ))).toEqual({ off: false, jobId: jobs.tuesday });
  });

  it("the window is read in company days: Tuesday's 5 PM end does not make it Wednesday's job", async () => {
    const sb = pgAdapter(c) as any;
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-03", TZ))).toEqual(NOTHING_SCHEDULED);
  });

  it("a segment covers its day, and only its day", async () => {
    const sb = pgAdapter(c) as any;
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-10", TZ))).toEqual({ off: false, jobId: jobs.segment });
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-11", TZ))).toEqual(NOTHING_SCHEDULED);
  });

  it("a gap between a job's day rows is not its day: the job booked that day wins, and a bare gap is nothing", async () => {
    const sb = pgAdapter(c) as any;
    // Tue Jan 23: the gap job's window spans it, but its day rows are Jan 22 and Jan 26 only.
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-23", TZ))).toEqual({ off: false, jobId: jobs.siskin });
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-24", TZ))).toEqual(NOTHING_SCHEDULED);
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-22", TZ))).toEqual({ off: false, jobId: jobs.gap });
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-26", TZ))).toEqual({ off: false, jobId: jobs.gap });
  });

  it("an evening start stays on its own company day", async () => {
    const sb = pgAdapter(c) as any;
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-15", TZ))).toEqual({ off: false, jobId: jobs.evening });
    expect(await as(ownerId, () => scheduledJobFor(sb, brianId, "2001-01-16", TZ))).toEqual(NOTHING_SCHEDULED);
  });

  it("another company's office gets nothing for Brian, even on the day the board put him somewhere", async () => {
    const sb = pgAdapter(c) as any;
    expect(await as(strangerId, () => scheduledJobFor(sb, brianId, "2001-01-05", TZ))).toEqual(NOTHING_SCHEDULED);
    expect(await as(strangerId, () => scheduledJobFor(sb, brianId, "2001-01-06", TZ))).toEqual(NOTHING_SCHEDULED);
  });
});
