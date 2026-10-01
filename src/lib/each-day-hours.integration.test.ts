import { describe, it as vitestIt, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { jobDayBlock, workDayMinutes } from "@/lib/schedule/job-block";
import { readDayHours } from "@/lib/schedule/day-hours";
import { tzDateTimeUtc, tzOffsetMs } from "@/lib/tz";

/**
 * EACH DAY KEEPS ITS OWN HOURS (0370), where it is stored: the database, with the office's own session
 * and the customer's anonymous pick-a-date tap. Erik, 2026-09-28: "i want to put heringbone on the page
 * for the rest of the day after Seiler".
 *
 *   A · job_schedule_segments carries start_time / end_time: a day's own hours, set together or not at
 *       all, the end after the start; the office writes them and reads them back as the wall clock it
 *       wrote (the calendar draws them, jobDayBlock); a tech reads them (0266) and can't write them; the
 *       signed-in role holds the column privileges;
 *   B · the customer's pick (choose_schedule_slot / choose_schedule_date, re-created from 0222's bodies)
 *       lands at the picked time, else the company's work-day start, for the job's length, else two
 *       hours, never past the day; beside the job's other days, never replacing them: a job with no
 *       plan gets the day as its plan (worked days kept, stale ones dropped, a hold woken), a job with a
 *       plan keeps every day, the new day at its own hours and no other day moved; a finished job is
 *       refused; the times hold across a clock change; the appointment branch starts at the work day;
 *   and the helpers are no door of their own, and 0370 runs twice without complaint.
 *
 * Everything happens inside ONE transaction that is always rolled back, on a throwaway company
 * (lib/throwaway-org.db-fixture). 0370 is applied inside that transaction (the file on this branch, so
 * what is asserted is exactly what ships). People speak by planted request.jwt.claims under `set local
 * role authenticated` (the office, a tech) or `anon` (the customer's browser).
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const migrations = join(process.cwd(), "supabase/migrations");
const M0370 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0370_"))!), "utf8");
// 0372 re-creates job_day_block_min on the rule the app draws since cn-v1031 (a job's hours are its
// hours on each of its days); applied after 0370, exactly as the database will carry it.
const M0372 = readFileSync(join(migrations, readdirSync(migrations).find((n) => n.startsWith("0372_"))!), "utf8");
const LA = "America/Los_Angeles";
const WORK_DAY = { start: "09:00", end: "17:00" };

/** YYYY-MM-DD `n` days after the company's today (the picks refuse a day already gone, so every day
 *  here is ahead of the real clock, whenever this runs). */
function ahead(n: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: LA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
/** The first day after the next clock change in Los Angeles (fall back or spring forward). */
function dayAfterNextClockChange(): string {
  for (let n = 2; n < 400; n++) {
    const before = ahead(n - 1);
    const day = ahead(n);
    if (tzOffsetMs(LA, new Date(`${before}T20:00:00Z`)) !== tzOffsetMs(LA, new Date(`${day}T20:00:00Z`))) return day;
  }
  throw new Error("no clock change within 400 days");
}

d("each day keeps its own hours (0370)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let techId = "";
  let n = 0;

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
  /** Run as `uid` (a signed-in person), or as the anonymous customer (null), then back to the server. */
  const as = async <T>(uid: string | null, fn: () => Promise<T>): Promise<T> => {
    if (uid) {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await c.query("set local role authenticated");
    } else {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      await c.query("set local role anon");
    }
    try {
      return await fn();
    } finally {
      await asServer();
    }
  };
  /** A refused statement poisons the transaction; the savepoint takes it back (and the role with it). */
  const refused = async (uid: string | null, sql: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint refused");
    try {
      if (uid) {
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
        await c.query("set local role authenticated");
      } else {
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
        await c.query("set local role anon");
      }
      const r = await c.query(sql, params);
      await c.query("release savepoint refused");
      await asServer();
      return r.rowCount === 0 ? "zero rows" : null;
    } catch (e) {
      await c.query("rollback to savepoint refused");
      await asServer();
      return String((e as { message?: string }).message ?? (e as { code?: string }).code ?? "error");
    }
  };
  const job = async (p: { status?: string; start?: string | null; end?: string | null; planned?: number | null; holdReason?: string | null } = {}) =>
    (
      await one(
        `insert into public.jobs (org_id, name, status, scheduled_start, scheduled_end, planned_minutes, hold_reason)
         values ($1, $2, $3::job_status, $4::timestamptz, $5::timestamptz, $6, $7) returning id::text as id`,
        [orgId, `TEST 0370 job ${++n}`, p.status ?? "to_be_scheduled", p.start ?? null, p.end ?? null, p.planned ?? null, p.holdReason ?? null],
      )
    ).id as string;
  const seg = (jobId: string, start: string, end = start, hours: [string, string] | null = null) =>
    c.query(
      "insert into public.job_schedule_segments (org_id, job_id, start_date, end_date, start_time, end_time) values ($1, $2, $3, $4, $5, $6)",
      [orgId, jobId, start, end, hours?.[0] ?? null, hours?.[1] ?? null],
    );
  /** A job's days as "start..end hh:mm-hh:mm" (or "usual"), in order. */
  const days = async (jobId: string) =>
    (
      await c.query(
        `select start_date::text as s, end_date::text as e, to_char(start_time, 'HH24:MI') as st, to_char(end_time, 'HH24:MI') as et
           from public.job_schedule_segments where job_id = $1 order by start_date`,
        [jobId],
      )
    ).rows.map((r) => `${r.s}..${r.e} ${r.st ? `${r.st}-${r.et}` : "usual"}`);
  const stored = (jobId: string) =>
    one(
      `select status::text as status, hold_reason, planned_minutes,
              to_char(scheduled_start at time zone $2, 'YYYY-MM-DD HH24:MI') as local_start,
              to_char(scheduled_end at time zone $2, 'YYYY-MM-DD HH24:MI') as local_end,
              scheduled_start, scheduled_end
         from public.jobs where id = $1`,
      [jobId, LA],
    );
  /** A pick-a-date link out to the customer for `jobId`, with these options. */
  const link = async (jobId: string, dates: unknown[]) =>
    (await one("insert into public.schedule_proposals (org_id, job_id, dates) values ($1, $2, $3::jsonb) returning token", [orgId, jobId, JSON.stringify(dates)]))
      .token as string;
  /** The customer's tap, from their (anonymous) browser. */
  const pickSlot = (token: string, i: number) => as(null, async () => (await c.query("select public.choose_schedule_slot($1, $2) as r", [token, i])).rows[0].r);
  const pickDate = (token: string, day: string) => as(null, async () => (await c.query("select public.choose_schedule_date($1, $2::date) as r", [token, day])).rows[0].r);

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    await c.query("set local statement_timeout = '30s'");
    // The files on this branch, twice: they must run twice without complaint.
    await c.query(M0370);
    await c.query(M0370);
    await c.query(M0372);
    await c.query(M0372);

    const org = await mintThrowawayOrg(c, { label: "0370 each day's hours", techs: 1 });
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

  // ── A. A day's own hours ────────────────────────────────────────────────────────────────────
  it("the two columns are the company's wall clock, set together or not at all, the end after the start", async () => {
    const cols = (
      await c.query(
        "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'job_schedule_segments' and column_name in ('start_time', 'end_time') order by 1",
      )
    ).rows;
    expect(cols).toEqual([
      { column_name: "end_time", data_type: "time without time zone" },
      { column_name: "start_time", data_type: "time without time zone" },
    ]);
    const id = await job({ status: "scheduled" });
    expect(await refused(ownerId, "insert into public.job_schedule_segments (job_id, start_date, end_date, start_time) values ($1, '2026-10-05', '2026-10-05', '12:00')", [id])).toMatch(/hours_pair/);
    expect(
      await refused(ownerId, "insert into public.job_schedule_segments (job_id, start_date, end_date, start_time, end_time) values ($1, '2026-10-05', '2026-10-05', '17:00', '12:00')", [id]),
    ).toMatch(/hours_order/);
  });

  it("the office writes a day's own hours and reads back the wall clock it wrote; the calendar draws exactly that", async () => {
    const id = await job({ status: "in_progress", start: tzDateTimeUtc("2026-09-24", "09:00", LA), end: tzDateTimeUtc("2026-09-28", "17:00", LA) });
    const rows = await as(ownerId, async () =>
      (
        await c.query(
          "insert into public.job_schedule_segments (job_id, start_date, end_date, start_time, end_time) values ($1, '2026-09-24', '2026-09-24', null, null), ($1, '2026-09-28', '2026-09-28', '12:00', '17:00') returning id",
          [id],
        )
      ).rows,
    );
    expect(rows).toHaveLength(2);
    const back = await as(ownerId, async () =>
      (await c.query("select start_date::text as d, start_time, end_time from public.job_schedule_segments where job_id = $1 order by 1", [id])).rows,
    );
    expect(back.map((r) => [r.d, readDayHours(r.start_time, r.end_time)])).toEqual([
      ["2026-09-24", null],
      ["2026-09-28", { start: "12:00", end: "17:00" }],
    ]);
    const s = await stored(id);
    expect(
      jobDayBlock({
        day: "2026-09-28",
        scheduledStart: new Date(s.scheduled_start).toISOString(),
        scheduledEnd: new Date(s.scheduled_end).toISOString(),
        plannedMinutes: null,
        tz: LA,
        wd: workDayMinutes(WORK_DAY),
        dayHours: readDayHours(back[1].start_time, back[1].end_time),
      }),
    ).toEqual({ startMin: 720, endMin: 1020, allDay: false });
  });

  it("a tech reads a day's own hours (0266) and can't write them; the signed-in role holds the column privileges", async () => {
    const id = await job({ status: "scheduled" });
    await seg(id, "2026-10-06", "2026-10-06", ["12:00", "15:00"]);
    const seen = await as(techId, async () => (await c.query("select to_char(start_time, 'HH24:MI') as st from public.job_schedule_segments where job_id = $1", [id])).rows);
    expect(seen).toEqual([{ st: "12:00" }]);
    expect(await refused(techId, "update public.job_schedule_segments set start_time = '07:00', end_time = '08:00' where job_id = $1 returning id", [id])).not.toBeNull();
    expect((await days(id))).toEqual(["2026-10-06..2026-10-06 12:00-15:00"]);
    const g = await one(
      `select has_column_privilege('authenticated', 'public.job_schedule_segments', 'start_time', 'SELECT') as s,
              has_column_privilege('authenticated', 'public.job_schedule_segments', 'end_time', 'INSERT') as i,
              has_column_privilege('authenticated', 'public.job_schedule_segments', 'start_time', 'UPDATE') as u`,
    );
    expect(g).toEqual({ s: true, i: true, u: true });
  });

  // ── B. The customer's pick ─────────────────────────────────────────────────────────────────
  it("a picked time lands at that time for two hours (a job nobody sized), never + 8 hours; the day is its plan", async () => {
    const day = ahead(10);
    const id = await job();
    const token = await link(id, [{ date: day, time: "13:00" }]);
    expect((await pickSlot(token, 0)).ok).toBe(true);
    const s = await stored(id);
    expect([s.local_start, s.local_end, s.status, s.planned_minutes]).toEqual([`${day} 13:00`, `${day} 15:00`, "scheduled", null]);
    expect(await days(id)).toEqual([`${day}..${day} usual`]);
    expect((await one("select status, chosen_date::text as d from public.schedule_proposals where token = $1", [token]))).toEqual({ status: "confirmed", d: day });
  });

  it("no time picked: the company's work-day start (9:00 here), never 08:00-16:00; the job's size when it has one; a day or more to closing", async () => {
    const day = ahead(11);
    const a = await job();
    expect((await pickSlot(await link(a, [{ date: day, time: "" }]), 0)).ok).toBe(true);
    expect([(await stored(a)).local_start, (await stored(a)).local_end]).toEqual([`${day} 09:00`, `${day} 11:00`]);
    const b = await job({ planned: 240 });
    expect((await pickSlot(await link(b, [day]), 0)).ok).toBe(true);
    expect([(await stored(b)).local_start, (await stored(b)).local_end, (await stored(b)).planned_minutes]).toEqual([`${day} 09:00`, `${day} 13:00`, 240]);
    const big = await job({ planned: 960 });
    expect((await pickSlot(await link(big, [{ date: day, time: "10:30" }]), 0)).ok).toBe(true);
    expect([(await stored(big)).local_start, (await stored(big)).local_end]).toEqual([`${day} 10:30`, `${day} 17:00`]);
    // Never past the day: a late pick for a long job stops at 11:59 PM.
    const late = await job({ planned: 300 });
    expect((await pickSlot(await link(late, [{ date: day, time: "21:00" }]), 0)).ok).toBe(true);
    expect((await stored(late)).local_end).toBe(`${day} 23:59`);
  });

  it("the older date-only pick (choose_schedule_date) likewise: the work day's start, two hours", async () => {
    const day = ahead(12);
    const id = await job();
    expect((await pickDate(await link(id, [day]), day)).ok).toBe(true);
    const s = await stored(id);
    expect([s.local_start, s.local_end]).toEqual([`${day} 09:00`, `${day} 11:00`]);
    expect(await days(id)).toEqual([`${day}..${day} usual`]);
  });

  it("the other days stay: a worked day kept as history (with its hours), a stale unworked day gone, a hold woken", async () => {
    const day = ahead(13);
    const worked = ahead(-5);
    const stale = ahead(-3);
    const id = await job({ status: "on_hold", start: tzDateTimeUtc(stale, "09:00", LA), end: tzDateTimeUtc(stale, "17:00", LA), holdReason: "Waiting on the permit" });
    await seg(id, worked, worked, ["07:00", "15:00"]);
    await seg(id, stale);
    // The worked day: a visit closed out as done that day.
    await c.query(
      "insert into public.appointments (org_id, type, title, starts_at, status, job_id) values ($1, 'service_call', 'TEST 0370 done visit', $2::timestamptz, 'completed', $3)",
      [orgId, tzDateTimeUtc(worked, "08:00", LA), id],
    );
    expect((await pickSlot(await link(id, [{ date: day, time: "08:00" }]), 0)).ok).toBe(true);
    expect(await days(id)).toEqual([`${worked}..${worked} 07:00-15:00`, `${day}..${day} usual`]);
    const s = await stored(id);
    expect([s.status, s.hold_reason, s.local_start, s.local_end]).toEqual(["scheduled", null, `${day} 08:00`, `${day} 10:00`]);
  });

  it("a job with a plan keeps every day: the picked day joins at its own hours, and the day it had keeps its 10 to 12", async () => {
    const first = ahead(14);
    const day = ahead(16);
    const id = await job({ status: "in_progress", start: tzDateTimeUtc(first, "10:00", LA), end: tzDateTimeUtc(first, "12:00", LA) });
    await seg(id, first);
    expect((await pickSlot(await link(id, [{ date: day, time: "13:00" }]), 0)).ok).toBe(true);
    expect(await days(id)).toEqual([`${first}..${first} 10:00-12:00`, `${day}..${day} 13:00-15:00`]);
    const s = await stored(id);
    // The span grows to cover it (its start kept, the last day to closing); In Progress stays.
    expect([s.local_start, s.local_end, s.status]).toEqual([`${first} 10:00`, `${day} 17:00`, "in_progress"]);
    // Picked again on a day it already has, of several: that day runs at the new time, nothing else moves.
    expect((await pickSlot(await link(id, [{ date: day, time: "07:00" }]), 0)).ok).toBe(true);
    expect(await days(id)).toEqual([`${first}..${first} 10:00-12:00`, `${day}..${day} 07:00-09:00`]);
  });

  it("the job's one day picked again is its time: its hours move, no day of its own", async () => {
    const first = ahead(17);
    const id = await job({ status: "scheduled", start: tzDateTimeUtc(first, "10:00", LA), end: tzDateTimeUtc(first, "12:00", LA) });
    await seg(id, first);
    expect((await pickSlot(await link(id, [{ date: first, time: "14:00" }]), 0)).ok).toBe(true);
    expect(await days(id)).toEqual([`${first}..${first} usual`]);
    const s = await stored(id);
    expect([s.local_start, s.local_end]).toEqual([`${first} 14:00`, `${first} 16:00`]);
  });

  it("across the next clock change, a picked 9:00 is 9:00 on that day's own clock", async () => {
    const day = dayAfterNextClockChange();
    const id = await job();
    expect((await pickSlot(await link(id, [{ date: day, time: "09:00" }]), 0)).ok).toBe(true);
    const s = await stored(id);
    expect(new Date(s.scheduled_start).toISOString()).toBe(tzDateTimeUtc(day, "09:00", LA));
    expect(new Date(s.scheduled_end).toISOString()).toBe(tzDateTimeUtc(day, "11:00", LA));
  });

  it("a finished job takes no day: the pick is refused in words and nothing changes", async () => {
    const day = ahead(18);
    const id = await job({ status: "complete" });
    const token = await link(id, [{ date: day, time: "09:00" }]);
    expect(await refused(null, "select public.choose_schedule_slot($1, 0)", [token])).toMatch(/This job is no longer open/);
    const s = await stored(id);
    expect([s.status, s.local_start]).toEqual(["complete", null]);
    expect(await days(id)).toEqual([]);
    expect((await one("select status from public.schedule_proposals where token = $1", [token])).status).toBe("pending");
  });

  it("the appointment branch starts at the work day too (a string option has no time), and its visit is booked", async () => {
    const day = ahead(19);
    const v = (
      await one(
        "insert into public.appointments (org_id, type, title, status) values ($1, 'inspection', 'TEST 0370 pick visit', 'proposed') returning id::text as id",
        [orgId],
      )
    ).id as string;
    const token = (
      await one("insert into public.schedule_proposals (org_id, appointment_id, dates) values ($1, $2, $3::jsonb) returning token", [orgId, v, JSON.stringify([day])])
    ).token as string;
    expect((await pickSlot(token, 0)).ok).toBe(true);
    const a = await one("select status, to_char(starts_at at time zone $2, 'YYYY-MM-DD HH24:MI') as s, to_char(ends_at at time zone $2, 'HH24:MI') as e from public.appointments where id = $1", [v, LA]);
    expect(a).toEqual({ status: "scheduled", s: `${day} 09:00`, e: "10:00" });
  });

  it("the helpers are no door of their own; the two token doors stay open to the customer's browser", async () => {
    const g = await one(
      `select has_function_privilege('anon', 'public.job_takes_picked_day(uuid, date, text)', 'execute') as a1,
              has_function_privilege('authenticated', 'public.job_takes_picked_day(uuid, date, text)', 'execute') as a2,
              has_function_privilege('anon', 'public.job_segment_set_day(uuid, uuid, date, time, time)', 'execute') as a3,
              has_function_privilege('authenticated', 'public.job_day_block_min(date, timestamptz, timestamptz, integer, text, integer, integer)', 'execute') as a4,
              has_function_privilege('anon', 'public.choose_schedule_slot(text, integer)', 'execute') as slot,
              has_function_privilege('anon', 'public.choose_schedule_date(text, date)', 'execute') as date`,
    );
    expect(g).toEqual({ a1: false, a2: false, a3: false, a4: false, slot: true, date: true });
  });

  it("the SQL block rule is jobDayBlock's twin on the days it decides", async () => {
    const wd = workDayMinutes(WORK_DAY);
    const cases = [
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: tzDateTimeUtc("2026-09-28", "12:00", LA)!, planned: null, day: "2026-09-28" },
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: tzDateTimeUtc("2026-09-28", "17:00", LA)!, planned: 120, day: "2026-09-28" },
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: tzDateTimeUtc("2026-09-30", "17:00", LA)!, planned: 1440, day: "2026-09-28" },
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: tzDateTimeUtc("2026-09-30", "15:00", LA)!, planned: 1440, day: "2026-09-30" },
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: tzDateTimeUtc("2026-09-30", "17:00", LA)!, planned: 1440, day: "2026-09-29" },
      { start: tzDateTimeUtc("2026-10-31", "10:00", LA)!, end: tzDateTimeUtc("2026-11-02", "16:00", LA)!, planned: null, day: "2026-11-02" },
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: null, planned: null, day: "2026-09-28" },
      { start: tzDateTimeUtc("2026-09-28", "10:00", LA)!, end: tzDateTimeUtc("2026-09-28", "12:00", LA)!, planned: null, day: "2026-09-22" },
    ];
    for (const k of cases) {
      const sql = await one("select start_min, end_min from public.job_day_block_min($1::date, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7)", [
        k.day,
        k.start,
        k.end,
        k.planned,
        LA,
        wd.startMin,
        wd.endMin,
      ]);
      const ts = jobDayBlock({ day: k.day, scheduledStart: k.start, scheduledEnd: k.end, plannedMinutes: k.planned, tz: LA, wd });
      expect([sql.start_min, sql.end_min], JSON.stringify(k)).toEqual([ts.startMin, ts.endMin]);
    }
  });
});
