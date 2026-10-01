import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES, postgrestShim } from "@/lib/postgrest-shim.db-fixture";
import { MY_DAY_POOL_LIMIT, RANK_POOL_SELECT, rankPoolQuery, rankSix, type SixRankTask } from "@/lib/six-rank";

/**
 * A PIN CARRIES — proven against a real Postgres, with the real query.
 *
 * Erik, 2026-09-30 (/planner): "the tasks keep disappearing even the pinned ones". The half of that
 * bug no pure test can reach is the FETCH: the row stopped matching the pool's `.or()` the morning
 * after it was pinned, so it never came back from the database at all. So this suite sends the ACTUAL
 * query My Day sends — lib/six-rank's rankPoolQuery, arms, order and bound, through the PostgREST shim
 * and the tasks RLS policies — on the day a reminder is pinned and again on later days, and reads back
 * what the database hands over.
 *
 * It also proves the ORDER is real SQL that a database honours, which is what keeps the bound from
 * ever being the thing that cuts a pin (defect 2's other half), and it proves the order is TOTAL: the
 * same query, run twice with an UPDATE in between (which relocates a row in the heap), comes back
 * identical.
 *
 * Two TEST companies minted inside ONE transaction (throwaway-org.db-fixture.ts), every fixture named
 * TEST, always rolled back. No DDL, no migration.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const MON = "2026-09-28";
const TUE = "2026-09-29";
const WED = "2026-09-30";
const NEXT_MONTH = "2026-10-28";

d("a pin carries: the real My Day pool, on the day after (and the week after)", () => {
  let c: pg.Client;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherOrgId = "";
  let otherStaffId = "";
  const ids: Record<string, string> = {};

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

  /** A Reminder (no job) belonging to `who`, as the server writes it. */
  const reminder = async (
    org: string,
    who: string,
    key: string,
    o: { due?: string | null; focus?: string | null; priority?: number; category?: string | null; status?: string; parent?: string | null; jobId?: string | null; createdAt?: string } = {},
  ) => {
    ids[key] = (
      await one(
        `insert into public.tasks (org_id, title, status, priority, due_date, focus_date, category, job_id, parent_id, created_by, created_at)
         values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, coalesce($11::timestamptz, now())) returning id::text as id`,
        [org, `TEST ${key}`, o.status ?? "open", o.priority ?? 0, o.due ?? null, o.focus ?? null, o.category ?? "operations", o.jobId ?? null, o.parent ?? null, who, o.createdAt ?? null],
      )
    ).id;
    return ids[key];
  };

  /** THE REAL READ: My Day's pool for `who`, on `todayStr`. */
  const pool = async (who: string, todayStr: string, limit = MY_DAY_POOL_LIMIT) => {
    const sb = postgrestShim(c, who);
    const q: any = sb.from("tasks").select(RANK_POOL_SELECT).eq("status", "open").is("parent_id", null).is("job_id", null);
    const res = await rankPoolQuery(q, { todayStr, scope: "my_day", limit });
    expect(res.error).toBeNull();
    return (res.data ?? []) as SixRankTask[];
  };
  /** …and the card it becomes. */
  const card = async (who: string, todayStr: string) => rankSix(await pool(who, todayStr), { todayStr });
  const titles = (rows: SixRankTask[]) => rows.map((r) => (r as any).title as string);

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      types: PG_TYPES,
    });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: every fixture lives only inside this transaction.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const fx = await mintOrgAndStranger(c, "pin-carries");
    orgId = fx.orgId;
    staffId = fx.staffId;
    techId = fx.techId;
    otherOrgId = fx.otherOrgId;
    otherStaffId = fx.otherStaffId;

    // Erik's own Reminders. The pin is the one he set on MONDAY and never finished.
    await reminder(orgId, staffId, "carried pin", { focus: MON, createdAt: "2026-09-28T16:00:00Z" });
    await reminder(orgId, staffId, "overdue", { due: MON, createdAt: "2026-09-20T16:00:00Z" });
    await reminder(orgId, staffId, "due wed", { due: WED, createdAt: "2026-09-21T16:00:00Z" });
    await reminder(orgId, staffId, "flagged", { priority: 2, createdAt: "2026-09-22T16:00:00Z" });
    await reminder(orgId, staffId, "plain", { createdAt: "2026-09-23T16:00:00Z" });
    // Never on the card: a day next month, an undated office task, a done one, a step, a job's task.
    await reminder(orgId, staffId, "next month", { due: NEXT_MONTH });
    await reminder(orgId, staffId, "office undated", { category: "office" });
    await reminder(orgId, staffId, "finished", { status: "done", focus: MON });
    const parent = ids["plain"];
    await reminder(orgId, staffId, "a step", { parent });
    // Another person's pin, and another company's: neither may ever reach his pool.
    await reminder(orgId, techId, "brian's pin", { focus: MON });
    await reminder(otherOrgId, otherStaffId, "stranger's pin", { focus: MON });
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("THE BUG: the pin set on Monday still comes back from the database on Tuesday, and leads the card", async () => {
    // Monday: it leads.
    expect((await card(staffId, MON))[0]).toMatchObject({ title: "TEST carried pin" });
    // Tuesday — nothing was written to the row overnight; there is no sweeper.
    const tue = await pool(staffId, TUE);
    expect(titles(tue), "the row has to be FETCHED before anything can show it").toContain("TEST carried pin");
    expect(titles(tue)[0]).toBe("TEST carried pin"); // and the order puts it beyond the bound's reach
    expect((await card(staffId, TUE))[0]).toMatchObject({ title: "TEST carried pin" });
    // A month on, still his.
    expect((await card(staffId, NEXT_MONTH))[0]).toMatchObject({ title: "TEST carried pin" });
  });

  it("the whole card, in rank order, from the real read", async () => {
    expect(titles(await card(staffId, WED))).toEqual([
      "TEST carried pin", // pinned Monday, carried
      "TEST overdue",
      "TEST due wed",
      "TEST flagged",
      "TEST plain", // Erik: "those reminders should be visible"
    ]);
  });

  it("and what the card never shows: a later day, an undated office task, a finished one, a step", async () => {
    const shown = titles(await card(staffId, WED));
    for (const gone of ["TEST next month", "TEST office undated", "TEST finished", "TEST a step"]) {
      expect(shown, gone).not.toContain(gone);
    }
  });

  it("a Reminder is still private: not Brian's pin, not another company's (0358's RLS, through the real policies)", async () => {
    const mine = titles(await pool(staffId, WED));
    expect(mine).not.toContain("TEST brian's pin");
    expect(mine).not.toContain("TEST stranger's pin");
    // Brian's own read gets his, and only his.
    const brians = titles(await pool(techId, WED));
    expect(brians).toContain("TEST brian's pin");
    expect(brians).not.toContain("TEST carried pin");
  });

  it("the bound cuts the backlog, never the pin: 80 dated rows and the pin still comes back first", async () => {
    for (let i = 0; i < 80; i++) {
      await reminder(orgId, staffId, `noise ${i}`, { due: `2026-0${(i % 8) + 1}-${String((i % 27) + 1).padStart(2, "0")}` });
    }
    const rows = await pool(staffId, WED);
    expect(rows).toHaveLength(MY_DAY_POOL_LIMIT); // build for millions: the bound holds
    expect(titles(rows)[0]).toBe("TEST carried pin");
    expect(titles(await card(staffId, WED))[0]).toBe("TEST carried pin");
  });

  it("the order is TOTAL: the same read, with an UPDATE in between, comes back identical", async () => {
    const before = titles(await pool(staffId, WED));
    // An UPDATE relocates the row in the heap, which is exactly what used to reshuffle a tie.
    await c.query("update public.tasks set notes = 'TEST touched' where id = $1", [ids["due wed"]]);
    await c.query("update public.tasks set notes = 'TEST touched' where id = $1", [ids["plain"]]);
    expect(titles(await pool(staffId, WED))).toEqual(before);
  });
});
