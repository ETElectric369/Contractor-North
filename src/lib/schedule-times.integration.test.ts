import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { jobDayBlock, planJobTimes, workDayMinutes } from "@/lib/schedule/job-block";
import { tzDateTimeUtc } from "@/lib/tz";

/**
 * A JOB LANDS EXACTLY WHERE AND AS LONG AS CHOSEN, where it is stored: the database, with the office's
 * own session (Erik, 2026-09-28, J-058 Seiler · 3-way switches: "i set it for 2 hours and it jumped to a
 * later time block for many hours").
 *
 *   · the company's clock on any date: Postgres' own timezone database agrees with lib/tz's wall-clock
 *     conversion for a 9:00 start in March (both sides of the clock change), July and November (both
 *     sides), so the instants the writers build are the ones the database reads back as 9:00;
 *   · the schedule writer's one row write (writeScheduleRanges): the start, the end and a chosen length
 *     land together, read back exactly, and draw (jobDayBlock) as the block chosen, 10:00 to 12:00;
 *   · the days (job_schedule_segments) are replaced by the office, a worked day kept beside the plan;
 *   · Clear The Date: the listed day leaves, the Scheduled job waits for a day again, the worked day
 *     stays;
 *   · a visit's one person (setAppointmentAssignee) is the office's write;
 *   · the crew is refused every one of those writes: zero rows (the silent-write law, which each writer
 *     turns into words) or a policy refusal, and the job is unchanged. The app asks requireStaff first
 *     anyway; this proves the database agrees with it.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company
 * (lib/throwaway-org.db-fixture). No migration: these are the tables as they stand. People speak by
 * planted request.jwt.claims under `set local role authenticated`.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const LA = "America/Los_Angeles";
const WORK_DAY = { start: "09:00", end: "17:00" };

d("a job's start and length, stored (schedule writers)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let techId = "";

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
  /** A refused statement poisons the transaction; the savepoint takes it back (and the role with it). */
  const refused = async (uid: string, sql: string, params: unknown[]): Promise<string | null> => {
    await c.query("savepoint refused");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await c.query("set local role authenticated");
      const r = await c.query(sql, params);
      await c.query("release savepoint refused");
      await asServer();
      return r.rowCount === 0 ? "zero rows" : null;
    } catch (e) {
      await c.query("rollback to savepoint refused");
      await asServer();
      return String((e as { code?: string }).code ?? "error");
    }
  };
  const job = async (status = "scheduled") =>
    (await one("insert into public.jobs (org_id, name, status) values ($1, 'TEST schedule times job', $2::job_status) returning id::text as id", [orgId, status])).id as string;
  /** The schedule writer's own row write (writeScheduleRanges), as `uid`. */
  const writeTimes = (uid: string, id: string, t: { startIso: string | null; endIso: string | null; plannedMinutes?: number }) =>
    asPerson(uid, async () =>
      (
        await c.query(
          `update public.jobs set scheduled_start = $2::timestamptz, scheduled_end = $3::timestamptz,
             planned_minutes = coalesce($4::int, planned_minutes), updated_at = now()
           where id = $1 returning id::text as id`,
          [id, t.startIso, t.endIso, t.plannedMinutes ?? null],
        )
      ).rows,
    );
  const stored = (id: string) =>
    one(
      `select scheduled_start, scheduled_end, planned_minutes, status::text as status,
              to_char(scheduled_start at time zone $2, 'YYYY-MM-DD HH24:MI') as local_start,
              to_char(scheduled_end at time zone $2, 'YYYY-MM-DD HH24:MI') as local_end
         from public.jobs where id = $1`,
      [id, LA],
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    const org = await mintThrowawayOrg(c, { label: "schedule times", techs: 1 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    techId = org.techs[0].id;
    const set = await c.query(
      "update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('timezone', $2::text, 'work_day_start', '09:00', 'work_day_end', '17:00') where id = $1 returning id",
      [orgId, LA],
    );
    expect(set.rowCount).toBe(1);
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the company's clock on any date: Postgres reads lib/tz's 9:00 as 9:00, across both clock changes", async () => {
    for (const day of ["2026-03-06", "2026-03-08", "2026-03-09", "2026-07-15", "2026-11-01", "2026-11-02"]) {
      const js = tzDateTimeUtc(day, "09:00", LA)!;
      const pgIso = (await one("select to_char((($1::date + time '09:00') at time zone $2) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as iso", [day, LA])).iso;
      expect(js, day).toBe(pgIso);
    }
  });

  it("a 2h pick: the start, the end and the length land together, read back exactly, and draw 10 to 12", async () => {
    const id = await job();
    // J-058 as it was stored: 10 AM to the writer's 5 PM stamp, no length.
    const before = { scheduledStart: tzDateTimeUtc("2026-09-28", "10:00", LA), scheduledEnd: tzDateTimeUtc("2026-09-28", "17:00", LA), plannedMinutes: null };
    expect(await writeTimes(ownerId, id, { startIso: before.scheduledStart, endIso: before.scheduledEnd })).toHaveLength(1);

    const t = planJobTimes({ firstDay: "2026-09-28", lastDay: "2026-09-28", tz: LA, workDay: WORK_DAY, length: 120, prior: before });
    expect(await writeTimes(ownerId, id, t)).toHaveLength(1);
    const s = await stored(id);
    expect(s.local_start).toBe("2026-09-28 10:00");
    expect(s.local_end).toBe("2026-09-28 12:00");
    expect(s.planned_minutes).toBe(120);
    expect(
      jobDayBlock({
        day: "2026-09-28",
        scheduledStart: new Date(s.scheduled_start).toISOString(),
        scheduledEnd: new Date(s.scheduled_end).toISOString(),
        plannedMinutes: s.planned_minutes,
        tz: LA,
        wd: workDayMinutes(WORK_DAY),
      }),
    ).toEqual({ startMin: 600, endMin: 720, allDay: false });
  });

  it("no length: two hours from the start, the length column left blank", async () => {
    const id = await job("to_be_scheduled");
    const t = planJobTimes({ firstDay: "2026-11-02", lastDay: "2026-11-02", tz: LA, workDay: WORK_DAY, startTime: "09:00", prior: { scheduledStart: null, scheduledEnd: null, plannedMinutes: null } });
    expect(t.defaulted).toBe(true);
    expect(await writeTimes(ownerId, id, t)).toHaveLength(1);
    const s = await stored(id);
    expect([s.local_start, s.local_end, s.planned_minutes]).toEqual(["2026-11-02 09:00", "2026-11-02 11:00", null]);
  });

  it("the days: the office replaces them, a worked day kept beside the plan", async () => {
    const id = await job("in_progress");
    const rows = await asPerson(ownerId, async () => {
      await c.query("delete from public.job_schedule_segments where job_id = $1", [id]);
      return (
        await c.query(
          "insert into public.job_schedule_segments (job_id, start_date, end_date) values ($1, '2026-09-22', '2026-09-22'), ($1, '2026-09-28', '2026-09-28') returning id",
          [id],
        )
      ).rows;
    });
    expect(rows).toHaveLength(2);
    const days = (await c.query("select start_date::text as d from public.job_schedule_segments where job_id = $1 order by 1", [id])).rows.map((r) => r.d);
    expect(days).toEqual(["2026-09-22", "2026-09-28"]);
  });

  it("Clear The Date: the listed day leaves, a Scheduled job waits again, the worked day stays", async () => {
    const id = await job("scheduled");
    await writeTimes(ownerId, id, { startIso: tzDateTimeUtc("2026-09-28", "10:00", LA), endIso: tzDateTimeUtc("2026-09-28", "12:00", LA) });
    await asPerson(ownerId, async () => {
      await c.query("insert into public.job_schedule_segments (job_id, start_date, end_date) values ($1, '2026-09-22', '2026-09-22')", [id]);
      const cleared = await c.query("update public.jobs set scheduled_start = null, scheduled_end = null, updated_at = now() where id = $1 returning id", [id]);
      expect(cleared.rowCount).toBe(1);
      const back = await c.query("update public.jobs set status = 'to_be_scheduled' where id = $1 and status = 'scheduled' returning id", [id]);
      expect(back.rowCount).toBe(1);
    });
    const s = await stored(id);
    expect([s.scheduled_start, s.scheduled_end, s.status]).toEqual([null, null, "to_be_scheduled"]);
    expect((await one("select count(*)::int as n from public.job_schedule_segments where job_id = $1", [id])).n).toBe(1);
  });

  it("a visit's one person is the office's to set", async () => {
    const v = (
      await one(
        "insert into public.appointments (org_id, type, title, starts_at, status) values ($1, 'inspection', 'TEST schedule times visit', '2026-09-28T16:00:00Z', 'scheduled') returning id::text as id",
        [orgId],
      )
    ).id as string;
    const rows = await asPerson(ownerId, async () =>
      (await c.query("update public.appointments set assigned_to = $2, updated_at = now() where id = $1 returning id", [v, techId])).rows,
    );
    expect(rows).toHaveLength(1);
    expect((await one("select assigned_to::text as a from public.appointments where id = $1", [v])).a).toBe(techId);
  });

  it("the crew is refused every one of those writes, and nothing changes", async () => {
    const id = await job("scheduled");
    await writeTimes(ownerId, id, { startIso: tzDateTimeUtc("2026-09-28", "10:00", LA), endIso: tzDateTimeUtc("2026-09-28", "12:00", LA), plannedMinutes: 120 });

    expect(
      await refused(techId, "update public.jobs set scheduled_end = $2::timestamptz, planned_minutes = 480 where id = $1 returning id", [id, tzDateTimeUtc("2026-09-28", "17:00", LA)]),
    ).not.toBeNull();
    expect(
      await refused(techId, "insert into public.job_schedule_segments (job_id, start_date, end_date) values ($1, '2026-09-29', '2026-09-29') returning id", [id]),
    ).not.toBeNull();
    const v = (
      await one(
        "insert into public.appointments (org_id, type, title, starts_at, status, assigned_to) values ($1, 'inspection', 'TEST schedule times visit 2', '2026-09-28T16:00:00Z', 'scheduled', $2) returning id::text as id",
        [orgId, techId],
      )
    ).id as string;
    // Even on the visit he is going to (he may read it, 0227), the person on it is the office's.
    expect(await refused(techId, "update public.appointments set assigned_to = null where id = $1 returning id", [v])).not.toBeNull();

    const s = await stored(id);
    expect([s.local_start, s.local_end, s.planned_minutes]).toEqual(["2026-09-28 10:00", "2026-09-28 12:00", 120]);
    expect((await one("select count(*)::int as n from public.job_schedule_segments where job_id = $1", [id])).n).toBe(0);
    expect((await one("select assigned_to::text as a from public.appointments where id = $1", [v])).a).toBe(techId);
  });
});
