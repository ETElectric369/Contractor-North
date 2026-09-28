import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE DUPLICATE PUNCHES (2026-09-26), the doors, pinned without a database.
 *
 * Erik: "yes remove the duplicates and track down the problem causing that please". The same work
 * landed twice: a clock punch with no job, then the office typed the day again on the job. So:
 *   - a refused Add Entry hands back the shift in the way (a no-job punch is named as one);
 *   - Put This On <job> moves only the job of a shift that has none, and says what it did;
 *   - Company Time files a no-job shift under the company's own code, with an Undo;
 *   - shiftsOnDay lists what the person already has on the day, billed or not;
 *   - a clock-in never starts over hours already recorded: a tech's round-back stops at his own
 *     last clock-out, and a back-dated start over a shift is refused at the punch, in words.
 * 0360 is the boundary underneath (one-place-at-a-time.integration.test.ts).
 */
const state = vi.hoisted(() => ({ client: null as any, staff: true }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    state.staff ? { supabase: state.client, userId: "user-1", orgId: "org-1" } : { error: "This action is staff-only." },
  ),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined), notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { clockIn, createManualEntry, fileShiftAsCompanyTime, putShiftOnJob, shiftsOnDay, takeShiftOffJob } from "./actions";
import { overlapRefusal } from "@/lib/overlap-refusal";

type Q = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)} ${JSON.stringify(q.filters)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string, args: any) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "", payload: args, filters: [] };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "overlaps", "order", "limit", "contains"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

const PUNCH = "a0000000-0000-4000-8000-00000000000a";
const JOB = "d0000000-0000-4000-8000-00000000000d";
const ORG_TZ = { data: { settings: { timezone: "America/Los_Angeles" } } };
const isOverlapRead = (q: Q) => q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("id, clock_in, clock_out, job_id, job_code");
// Brian's 9/11 app punch: 10:31 AM to 6:57 PM Pacific, no job.
const brianPunch = { id: PUNCH, clock_in: "2026-09-11T17:31:00Z", clock_out: "2026-09-12T01:57:00Z", job_id: null, job_code: null, job: null };

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  state.staff = true;
});

