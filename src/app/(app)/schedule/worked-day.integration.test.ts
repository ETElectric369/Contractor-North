import { describe, it as vitestIt, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { LIVE_ORGS, mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";

/**
 * BOOK THIS DAY AND THE RAIL'S UNDO, WHERE THEY LAND: the TEST database, through the REAL server actions
 * (Wave 2 lane 1: SV-ghost's bookWorkedDay / unbookWorkedDay, W2-05's placeJobOnDay prior and
 * undoPlaceJob), speaking as the office exactly as PostgREST does (role authenticated + JWT claims),
 * RLS and the tables' triggers in force:
 *
 *   · bookWorkedDay adds ONE day (the worked one, at the hours worked when a day keeps its own), and the
 *     listed day and the status are untouched; a dateless job stays dateless with its status, and the
 *     calendar's by-id read still finds it (its worked day always draws);
 *   · a second run changes nothing; a day nobody clocked time on the job is refused with nothing
 *     written; unbookWorkedDay takes off just that day;
 *   · placeJobOnDay answers what it changed (prior); undoPlaceJob puts the days and the status back,
 *     and refuses once the job has changed since;
 *   · the crew can't book a day (the actions ask requireStaff, and the table's policy agrees).
 *
 * The rest of each action (auth, cookies, Google, revalidation) is replaced by a thin shim over the one
 * connection. Everything happens inside ONE transaction that is always rolled back, on a throwaway
 * company (lib/throwaway-org.db-fixture); every row is made here and goes with the rollback. No DDL.
 *
 *   CI=true TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const LA = "America/Los_Angeles";

const state = vi.hoisted(() => ({ client: null as any, member: null as any }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client, createServiceClient: () => state.client }));
vi.mock("@/lib/staff-guard", () => ({
  requireMember: async () => state.member,
  requireStaff: async () => (state.member?.staff ? state.member : { error: "This action is staff-only." }),
}));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async () => undefined }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: async () => undefined }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { bookWorkedDay, placeAppointmentOnDay, placeJobOnDay, unbookWorkedDay, undoPlaceJob, undoPlaceVisit } from "./actions";
import { segmentJobsNotLoaded } from "@/lib/schedule/cal-window";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const COLS = /^\s*[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*)*\s*$/;
/** Dates, times and instants as the PostgREST client hands them: strings, never JS Dates. */
const TEXT_TYPES: Record<number, (v: string) => unknown> = {
  1082: (v) => v, // date
  1083: (v) => v, // time
  1114: (v) => v, // timestamp
  1184: (v) => new Date(/[+-]\d{2}$/.test(v) ? `${v.replace(" ", "T")}:00` : v.replace(" ", "T")).toISOString(), // timestamptz
};

/** YYYY-MM-DD `n` days from the company's today. */
function dayFromToday(n: number): string {
  const t = new Date(`${todayStrInTz(LA)}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;

d("worked days booked after the fact, and the rail's Undo (Wave 2 lane 1)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let ownerId = "";
  let techId = "";
  let perDayHours = false;
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
  const asPerson = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };

  /** The calls the schedule writers make, as PostgREST would answer them, speaking as `uid`. Every call
   *  runs in its own savepoint, so a refusal comes back as { error } and never aborts the transaction. */
  const client = (uid: string) => {
    const run = async (sql: string, params: unknown[]) => {
      await c.query("savepoint shim");
      try {
        await asPerson(uid);
        const r = await c.query(sql, params);
        await c.query("release savepoint shim");
        await asServer();
        return { rows: r.rows, error: null as any };
      } catch (e: any) {
        await c.query("rollback to savepoint shim");
        await asServer();
        return { rows: null as any, error: { message: String(e?.message ?? e), code: e?.code, details: e?.detail ?? null, hint: e?.hint ?? null } };
      }
    };
    const from = (table: string) => {
      if (!IDENT.test(table)) throw new Error(`shim: table ${table}`);
      let mode: "select" | "insert" | "update" | "delete" = "select";
      let cols = "*";
      let returning: string | null = null;
      let rows: Record<string, unknown>[] = [];
      let patch: Record<string, unknown> = {};
      let single = false;
      let order: string | null = null;
      let limit: number | null = null;
      const where: string[] = [];
      const params: unknown[] = [];
      const col = (k: string) => {
        if (!IDENT.test(k)) throw new Error(`shim: column ${k}`);
        return k;
      };
      const q: any = {};
      const cmp = (op: string) => (k: string, v: unknown) => {
        params.push(v);
        where.push(`${col(k)} ${op} $${params.length}`);
        return q;
      };
      Object.assign(q, {
        select(s = "*") {
          const t = s.trim();
          if (t !== "*" && !COLS.test(t)) throw new Error(`shim: select ${s}`);
          if (mode === "select") cols = t;
          else returning = t;
          return q;
        },
        insert(r: Record<string, unknown> | Record<string, unknown>[]) {
          mode = "insert";
          rows = Array.isArray(r) ? r : [r];
          return q;
        },
        update(p: Record<string, unknown>) {
          mode = "update";
          patch = p;
          return q;
        },
        delete() {
          mode = "delete";
          return q;
        },
        eq: cmp("="),
        neq: cmp("is distinct from"),
        gt: cmp(">"),
        gte: cmp(">="),
        lt: cmp("<"),
        lte: cmp("<="),
        is(k: string, v: null) {
          if (v !== null) throw new Error("shim: is() takes null only");
          where.push(`${col(k)} is null`);
          return q;
        },
        in(k: string, v: unknown[]) {
          params.push(v);
          where.push(`${col(k)} = any ($${params.length})`);
          return q;
        },
        order(k: string, o?: { ascending?: boolean }) {
          order = `${col(k)} ${o?.ascending === false ? "desc" : "asc"}`;
          return q;
        },
        limit(nn: number) {
          limit = nn;
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        single() {
          single = true;
          return q;
        },
        async exec() {
          const p = [...params];
          const w = where.length ? ` where ${where.join(" and ")}` : "";
          let sql: string;
          if (mode === "select") {
            sql = `select ${cols} from public.${table}${w}${order ? ` order by ${order}` : ""}${limit != null ? ` limit ${Number(limit)}` : ""}`;
          } else if (mode === "insert") {
            const keys = Object.keys(rows[0] ?? {}).map(col);
            const values = rows.map((r) => `(${keys.map((k) => (p.push(r[k]), `$${p.length}`)).join(", ")})`);
            sql = `insert into public.${table} (${keys.join(", ")}) values ${values.join(", ")}${returning ? ` returning ${returning}` : ""}`;
          } else if (mode === "update") {
            const sets = Object.keys(patch).map((k) => (p.push(patch[k]), `${col(k)} = $${p.length}`));
            sql = `update public.${table} set ${sets.join(", ")}${w}${returning ? ` returning ${returning}` : ""}`;
          } else {
            sql = `delete from public.${table}${w}${returning ? ` returning ${returning}` : ""}`;
          }
          const r = await run(sql, p);
          if (r.error) return { data: null, error: r.error };
          if (single) {
            if (r.rows.length > 1) return { data: null, error: { message: "shim: more than one row" } };
            return { data: r.rows[0] ?? null, error: null };
          }
          return { data: mode === "select" || returning ? r.rows : null, error: null };
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return q.exec().then(res, rej);
        },
      });
      return q;
    };
    return { from };
  };
  const speakAs = (who: "office" | "tech") => {
    const uid = who === "office" ? ownerId : techId;
    state.client = client(uid);
    state.member = { supabase: state.client, userId: uid, orgId, staff: who === "office" };
  };

  const job = async (p: { status?: string; start?: string | null; end?: string | null; planned?: number | null; holdReason?: string | null } = {}) =>
    (
      await one(
        `insert into public.jobs (org_id, name, status, scheduled_start, scheduled_end, planned_minutes, hold_reason)
         values ($1, $2, $3::job_status, $4::timestamptz, $5::timestamptz, $6, $7) returning id::text as id`,
        [orgId, `TEST worked day job ${++n}`, p.status ?? "to_be_scheduled", p.start ?? null, p.end ?? null, p.planned ?? null, p.holdReason ?? null],
      )
    ).id as string;
  const seg = (jobId: string, start: string, end = start) =>
    c.query("insert into public.job_schedule_segments (org_id, job_id, start_date, end_date) values ($1, $2, $3, $4)", [orgId, jobId, start, end]);
  const entry = (jobId: string, day: string, from: string, to: string) =>
    c.query(
      `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'closed')`,
      [orgId, techId, jobId, at(day, from), at(day, to)],
    );
  /** A job's days as "start..end hh:mm-hh:mm" (or "usual"), in order. */
  const days = async (jobId: string) =>
    (
      await c.query(
        perDayHours
          ? `select start_date::text as s, end_date::text as e, to_char(start_time, 'HH24:MI') as st, to_char(end_time, 'HH24:MI') as et
               from public.job_schedule_segments where job_id = $1 order by start_date`
          : `select start_date::text as s, end_date::text as e, null as st, null as et from public.job_schedule_segments where job_id = $1 order by start_date`,
        [jobId],
      )
    ).rows.map((r) => `${r.s}..${r.e} ${r.st ? `${r.st}-${r.et}` : "usual"}`);
  const stored = (jobId: string) =>
    one("select status::text as status, hold_reason, scheduled_start, scheduled_end, planned_minutes from public.jobs where id = $1", [jobId]);

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      types: { getTypeParser: ((oid: number, format?: string) => TEXT_TYPES[oid] ?? pg.types.getTypeParser(oid, format as any)) as any },
    });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const org = await mintThrowawayOrg(c, { label: "worked day", techs: 1 });
    if (LIVE_ORGS.has(org.orgId)) throw new Error("worked day: refusing to write in a live company's org.");
    orgId = org.orgId;
    ownerId = org.owner.id;
    techId = org.techs[0].id;
    const set = await c.query(
      "update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('timezone', $2::text, 'work_day_start', '09:00', 'work_day_end', '17:00') where id = $1 returning id",
      [orgId, LA],
    );
    expect(set.rowCount).toBe(1);
    // 0370 (a day's own hours) is on the test database; the actions tolerate it missing, and so does this.
    perDayHours = !!(
      await one("select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_schedule_segments' and column_name = 'start_time') as ok")
    ).ok;
    speakAs("office");
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("Book This Day adds one day, at the hours worked; the listed day and the status are untouched", async () => {
    const worked = dayFromToday(-5);
    const planned = dayFromToday(10);
    const id = await job({ status: "scheduled", start: at(planned, "09:00"), end: at(planned, "11:00"), planned: 120 });
    await seg(id, planned);
    await entry(id, worked, "11:04", "13:46");
    const before = await stored(id);

    speakAs("office");
    const res = await bookWorkedDay(id, worked);
    expect(res).toMatchObject({ ok: true, added: true });
    expect(await days(id)).toEqual([`${worked}..${worked} ${perDayHours ? "11:04-13:46" : "usual"}`, `${planned}..${planned} usual`]);
    const after = await stored(id);
    expect([after.status, after.scheduled_start, after.scheduled_end, after.planned_minutes]).toEqual([
      before.status,
      before.scheduled_start,
      before.scheduled_end,
      before.planned_minutes,
    ]);
  });

  it("a dateless job stays dateless with its status, and the calendar's by-id read still finds its worked day", async () => {
    const worked = dayFromToday(-4);
    const id = await job({ status: "to_be_scheduled" });
    await entry(id, worked, "08:00", "12:00");
    speakAs("office");
    expect((await bookWorkedDay(id, worked)).ok).toBe(true);
    const s = await stored(id);
    expect([s.status, s.scheduled_start, s.scheduled_end]).toEqual(["to_be_scheduled", null, null]);
    expect(await days(id)).toEqual([`${worked}..${worked} ${perDayHours ? "08:00-12:00" : "usual"}`]);
    // The listed-span read never brings a job with no listed day; the segment names it, and the office
    // reads it by id.
    expect(segmentJobsNotLoaded([], [{ job_id: id }])).toEqual([id]);
    await asPerson(ownerId);
    const seen = (await c.query("select id::text as id from public.jobs where id = any($1::uuid[])", [[id]])).rows;
    await asServer();
    expect(seen).toEqual([{ id }]);
  });

  it("a second run changes nothing; a day nobody clocked time on the job is refused with nothing written", async () => {
    const worked = dayFromToday(-6);
    const id = await job({ status: "in_progress" });
    await entry(id, worked, "09:00", "15:00");
    speakAs("office");
    await bookWorkedDay(id, worked);
    const once = await days(id);
    const again = await bookWorkedDay(id, worked);
    expect(again).toMatchObject({ ok: true, added: false });
    expect(await days(id)).toEqual(once);

    const idle = dayFromToday(-7);
    const refused = await bookWorkedDay(id, idle);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^Nobody clocked time on .+, so there's nothing to book\.$/);
    expect(await days(id)).toEqual(once);
  });

  it("the Undo takes off just that day, splitting the range it sat in", async () => {
    const worked = dayFromToday(-8);
    const id = await job({ status: "in_progress" });
    await seg(id, dayFromToday(-9), dayFromToday(-7));
    await entry(id, worked, "09:00", "15:00");
    speakAs("office");
    const res = await unbookWorkedDay(id, worked);
    expect(res.ok).toBe(true);
    expect(await days(id)).toEqual([`${dayFromToday(-9)}..${dayFromToday(-9)} usual`, `${dayFromToday(-7)}..${dayFromToday(-7)} usual`]);
    expect((await stored(id)).status).toBe("in_progress");
  });

  it("the crew can't book a day: the action says so, and nothing is written", async () => {
    const worked = dayFromToday(-3);
    const id = await job({ status: "in_progress" });
    await entry(id, worked, "09:00", "15:00");
    speakAs("tech");
    expect(await bookWorkedDay(id, worked)).toEqual({ ok: false, error: "This action is staff-only." });
    speakAs("office");
    expect(await days(id)).toEqual([]);
  });

  it("placeJobOnDay answers what it changed; undoPlaceJob puts the days and the status back", async () => {
    const id = await job({ status: "to_be_scheduled" });
    const workedBefore = dayFromToday(-10);
    await seg(id, workedBefore);
    await entry(id, workedBefore, "09:00", "12:00");
    const placeDay = dayFromToday(12);
    speakAs("office");
    const placed = await placeJobOnDay(id, placeDay, "09:00");
    expect(placed.ok).toBe(true);
    expect(placed.prior).toMatchObject({ status: "to_be_scheduled", listed: null });
    expect(placed.prior!.days).toEqual([workedBefore, placeDay]);
    expect((await stored(id)).status).toBe("scheduled");

    const undone = await undoPlaceJob(id, placed.prior!);
    expect(undone).toEqual({ ok: true });
    const s = await stored(id);
    expect([s.status, s.scheduled_start, s.scheduled_end]).toEqual(["to_be_scheduled", null, null]);
    expect(await days(id)).toEqual([`${workedBefore}..${workedBefore} usual`]);
  });

  it("undoPlaceJob refuses once the job has changed since, and writes nothing", async () => {
    const id = await job({ status: "to_be_scheduled" });
    const placeDay = dayFromToday(14);
    speakAs("office");
    const placed = await placeJobOnDay(id, placeDay, "13:00");
    expect(placed.ok).toBe(true);
    // Someone added another day meanwhile.
    await seg(id, dayFromToday(20));
    const before = await days(id);
    expect(await undoPlaceJob(id, placed.prior!)).toEqual({ ok: false, error: "It changed since, so nothing was undone." });
    expect(await days(id)).toEqual(before);
    expect((await stored(id)).status).toBe("scheduled");
  });

  /* A VISIT'S UNDO IS GUARDED LIKE A JOB'S. The ten seconds the toast lives are long enough for someone
     else to move the visit; the Undo matches on the start the place wrote, in the UPDATE's own WHERE. */
  it("undoPlaceVisit puts a placed visit back to waiting, and refuses once somebody moved it", async () => {
    const day = dayFromToday(16);
    const v = (
      await one("insert into public.appointments (org_id, type, title, status) values ($1, 'inspection', 'TEST rail undo visit', 'scheduled') returning id::text as id", [orgId])
    ).id as string;
    const visit = () => one("select starts_at::text as starts_at, ends_at::text as ends_at, status::text as status from public.appointments where id = $1", [v]);
    speakAs("office");

    const placed = await placeAppointmentOnDay(v, day, "09:00", 120);
    expect(placed.ok).toBe(true);
    expect(placed.placedAt).toBeTruthy();
    expect((await visit()).starts_at).not.toBeNull();

    // Someone moved it an hour later while the Undo toast was still up: nothing is undone, and said.
    await c.query("update public.appointments set starts_at = starts_at + interval '1 hour' where id = $1", [v]);
    const moved = await visit();
    expect(await undoPlaceVisit(v, placed.placedAt!)).toEqual({ ok: false, error: "It changed since, so nothing was undone." });
    expect(await visit()).toMatchObject({ starts_at: moved.starts_at, ends_at: moved.ends_at });

    // Still where the place left it: back to Waiting For A Day (0368 allows a visit with no day).
    await c.query("update public.appointments set starts_at = $2::timestamptz where id = $1", [v, placed.placedAt]);
    expect(await undoPlaceVisit(v, placed.placedAt!)).toEqual({ ok: true });
    expect(await visit()).toMatchObject({ starts_at: null, ends_at: null, status: "scheduled" });
  });
});
