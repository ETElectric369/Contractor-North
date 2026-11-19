import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARRIED_OVER_JOB_COLUMNS,
  CARRIED_OVER_VISIT_COLUMNS,
  CARRY_DAYS,
  NEEDS_A_DAY_KIND,
  TO_BUY_PHRASE,
  aheadVisitJobIds,
  carriedOverJobs,
  loadCarriedOver,
  needsYouWithoutCarried,
  type CarryJob,
} from "./carried-over";

/**
 * CARRIED OVER (cn-v1169): a job booked for a day that came and went with nobody on it stays with
 * the person who is on it. The rule is pure and dated by argument, so every case is a row here; the
 * loader is run against a stand-in client that records what it was asked.
 *
 * The owner's own Wednesday is the first case: three jobs booked for Tuesday, nobody clocked in on
 * anything, and on Wednesday My Day showed only Wednesday's job. Names and places are invented.
 */
const TZ = "America/Los_Angeles";
const ME = "user-me";
const OTHER = "user-other";
const WED = "2026-11-18";

/** A one-day job: 2:30 to 4:30 PM Pacific on `day` (22:30Z to 00:30Z the next day). */
const oneDay = (id: string, day: string, over: Partial<CarryJob> = {}): CarryJob => {
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { id, status: "scheduled", scheduled_start: `${day}T22:30:00Z`, scheduled_end: `${next}T00:30:00Z`, assigned_to: [ME, OTHER], ...over };
};
const run = (jobs: CarryJob[], over: Partial<Parameters<typeof carriedOverJobs>[0]> = {}) =>
  carriedOverJobs({ jobs, readerId: ME, todayStr: WED, tz: TZ, ...over }).map((c) => [c.job.id, c.bookedDay]);