describe("Add Entry over a punch that has no job", () => {
  it("is refused with the punch itself handed back, named as a no-job shift, and nothing is written", async () => {
    state.client = fakeSupabase((q) => {
      if (isOverlapRead(q)) return { data: [brianPunch] };
      if (q.table === "invoice_items") return { data: [] }; // no invoice bills the punch
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    // The office typing 9/11 on J-028: 11:00 AM to 7:30 PM.
    const r = await createManualEntry({
      profile_id: "brian-1",
      clock_in: "2026-09-11T18:00:00Z",
      clock_out: "2026-09-12T02:30:00Z",
      job_id: JOB,
      job_code: null,
      notes: "",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "Brian Taylor is already on the clock Friday Sep 11, 10:31 AM to 6:57 PM with no job, so these hours would be counted twice. Put that shift on the job instead of adding them again.",
    );
    expect(r.clash).toMatchObject({ id: PUNCH, noJob: true, jobId: null, exact: false, clockOut: brianPunch.clock_out });
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
  });

  it("a no-job punch an invoice already bills is not offered 'put it on the job' (it keeps its job, and the form has no door for it)", async () => {
    state.client = fakeSupabase((q) => {
      if (isOverlapRead(q)) return { data: [brianPunch] };
      if (q.table === "invoice_items")
        return { data: [{ source_ids: [PUNCH], invoices: { id: "inv-55", invoice_number: "INV-055", status: "sent", created_at: "2026-09-12T00:00:00Z" } }] };
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await createManualEntry({ profile_id: "brian-1", clock_in: "2026-09-11T18:00:00Z", clock_out: "2026-09-12T02:30:00Z", job_id: JOB, job_code: null, notes: "" });
    expect(r.error).toBe(
      "Brian Taylor is already on the clock Friday Sep 11, 10:31 AM to 6:57 PM with no job, so these hours would be counted twice. Edit that entry instead.",
    );
    expect(r.clash).toMatchObject({ id: PUNCH, noJob: true });
  });

  it("an edit or a copy over a no-job punch keeps 'Edit that entry instead': only Add Entry has the door", async () => {
    state.client = fakeSupabase((q) => {
      if (isOverlapRead(q)) return { data: [brianPunch] };
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const sentence = await overlapRefusal(state.client, "brian-1", Date.parse("2026-09-11T18:00:00Z"), Date.parse("2026-09-12T02:30:00Z"), { excludeId: "other" });
    expect(sentence).toMatch(/with no job, so these hours would be counted twice\. Edit that entry instead\.$/);
    expect(sentence).not.toMatch(/Put that shift on the job/);
    // No claims read either: the question is only asked where the answer changes the words.
    expect(calls.some((c) => c.table === "invoice_items")).toBe(false);
  });

  it("a shift on another job is named with its job, and the answer is to edit it", async () => {
    state.client = fakeSupabase((q) => {
      if (isOverlapRead(q)) return { data: [{ ...brianPunch, job_id: "other", job: { job_number: "J-011", name: "Herringbone" } }] };
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await createManualEntry({ profile_id: "brian-1", clock_in: "2026-09-11T18:00:00Z", clock_out: "2026-09-12T02:30:00Z", job_id: JOB, job_code: null, notes: "" });
    expect(r.error).toMatch(/on Herringbone, so these hours would be counted twice\. Edit that entry instead\.$/);
    expect(r.clash).toMatchObject({ noJob: false, jobLabel: "Herringbone" });
  });

  it("a clear day saves once and hands back the new shift's id (Add Time Entry's Open That Shift)", async () => {
    const NEW = "e0000000-0000-4000-8000-00000000000e";
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs") return { data: { id: JOB } };
      if (isOverlapRead(q)) return { data: [] };
      if (q.table === "time_entries" && q.verb === "insert") return { data: [{ id: NEW }] };
    }, calls);
    const r = await createManualEntry({ profile_id: "brian-1", clock_in: "2026-09-11T18:00:00Z", clock_out: "2026-09-12T02:30:00Z", job_id: JOB, job_code: null, notes: "" });
    expect(r).toEqual({ ok: true, id: NEW });
    const ins = calls.filter((c) => c.verb === "insert");
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toMatchObject({ profile_id: "brian-1", job_id: JOB, status: "closed", source: "manual" });
  });

  it("a save that lost the race to the same hours (0360's DETAIL) still comes back with the shift", async () => {
    let overlapReads = 0;
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs") return { data: { id: JOB } };
      // The first look is clear; by the insert, a second tap's row has landed.
      if (isOverlapRead(q)) return { data: overlapReads++ === 0 ? [] : [{ ...brianPunch, clock_in: "2026-09-11T18:00:00Z", clock_out: "2026-09-12T02:30:00Z", job_id: JOB, job: { name: "85 Whitney" } }] };
      if (q.table === "time_entries" && q.verb === "insert")
        return { error: { code: "P0001", message: "Those exact times are already recorded for this person on another entry.", details: `time_entry:${PUNCH}` } };
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await createManualEntry({ profile_id: "brian-1", clock_in: "2026-09-11T18:00:00Z", clock_out: "2026-09-12T02:30:00Z", job_id: JOB, job_code: null, notes: "" });
    expect(r.ok).toBe(false);
    expect(r.clash).toMatchObject({ id: PUNCH, exact: true });
    expect(r.error).toMatch(/^Brian Taylor already has Friday Sep 11, 11:00 AM to 7:30 PM on another entry\./);
  });
});

describe("Put This On <job>", () => {
  const routes = (entry: any, updated: any[] = [{ id: PUNCH }]) => (q: Q): Reply => {
    if (q.table === "time_entries" && q.verb === "select") return { data: entry };
    if (q.table === "jobs") return { data: { id: JOB, job_number: "J-028", name: "85 Whitney" } };
    if (q.table === "time_entries" && q.verb === "update") return { data: updated };
    if (q.table === "organizations") return ORG_TZ;
  };
  const noJob = { id: PUNCH, job_id: null, clock_in: brianPunch.clock_in, clock_out: brianPunch.clock_out, lunch_minutes: 0, profiles: { full_name: "Brian Taylor" }, job: null };

  it("moves only the job, only while the shift still has none, and says what it did with the real clock times", async () => {
    state.client = fakeSupabase(routes(noJob), calls);
    const r = await putShiftOnJob({ entry_id: PUNCH, job_id: JOB });
    expect(r).toEqual({ ok: true, sentence: "Brian's Fri Sep 11 shift, 10:31 AM to 6:57 PM (8.43 h), is on 85 Whitney now." });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload).toEqual({ job_id: JOB });
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "id", PUNCH], ["is", "job_id", null]]));
  });

  it("a shift that already has a job is left alone, in words", async () => {
    state.client = fakeSupabase(routes({ ...noJob, job_id: "other", job: { name: "Herringbone" } }), calls);
    const r = await putShiftOnJob({ entry_id: PUNCH, job_id: JOB });
    expect(r).toEqual({ ok: false, error: "That shift is already on Herringbone. Move it from Timecards if it belongs here." });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("a zero-row update (it got a job in between) is never reported as done", async () => {
    state.client = fakeSupabase(routes(noJob, []), calls);
    const r = await putShiftOnJob({ entry_id: PUNCH, job_id: JOB });
    expect(r).toEqual({ ok: false, error: "That shift got a job a moment ago. Reload to see where it went." });
  });

  it("Undo takes it back off that job only", async () => {
    state.client = fakeSupabase((q) => (q.verb === "update" ? { data: [{ id: PUNCH }] } : undefined), calls);
    expect(await takeShiftOffJob({ entry_id: PUNCH, job_id: JOB })).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload).toEqual({ job_id: null });
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "job_id", JOB]]));
  });

  it("is the office's: a tech's call is refused", async () => {
    state.staff = false;
    state.client = fakeSupabase(() => undefined, calls);
    expect((await putShiftOnJob({ entry_id: PUNCH, job_id: JOB })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("Company Time", () => {
  const shift = { id: PUNCH, job_id: null, job_code: null, clock_in: brianPunch.clock_in, clock_out: brianPunch.clock_out, lunch_minutes: 0, status: "closed", profiles: { full_name: "Erik Taylor" } };

  it("files the shift under SHOP (the company's non-billable code) and hands back what to undo to", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "job_codes") return { data: [{ code: "PTO", billable: false, active: true }, { code: "SHOP", billable: false, active: true }] };
      if (q.table === "time_entries" && q.verb === "select") return { data: shift };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: PUNCH }] };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await fileShiftAsCompanyTime({ entry_id: PUNCH });
    expect(r).toMatchObject({ ok: true, code: "SHOP", previous: null, sentence: "Erik's Fri Sep 11 shift (8.43 h) is filed as SHOP, the company's own time." });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload).toEqual({ job_code: "SHOP" });
    expect(upd.filters).toEqual(expect.arrayContaining([["is", "job_id", null]]));
  });

  it("a company with no such code is told how to get one, and nothing changes", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "job_codes") return { data: [] };
      if (q.table === "time_entries" && q.verb === "select") return { data: shift };
    }, calls);
    const r = await fileShiftAsCompanyTime({ entry_id: PUNCH });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no time code for its own time/);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("Undo puts back what it had, only while it still carries the company code", async () => {
    state.client = fakeSupabase((q) => (q.verb === "update" ? { data: [{ id: PUNCH }] } : undefined), calls);
    expect(await fileShiftAsCompanyTime({ entry_id: PUNCH, undo: { code: "SHOP", previous: null } })).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload).toEqual({ job_code: null });
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "job_code", "SHOP"], ["is", "job_id", null]]));
  });
});

