import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EVERY WAIT HAS A DAY (NY-hold, 0366): the hold writers, without a database.
 *
 *   setJobHold    a hold needs a reason; its day is worked out in the company's timezone from a
 *                 chip's name, or taken as sent, and a past day is refused; before 0366 (no
 *                 hold_until column) the job parks exactly as it always did.
 *   snoozeJobHold moves the day of a job STILL on hold; refuses a past day and a job that isn't on
 *                 hold, in words; writes a reason only when none is saved.
 *   createJob     a job is never born on hold, and nothing is written for one that isn't made.
 */
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  jobs: [] as Row[],
  writes: [] as { table: string; patch: Row }[],
  missingHoldUntil: false,
  tz: "America/Los_Angeles",
}));

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let inserting: Row | null = null;
  const run = () => {
    if (inserting) {
      state.writes.push({ table, patch: inserting });
      return { data: { id: "new-job" }, error: null };
    }
    if (table === "organizations") return { data: { settings: { timezone: state.tz } }, error: null };
    const rows = table === "jobs" ? state.jobs.filter((r) => filters.every((f) => f(r))) : [];
    if (patch) {
      if (state.missingHoldUntil && "hold_until" in patch) {
        return { data: null, error: { code: "PGRST204", message: "Could not find the 'hold_until' column of 'jobs' in the schema cache" } };
      }
      state.writes.push({ table, patch });
      for (const r of rows) Object.assign(r, patch);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    return { data: rows, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: () => b,
    limit: () => b,
    order: () => b,
    update: (p: Row) => ((patch = p), b),
    insert: (p: Row) => ((inserting = p), b),
    maybeSingle: async () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    },
    single: async () => run(),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { setJobHold, snoozeJobHold, createJob } = await import("./actions");
const { todayStrInTz } = await import("@/lib/tz");
const { addDays } = await import("@/lib/come-back-days");

const today = () => todayStrInTz(state.tz);
const job = (over: Row = {}) => ({ id: "j1", status: "in_progress", hold_reason: null, hold_until: null, scheduled_start: null, ...over });

beforeEach(() => {
  state.jobs = [job()];
  state.writes = [];
  state.missingHoldUntil = false;
  state.tz = "America/Los_Angeles";
});

describe("setJobHold: a hold is a reason and a day", () => {
  it("no reason, no hold: nothing is written", async () => {
    expect(await setJobHold("j1", "   ", { pick: "week" })).toEqual({
      ok: false,
      error: "Say why it's on hold — that's what the crew and the customer will read.",
    });
    expect(state.writes).toEqual([]);
  });

  it("a chip's name is worked out in the company's timezone", async () => {
    expect(await setJobHold("j1", "Waiting on the permit", { pick: "week" })).toEqual({ ok: true });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].patch).toMatchObject({ status: "on_hold", hold_reason: "Waiting on the permit", hold_until: addDays(today(), 7) });
  });

  it("a picked day is taken as sent, and a past one is refused with nothing written", async () => {
    expect(await setJobHold("j1", "Waiting on the permit", { date: addDays(today(), 3) })).toEqual({ ok: true });
    expect(state.writes[0].patch.hold_until).toBe(addDays(today(), 3));
    state.writes = [];
    expect(await setJobHold("j1", "Waiting on the permit", { date: addDays(today(), -1) })).toEqual({ ok: false, error: "Pick today or later" });
    expect(state.writes).toEqual([]);
  });

  it("with no day given it leaves the day to the database (a week out, or the day it already has)", async () => {
    expect(await setJobHold("j1", "Customer traveling")).toEqual({ ok: true });
    expect(state.writes[0].patch).not.toHaveProperty("hold_until");
  });

  it("before 0366 (no hold_until column) it parks exactly as it always did", async () => {
    state.missingHoldUntil = true;
    expect(await setJobHold("j1", "Waiting on the permit", { pick: "tomorrow" })).toEqual({ ok: true });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].patch).toMatchObject({ status: "on_hold", hold_reason: "Waiting on the permit" });
    expect(state.writes[0].patch).not.toHaveProperty("hold_until");
  });

  it("waking a job that isn't on hold says so (a zero-row write is never a save)", async () => {
    expect(await setJobHold("j1", null)).toEqual({ ok: false, error: "That job isn't on hold." });
  });
});

describe("snoozeJobHold: a held job comes back another day", () => {
  it("moves the day of a held job, and keeps the reason the office wrote", async () => {
    state.jobs = [job({ status: "on_hold", hold_reason: "Waiting on the permit", hold_until: today() })];
    expect(await snoozeJobHold("j1", { pick: "monday" }, "something else")).toEqual({ ok: true });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].patch).toHaveProperty("hold_until");
    expect(state.writes[0].patch).not.toHaveProperty("hold_reason");
    expect(state.writes[0].patch).not.toHaveProperty("status");
    expect(state.jobs[0].hold_reason).toBe("Waiting on the permit");
  });

  it("writes a reason only when none is saved", async () => {
    state.jobs = [job({ status: "on_hold", hold_reason: null })];
    expect(await snoozeJobHold("j1", { pick: "week" }, "  Waiting on the inspector  ")).toEqual({ ok: true });
    expect(state.writes[0].patch).toMatchObject({ hold_until: addDays(today(), 7), hold_reason: "Waiting on the inspector" });
  });

  it("refuses a past day, and writes nothing", async () => {
    state.jobs = [job({ status: "on_hold", hold_reason: "Waiting on the permit" })];
    expect(await snoozeJobHold("j1", { date: addDays(today(), -2) })).toEqual({ ok: false, error: "Pick today or later" });
    expect(state.writes).toEqual([]);
  });

  it("refuses a job that isn't on hold, and writes nothing", async () => {
    state.jobs = [job({ status: "scheduled" })];
    expect(await snoozeJobHold("j1", { pick: "tomorrow" })).toEqual({ ok: false, error: "That job isn't on hold." });
    expect(state.writes).toEqual([]);
  });

  it("before 0366 it says the database needs its update", async () => {
    state.jobs = [job({ status: "on_hold", hold_reason: "x" })];
    state.missingHoldUntil = true;
    expect(await snoozeJobHold("j1", { pick: "tomorrow" })).toEqual({
      ok: false,
      error: "This needs a quick database update before a hold can take a day.",
    });
  });
});

describe("createJob: never born on hold", () => {
  it("refuses On Hold in words, before anything (a customer included) is written", async () => {
    const fd = new FormData();
    fd.set("status", "on_hold");
    fd.set("new_customer_name", "Jackie Burks");
    fd.set("name", "5659 Rhodesia");
    expect(await createJob(fd)).toEqual({ ok: false, error: "Make the job first, then put it on hold. It asks why and for a day." });
    expect(state.writes).toEqual([]);
  });
});