describe("carriedOverJobs: the rule", () => {
  it("HIS WEDNESDAY: booked Tuesday afternoon, nobody clocked in, nothing ahead: carried over, and the day is Tuesday", () => {
    expect(run([oneDay("larkspur", "2026-11-17")])).toEqual([["larkspur", "2026-11-17"]]);
  });

  it("the day is the COMPANY's: a start stored as the next morning in UTC is still Tuesday in Pacific", () => {
    // 5:00 PM Pacific on the 17th is 01:00Z on the 18th.
    const j: CarryJob = { id: "late", status: "scheduled", scheduled_start: "2026-11-18T01:00:00Z", scheduled_end: "2026-11-18T03:00:00Z", assigned_to: [ME] };
    expect(run([j])).toEqual([["late", "2026-11-17"]]);
  });

  it("only the reader's own: a job he is not on the crew of is not his to carry", () => {
    expect(run([oneDay("theirs", "2026-11-17", { assigned_to: [OTHER] }), oneDay("nobody", "2026-11-17", { assigned_to: [] }), oneDay("unset", "2026-11-17", { assigned_to: null })])).toEqual([]);
    expect(run([oneDay("larkspur", "2026-11-17")], { readerId: OTHER })).toEqual([["larkspur", "2026-11-17"]]);
    expect(run([oneDay("larkspur", "2026-11-17")], { readerId: null })).toEqual([]);
  });

  it("worked on its booked day: not carried (it ran as planned, and what is next is Needs You's question)", () => {
    expect(run([oneDay("larkspur", "2026-11-17")], { workedDays: new Map([["larkspur", ["2026-11-17"]]]) })).toEqual([]);
  });

  it("worked the day AFTER its booked day: carried that day (work today does not take it off), gone the morning after", () => {
    const worked = new Map([["larkspur", ["2026-11-18"]]]);
    // Wednesday, on it today: still his, so a clock-out for lunch finds it again.
    expect(run([oneDay("larkspur", "2026-11-17")], { workedDays: worked })).toEqual([["larkspur", "2026-11-17"]]);
    // Thursday: the crew was on it yesterday.
    expect(run([oneDay("larkspur", "2026-11-17")], { workedDays: worked, todayStr: "2026-11-19" })).toEqual([]);
  });

  it("work BEFORE the missed day does not count: a three-day run worked two days and missed on the third is carried, on the third day", () => {
    const j: CarryJob = {
      id: "snowbell",
      status: "in_progress",
      scheduled_start: "2026-11-16T16:00:00Z",
      scheduled_end: "2026-11-19T00:00:00Z",
      assigned_to: [ME],
      job_schedule_segments: [{ start_date: "2026-11-16", end_date: "2026-11-18" }],
    };
    const worked = new Map([["snowbell", ["2026-11-16", "2026-11-17"]]]);
    expect(run([j], { todayStr: "2026-11-19", workedDays: worked })).toEqual([["snowbell", "2026-11-18"]]);
    // ...and worked on that third day too, it is not.
    expect(run([j], { todayStr: "2026-11-19", workedDays: new Map([["snowbell", ["2026-11-16", "2026-11-17", "2026-11-18"]]]) })).toEqual([]);
  });

  it("a day today or ahead: not carried (today's is in today's list, a day ahead is not lost)", () => {
    expect(run([oneDay("today", WED)])).toEqual([]);
    expect(run([oneDay("friday", "2026-11-20")])).toEqual([]);
    // Missed Tuesday, but booked again Friday.
    const again: CarryJob = { ...oneDay("again", "2026-11-17"), scheduled_end: "2026-11-21T00:30:00Z", job_schedule_segments: [{ start_date: "2026-11-17", end_date: "2026-11-17" }, { start_date: "2026-11-20", end_date: "2026-11-20" }] };
    expect(run([again])).toEqual([]);
  });

  it("a visit booked for it today or later is something ahead", () => {
    expect(run([oneDay("larkspur", "2026-11-17")], { aheadVisitJobIds: new Set(["larkspur"]) })).toEqual([]);
  });

  it("A GAP DAY IS NOT A JOB DAY: with day rows, the job's days are those rows, never the span that mirrors them", () => {
    // Day rows on the 10th and the 12th; the listed span runs to the 20th only because it mirrors a
    // row that has since been taken off. By the calendar's rule the last booked day is the 12th.
    const j: CarryJob = {
      id: "bayberry",
      status: "scheduled",
      scheduled_start: "2026-11-10T16:00:00Z",
      scheduled_end: "2026-11-21T00:00:00Z",
      assigned_to: [ME],
      job_schedule_segments: [{ start_date: "2026-11-10", end_date: "2026-11-10" }, { start_date: "2026-11-12", end_date: "2026-11-12" }],
    };
    expect(run([j])).toEqual([["bayberry", "2026-11-12"]]);
    // Without day rows the same span covers today: not carried.
    expect(run([{ ...j, job_schedule_segments: [] }])).toEqual([]);
  });

  it(`a missed day stays for ${CARRY_DAYS} days and no longer: after that it is a job nobody is planning`, () => {
    expect(CARRY_DAYS).toBe(7);
    expect(run([oneDay("week", "2026-11-11")])).toEqual([["week", "2026-11-11"]]); // 7 days ago
    expect(run([oneDay("older", "2026-11-10")])).toEqual([]); // 8 days ago
    expect(run([oneDay("older", "2026-11-10")], { carryDays: 10 })).toEqual([["older", "2026-11-10"]]);
  });

  it("only a job still being done: on hold, finished, cancelled and invoiced are not carried", () => {
    for (const status of ["on_hold", "complete", "completed", "cancelled", "invoiced", "", null]) {
      expect(run([oneDay("x", "2026-11-17", { status })]), String(status)).toEqual([]);
    }
    for (const status of ["to_be_scheduled", "scheduled", "in_progress"]) {
      expect(run([oneDay("x", "2026-11-17", { status })]), status).toEqual([["x", "2026-11-17"]]);
    }
  });

  it("a job waiting on somebody else is not asked for a day here either", () => {
    expect(run([oneDay("permit", "2026-11-17", { blocked_on: "county permit" })])).toEqual([]);
    expect(run([oneDay("blank", "2026-11-17", { blocked_on: "   " })])).toEqual([["blank", "2026-11-17"]]);
  });

  it("a job that never had a day is not a day that slipped", () => {
    expect(run([{ id: "new", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, assigned_to: [ME] }])).toEqual([]);
  });

  it("the most recently missed day first, then the earlier start", () => {
    const rows = run([
      oneDay("mon", "2026-11-16"),
      oneDay("tue-late", "2026-11-17", { scheduled_start: "2026-11-17T23:30:00Z" }),
      oneDay("tue-early", "2026-11-17", { scheduled_start: "2026-11-17T17:00:00Z" }),
    ]);
    expect(rows.map((r) => r[0])).toEqual(["tue-early", "tue-late", "mon"]);
  });

  it("the row rides through whole: whatever the caller read of the job is still on it", () => {
    const j = { ...oneDay("larkspur", "2026-11-17"), name: "Larkspur panel", customers: { name: "Dana Rook" } };
    const [c] = carriedOverJobs({ jobs: [j], readerId: ME, todayStr: WED, tz: TZ });
    expect(c.job).toBe(j);
  });

  it("nothing to read, or a day that is not a day: nothing", () => {
    expect(run([])).toEqual([]);
    expect(carriedOverJobs({ jobs: null, readerId: ME, todayStr: WED, tz: TZ })).toEqual([]);
    expect(run([oneDay("larkspur", "2026-11-17")], { todayStr: "today" })).toEqual([]);
  });
});