describe("shiftsOnDay: what the person already has that day", () => {
  /** The day's reads. `schedule` answers the schedule's reads (scheduledJobFor); by default Brian has
   *  no day row and is rostered on nothing, so nothing is preselected. */
  const dayRoutes = (schedule: (q: Q) => Reply = (q) => (q.table === "crew_day_assignments" ? { data: null } : q.table === "jobs" && q.cols === "id, scheduled_start, scheduled_end" ? { data: [] } : undefined)) =>
    (q: Q): Reply => {
      const s = schedule(q);
      if (s !== undefined) return s;
      if (q.table === "organizations") return ORG_TZ;
      if (q.table === "time_entries" && q.verb === "select")
        return {
          data: [
            // Thursday evening, ended before Friday: not this day.
            { id: "thu", clock_in: "2026-09-11T00:00:00Z", clock_out: "2026-09-11T03:00:00Z", lunch_minutes: 0, job_id: null, job_code: null },
            { ...brianPunch, lunch_minutes: 0 },
            { id: "billed", clock_in: "2026-09-11T18:00:00Z", clock_out: "2026-09-12T02:30:00Z", lunch_minutes: 0, job_id: JOB, job_code: null, job: { job_number: "J-028", name: "85 Whitney" } },
          ],
        };
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "jobs") return { data: { id: JOB, job_number: "J-028", name: "85 Whitney" } };
      if (q.table === "invoice_items") return { data: [{ source_ids: ["billed"], invoices: { id: "inv", invoice_number: "INV-081", created_at: "2026-09-26" } }] };
    };

  it("lists the day's shifts (and the one from the evening before that ran into it), flags no-job and billed ones, and names the form's job", async () => {
    state.client = fakeSupabase(dayRoutes(), calls);
    const r = await shiftsOnDay({ profile_id: "brian-1", date: "2026-09-11", for_job_id: JOB });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("Brian Taylor");
    expect(r.forJob).toEqual({ id: JOB, label: "85 Whitney" });
    expect(r.shifts.map((s) => [s.id, s.noJob, s.billedBy, s.jobLabel])).toEqual([
      [PUNCH, true, null, null],
      ["billed", false, "INV-081", "85 Whitney"],
    ]);
    expect(r.shifts[0].hours).toBe(8.43);
    // Nothing on the schedule for him that day: nothing to start the Job field on.
    expect(r.scheduledJob).toBeNull();
    expect(r.offThatDay).toBe(false);
    // The schedule was asked about HIS day, not the caller's today.
    expect(calls.find((c) => c.table === "crew_day_assignments")!.filters).toEqual(
      expect.arrayContaining([["eq", "profile_id", "brian-1"], ["eq", "work_date", "2026-09-11"]]),
    );
  });

  it("names where the schedule put him that day, labelled like the form's Job list (Add Time Entry starts there)", async () => {
    state.client = fakeSupabase(
      dayRoutes((q) => {
        if (q.table === "crew_day_assignments") return { data: { job_id: JOB, kind: "job" } };
        if (q.table === "jobs" && q.cols === "id" && q.filters.some((f) => f[0] === "in" && f[1] === "status")) return { data: { id: JOB } };
        if (q.table === "jobs" && q.cols === "id, job_number, name, address, customers(name)")
          return { data: { id: JOB, job_number: "J-028", name: "85 Whitney", address: "85 Whitney Ave", customers: { name: "Nora Arnoso" } } };
        return undefined;
      }),
      calls,
    );
    const r = await shiftsOnDay({ profile_id: "brian-1", date: "2026-09-11", for_job_id: null });
    expect(r.ok && r.scheduledJob).toEqual({ id: JOB, label: "85 Whitney" });
    expect(r.ok && r.offThatDay).toBe(false);
  });

  it("marked off that day: says so, and names no job", async () => {
    state.client = fakeSupabase(dayRoutes((q) => (q.table === "crew_day_assignments" ? { data: { job_id: null, kind: "off" } } : undefined)), calls);
    const r = await shiftsOnDay({ profile_id: "brian-1", date: "2026-09-11", for_job_id: null });
    expect(r.ok && r.offThatDay).toBe(true);
    expect(r.ok && r.scheduledJob).toBeNull();
  });

  it("a schedule that can't be read is no preselect, never a refused day", async () => {
    state.client = fakeSupabase(
      dayRoutes((q) => {
        if (q.table === "crew_day_assignments") throw new Error("fetch failed");
        return undefined;
      }),
      calls,
    );
    const r = await shiftsOnDay({ profile_id: "brian-1", date: "2026-09-11", for_job_id: JOB });
    expect(r.ok).toBe(true);
    expect(r.ok && r.scheduledJob).toBeNull();
    expect(r.ok && r.offThatDay).toBe(false);
    expect(r.ok && r.shifts).toHaveLength(2);
  });
});