// ── the loader ───────────────────────────────────────────────────────────────────────────────────
type Call = { table: string; cols: string; filters: unknown[][] };
type Reply = { data?: unknown; error?: { message: string } | null };
function fakeClient(route: (c: Call) => Reply | "throw", calls: Call[]) {
  return {
    from(table: string) {
      const c: Call = { table, cols: "", filters: [] };
      calls.push(c);
      const chain: Record<string, unknown> = {
        select(cols: string) {
          c.cols = cols;
          return chain;
        },
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          const r = route(c);
          if (r === "throw") reject(new Error("socket hang up"));
          else resolve({ data: r.data ?? null, error: r.error ?? null });
        },
      };
      for (const m of ["contains", "in", "lt", "gte", "or", "eq"]) chain[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), chain);
      return chain;
    },
  };
}
// Wednesday the 18th in Pacific begins at 08:00Z.
const DAY_START = "2026-11-18T08:00:00.000Z";
const SINCE = "2026-11-10T08:00:00.000Z"; // CARRY_DAYS + 1 days before
const args = { userId: ME, todayStr: WED, tz: TZ, dayStartIso: DAY_START };

describe("loadCarriedOver: the reads", () => {
  it("nobody slipped (the usual day): ONE read, of his own jobs, on the caller's client", async () => {
    const calls: Call[] = [];
    const r = await loadCarriedOver(fakeClient(() => ({ data: [] }), calls), args);
    expect(r).toEqual({ rows: [], error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("jobs");
    expect(calls[0].cols).toBe(`${CARRIED_OVER_JOB_COLUMNS}, job_schedule_segments(start_date, end_date)`);
    expect(calls[0].filters).toEqual([
      ["contains", "assigned_to", [ME]],
      ["in", "status", ["to_be_scheduled", "scheduled", "in_progress"]],
      ["lt", "scheduled_start", DAY_START],
      ["or", `scheduled_end.gte.${SINCE},scheduled_start.gte.${SINCE}`],
    ]);
    // Labels, the schedule, the crew and the wait: never a price.
    expect(CARRIED_OVER_JOB_COLUMNS).not.toMatch(/price|rate|amount|total|cost|budget|contract|markup|paid|bill/i);
  });

  it("a job that may have slipped: its hours before today and its visits are read, for that job and that window only", async () => {
    const calls: Call[] = [];
    const r = await loadCarriedOver(
      fakeClient((c) => (c.table === "jobs" ? { data: [oneDay("larkspur", "2026-11-17"), oneDay("friday", "2026-11-20")] } : { data: [] }), calls),
      args,
    );
    expect(r.error).toBeNull();
    expect(r.rows.map((c) => [c.job.id, c.bookedDay])).toEqual([["larkspur", "2026-11-17"]]);
    expect(calls.map((c) => c.table)).toEqual(["jobs", "time_entries", "appointments"]);
    expect(calls[1]).toMatchObject({ cols: "job_id, clock_in", filters: [["in", "job_id", ["larkspur"]], ["gte", "clock_in", SINCE], ["lt", "clock_in", DAY_START]] });
    expect(calls[2]).toMatchObject({ cols: CARRIED_OVER_VISIT_COLUMNS, filters: [["in", "job_id", ["larkspur"]], ["gte", "starts_at", SINCE]] });
    // When, how long, what state, what kind: what the calendar's visit rule reads, and nothing of the visit's words or money.
    expect(CARRIED_OVER_VISIT_COLUMNS).toBe("job_id, starts_at, ends_at, status, absorbed, type");
  });

  it("hours on the booked day (as far as this reader can see) take it off; so does a finished visit that day", async () => {
    const jobs = { data: [oneDay("larkspur", "2026-11-17")] };
    const withEntry = await loadCarriedOver(
      // 3:00 PM Pacific on the 17th.
      fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "time_entries" ? { data: [{ job_id: "larkspur", clock_in: "2026-11-17T23:00:00Z" }] } : { data: [] }), []),
      args,
    );
    expect(withEntry.rows).toEqual([]);
    const withVisit = await loadCarriedOver(
      fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "appointments" ? { data: [{ job_id: "larkspur", starts_at: "2026-11-17T18:00:00Z", status: "completed", absorbed: false }] } : { data: [] }), []),
      args,
    );
    expect(withVisit.rows).toEqual([]);
    // Another job's hours are not this job's.
    const others = await loadCarriedOver(
      fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "time_entries" ? { data: [{ job_id: "elsewhere", clock_in: "2026-11-17T23:00:00Z" }] } : { data: [] }), []),
      args,
    );
    expect(others.rows.map((c) => c.job.id)).toEqual(["larkspur"]);
  });

  it("a visit still booked today or later is something ahead; a cancelled one, one the job absorbed, and one before today are not", async () => {
    const jobs = { data: [oneDay("larkspur", "2026-11-17")] };
    const withVisit = (v: Record<string, unknown>) =>
      loadCarriedOver(fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "appointments" ? { data: [{ job_id: "larkspur", ...v }] } : { data: [] }), []), args).then((r) => r.rows.length);
    expect(await withVisit({ starts_at: "2026-11-18T17:00:00Z", status: "scheduled", absorbed: false })).toBe(0); // today
    expect(await withVisit({ starts_at: "2026-11-21T17:00:00Z", status: "scheduled", absorbed: false })).toBe(0); // ahead
    expect(await withVisit({ starts_at: "2026-11-21T17:00:00Z", status: "cancelled", absorbed: false })).toBe(1);
    expect(await withVisit({ starts_at: "2026-11-21T17:00:00Z", status: "scheduled", absorbed: true })).toBe(1);
    expect(await withVisit({ starts_at: "2026-11-17T17:00:00Z", status: "scheduled", absorbed: false })).toBe(1); // a visit that day, never closed out
  });

  it("AHEAD IS WHAT THE CALENDAR DRAWS: a visit waiting on the customer's pick counts, and so does one that began earlier and runs into today", async () => {
    const jobs = { data: [oneDay("larkspur", "2026-11-17")] };
    const withVisit = (v: Record<string, unknown>) =>
      loadCarriedOver(fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "appointments" ? { data: [{ job_id: "larkspur", absorbed: false, ...v }] } : { data: [] }), []), args).then((r) => r.rows.length);
    // A date-pick link is out and the customer has not chosen: the visit is on the calendar for Friday.
    expect(await withVisit({ starts_at: "2026-11-20T17:00:00Z", status: "proposed" })).toBe(0);
    // Began Tuesday afternoon, ends Wednesday (today): today is one of its days.
    expect(await withVisit({ starts_at: "2026-11-17T22:00:00Z", ends_at: "2026-11-18T20:00:00Z", status: "scheduled" })).toBe(0);
    // The same visit ending on Tuesday is behind us.
    expect(await withVisit({ starts_at: "2026-11-17T17:00:00Z", ends_at: "2026-11-17T22:00:00Z", status: "scheduled" })).toBe(1);
    // A call is on no day; a visit that is over is ahead of nothing.
    expect(await withVisit({ starts_at: "2026-11-20T17:00:00Z", status: "scheduled", type: "call" })).toBe(1);
    expect(await withVisit({ starts_at: "2026-11-20T17:00:00Z", status: "completed" })).toBe(1);
  });

  it("the caller may name its own columns (the clock's sheet reads fewer); the day rows are always added", async () => {
    const calls: Call[] = [];
    await loadCarriedOver(fakeClient(() => ({ data: [] }), calls), { ...args, columns: "id, status, scheduled_start, scheduled_end, assigned_to, blocked_on" });
    expect(calls[0].cols).toBe("id, status, scheduled_start, scheduled_end, assigned_to, blocked_on, job_schedule_segments(start_date, end_date)");
  });

  it("NEVER THROWS, never guesses: a read that errors or dies comes back as no rows and the reason", async () => {
    const jobs = { data: [oneDay("larkspur", "2026-11-17")] };
    expect(await loadCarriedOver(fakeClient(() => ({ error: { message: "permission denied" } }), []), args)).toEqual({ rows: [], error: "permission denied" });
    expect(await loadCarriedOver(fakeClient(() => "throw", []), args)).toEqual({ rows: [], error: "socket hang up" });
    // The hours could not be read: the job is NOT called carried over on a guess that nobody worked it.
    expect(await loadCarriedOver(fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "time_entries" ? { error: { message: "timeout" } } : { data: [] }), []), args)).toEqual({ rows: [], error: "timeout" });
    expect(await loadCarriedOver(fakeClient((c) => (c.table === "jobs" ? jobs : c.table === "appointments" ? "throw" : { data: [] }), []), args)).toEqual({ rows: [], error: "socket hang up" });
  });

  it("nobody signed in, or no day to count from: no read at all", async () => {
    const calls: Call[] = [];
    expect(await loadCarriedOver(fakeClient(() => ({ data: [] }), calls), { ...args, userId: null })).toEqual({ rows: [], error: null });
    expect(await loadCarriedOver(fakeClient(() => ({ data: [] }), calls), { ...args, dayStartIso: "soon" })).toEqual({ rows: [], error: null });
    expect(calls).toEqual([]);
  });
});

describe("aheadVisitJobIds: which jobs have a visit on the calendar today or later", () => {
  const v = (job_id: string, starts_at: string, over: Record<string, unknown> = {}) => ({ job_id, starts_at, status: "scheduled", absorbed: false, ...over });
  it("booked or pending, today or later, by the company's day", () => {
    const ahead = aheadVisitJobIds(
      [
        v("today", "2026-11-18T17:00:00Z"),
        v("friday-pending", "2026-11-20T17:00:00Z", { status: "proposed" }),
        // 11:30 PM Pacific on Tuesday is Wednesday in UTC: still Tuesday's visit, so not ahead.
        v("late-tuesday", "2026-11-18T07:30:00Z"),
        v("yesterday", "2026-11-17T17:00:00Z"),
        v("runs-into-today", "2026-11-17T17:00:00Z", { ends_at: "2026-11-18T23:00:00Z" }),
      ],
      WED,
      TZ,
    );
    expect([...ahead].sort()).toEqual(["friday-pending", "runs-into-today", "today"]);
  });

  it("over, called off, absorbed, a call, or a state nobody taught it: ahead of nothing (a job is offered when in doubt)", () => {
    const ahead = aheadVisitJobIds(
      [
        v("done", "2026-11-20T17:00:00Z", { status: "completed" }),
        v("off", "2026-11-20T17:00:00Z", { status: "cancelled" }),
        v("absorbed", "2026-11-20T17:00:00Z", { absorbed: true }),
        v("call", "2026-11-20T17:00:00Z", { type: "call" }),
        v("new-state", "2026-11-20T17:00:00Z", { status: "something_new" }),
        { job_id: null, starts_at: "2026-11-20T17:00:00Z", status: "scheduled" },
        { job_id: "no-time", starts_at: null, status: "scheduled" },
      ],
      WED,
      TZ,
    );
    expect([...ahead]).toEqual([]);
    expect([...aheadVisitJobIds(null, WED, TZ)]).toEqual([]);
  });

  it("the statuses it reads are the two the database has for a visit that is still on (0052)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0052_appointment_time_proposals.sql"), "utf8");
    expect(sql).toContain("check (status = any (array['scheduled', 'completed', 'cancelled', 'proposed']))");
  });
});