describe("a clock-in never starts over hours already recorded", () => {
  const H = 3_600_000;

  it("a tech's round-back to the half hour stops at his own last clock-out", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-24T17:25:00Z"), toFake: ["Date"] }); // 10:25 AM Pacific
    try {
      const lastOut = "2026-09-24T17:20:00Z"; // he clocked out at 10:20
      state.client = fakeSupabase((q) => {
        if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
        if (q.table === "profiles") return { data: { role: "tech" } };
        if (q.table === "jobs" && q.verb === "select" && q.cols === "id") return { data: { id: JOB } };
        if (q.table === "jobs" && q.verb === "select") return { data: { org_id: "org-1" } };
        if (q.table === "jobs" && q.verb === "update") return { data: [] };
        if (q.table === "time_entries" && q.verb === "select" && q.cols === "clock_out") return { data: { clock_out: lastOut } };
        if (isOverlapRead(q)) return { data: [] };
        if (q.table === "time_entries" && q.verb === "insert") return { data: null };
      }, calls);
      // The Timeclock's "round back" asks for 10:00.
      const r = await clockIn({ job_id: JOB, job_code: null, gps: null, clock_in_at: "2026-09-24T17:00:00Z" });
      expect(r).toEqual({ ok: true });
      expect(calls.find((c) => c.verb === "insert")!.payload.clock_in).toBe(new Date(lastOut).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("a back-dated staff clock-in over a recorded shift is refused at the punch, naming it and the first time that fits", async () => {
    const closed = { id: PUNCH, clock_in: new Date(Date.now() - 3 * H).toISOString(), clock_out: new Date(Date.now() - 1 * H).toISOString(), job_id: JOB, job_code: null, job: { name: "85 Whitney" } };
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "owner", full_name: "Erik Taylor" } };
      if (q.table === "jobs") return { data: { id: JOB } };
      if (isOverlapRead(q)) return { data: [closed] };
      if (q.table === "organizations") return ORG_TZ;
    }, calls);
    const r = await clockIn({ job_id: JOB, job_code: null, gps: null, clock_in_at: new Date(Date.now() - 2 * H).toISOString() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^You already have hours recorded .+ on 85 Whitney, so a clock started at .+ would count them twice\. Nothing was recorded\. Start the clock at .+ or later, or fix that shift on Timecards\.$/);
    expect(r.clash?.id).toBe(PUNCH);
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
  });

  it("a live punch (no start time given) reads nothing extra and just lands", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles" && q.cols === "org_id") return { data: { org_id: "org-1" } };
      if (q.table === "profiles") return { data: { role: "tech" } };
      if (q.table === "jobs" && q.verb === "select" && q.cols === "id") return { data: { id: JOB } };
      if (q.table === "jobs" && q.verb === "select") return { data: { org_id: "org-1" } };
      if (q.table === "jobs" && q.verb === "update") return { data: [] };
      if (q.table === "time_entries" && q.verb === "insert") return { data: null };
    }, calls);
    expect(await clockIn({ job_id: JOB, job_code: null, gps: null })).toEqual({ ok: true });
    expect(calls.some(isOverlapRead)).toBe(false);
  });
});