describe("needsYouWithoutCarried: one row per job on My Day", () => {
  const needDay = (id: string, vars?: Record<string, string | number | null>) => ({ id, kind: NEEDS_A_DAY_KIND, what: vars ? { key: "ny_w_datedNeverWorked", vars } : { key: "ny_w_neverHadADay" } });
  const carried = new Set(["larkspur", "snowbell"]);

  it("a carried-over job's Needs a Day row is left off: it says the same thing, with a second door to the same move", () => {
    const items = [needDay("larkspur", { day: "2026-11-17" }), needDay("bayberry", { day: "2026-11-02" }), { id: "inv-1", kind: "invoice_overdue" }];
    expect(needsYouWithoutCarried(items, carried).map((i) => i.id)).toEqual(["bayberry", "inv-1"]);
  });

  it("BUT a row that also says lines to buy stays: that fact rides this row and no other", () => {
    const items = [needDay("larkspur", { day: "2026-11-17", andKey: TO_BUY_PHRASE, n: 3 }), needDay("snowbell", { day: "2026-11-17" })];
    expect(needsYouWithoutCarried(items, carried).map((i) => i.id)).toEqual(["larkspur"]);
  });

  it("only that kind, only those jobs: another row that happens to share an id is never touched", () => {
    const items = [{ id: "larkspur", kind: "job_ready_to_bill" }, { id: "larkspur", kind: "materials_to_buy" }, needDay("needday-unread")];
    expect(needsYouWithoutCarried(items, carried)).toEqual(items);
  });

  it("nothing carried, or nothing to read: the list as it was (a new array, never the caller's)", () => {
    const items = [needDay("larkspur")];
    const out = needsYouWithoutCarried(items, new Set());
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
    expect(needsYouWithoutCarried(null, carried)).toEqual([]);
    expect(needsYouWithoutCarried(undefined, carried)).toEqual([]);
  });

  it("the two words it matches are the ones Needs You writes (pinned at their source)", () => {
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    // The row: the job's own id, this kind, and its lines to buy taken off every other row.
    expect(query).toContain('        id: j.id,\n        kind: "job_to_schedule",');
    expect(query).toContain("matCandidates.delete(j.id); // its lines to buy ride this row: one job, one row");
    expect(NEEDS_A_DAY_KIND).toBe("job_to_schedule");
    const why = readFileSync(join(process.cwd(), "src/lib/action-items/jobs-needing-a-day.ts"), "utf8");
    expect(why).toContain('vars.andKey = "ny_w_nToBuy";');
    expect(TO_BUY_PHRASE).toBe("ny_w_nToBuy");
  });
});
