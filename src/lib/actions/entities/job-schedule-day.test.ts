import { describe, it, expect, vi, beforeEach } from "vitest";

// Nort's job.scheduleDay, 2026-11-16. Asked to book the next day of three jobs, each with its start and
// a crew of three, Nort made three visits of type 'job' with nobody on them and gave no job a day: this
// verb took a date only and REPLACED the plan. A single day is ADDED now through the app's own door, Add
// to Schedule (addJobDay), with its start, its length and the crew in one call. These drive the real
// handler with the schedule's server actions stubbed and a small fake book behind the resolvers, and read
// what each door was called with: what a person's tap sends must be the old write exactly.

const { sched, setJobStatus, book, readJobDay } = vi.hoisted(() => ({
  readJobDay: vi.fn(),
  sched: {
    scheduleJobWindow: vi.fn(),
    addJobDay: vi.fn(),
    setJobDayTimes: vi.fn(),
    setJobCrew: vi.fn(),
  },
  setJobStatus: vi.fn(),
  book: {
    job: { id: "", assigned_to: [] as string[], scheduled_start: null as string | null, status: "scheduled" as string },
    profiles: [] as { id: string; full_name: string }[],
  },
}));

vi.mock("@/app/(app)/schedule/actions", () => ({
  ...sched,
  createJob: vi.fn(),
  moveJobDay: vi.fn(),
  createScheduleProposal: vi.fn(),
  setJobHold: vi.fn(),
  snoozeJobHold: vi.fn(),
}));
vi.mock("@/app/(app)/jobs/actions", () => ({
  setJobStatus,
  finishJob: vi.fn(),
  updateJobDescription: vi.fn(),
  setJobCustomer: vi.fn(),
}));
// The day as the calendar draws it, read back after a write (builder N2's module; its own tests run it).
vi.mock("@/lib/schedule/job-day-read", () => ({ readJobDay }));
vi.mock("@/app/(app)/jobs/[id]/job-contacts-actions", () => ({ linkJobContact: vi.fn(), unlinkJobContact: vi.fn() }));

/** jobs → the one job; profiles → found by name through the resolver's or() filter, or by id through in(). */
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      let nameFilter: string | null = null;
      let idList: string[] | null = null;
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "ilike", "is", "limit", "order"]) chain[k] = () => chain;
      chain.or = (f: string) => {
        nameFilter = f;
        return chain;
      };
      chain.in = (_c: string, ids: string[]) => {
        idList = ids;
        return chain;
      };
      const rows = () => {
        if (table === "jobs") return [{ ...book.job, assigned_to: [...book.job.assigned_to] }];
        if (table !== "profiles") return [];
        if (idList) return book.profiles.filter((p) => idList!.includes(p.id));
        if (nameFilter) {
          const m = /ilike\.(.*)$/.exec(nameFilter.split(",")[0]);
          const needle = (m?.[1] ?? "").toLowerCase();
          const contains = needle.startsWith("%");
          const bare = needle.replace(/%/g, "");
          return book.profiles.filter((p) => (contains ? p.full_name.toLowerCase().includes(bare) : p.full_name.toLowerCase() === bare));
        }
        return book.profiles;
      };
      chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) => res({ data: rows(), error: null });
      return chain;
    },
  })),
}));

import { jobActions } from "./job";

const ctx = { userId: "u1", orgId: "o1", role: "owner" } as never;
const JOB = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";
const DANA = "33333333-3333-4333-8333-333333333333";
const THEO = "44444444-4444-4444-8444-444444444444";

const scheduleDay = (input: Record<string, unknown>) => {
  const def = jobActions["job.scheduleDay"];
  return def.handler(def.input.parse({ id: JOB, ...input }), ctx);
};

beforeEach(() => {
  vi.clearAllMocks();
  book.job = { id: JOB, assigned_to: [], scheduled_start: null, status: "scheduled" };
  readJobDay.mockResolvedValue({ ok: true, block: { day: "2026-11-17", start: "07:30", end: "15:30", all_day: false, own_hours: true } });
  book.profiles = [
    { id: SAM, full_name: "Sam Tillery" },
    { id: DANA, full_name: "Dana Rook" },
    { id: THEO, full_name: "Theo Vance" },
  ];
  sched.addJobDay.mockImplementation(async (_id: string, p: { crew?: { add?: string[] } }) => {
    // The door applies the crew as saved now (a union), as setJobCrew would.
    if (p.crew?.add) book.job.assigned_to = Array.from(new Set([...book.job.assigned_to, ...p.crew.add]));
    return { ok: true, note: "Added Tue, Nov 17, 7:30 AM – 3:30 PM." };
  });
  sched.setJobDayTimes.mockResolvedValue({ ok: true });
  sched.setJobCrew.mockImplementation(async (_id: string, ids: string[]) => {
    book.job.assigned_to = ids;
    return { ok: true };
  });
  sched.scheduleJobWindow.mockResolvedValue({ ok: true });
});

describe("job.scheduleDay: the DAY route adds one day through Add to Schedule", () => {
  it("a day, a start, an end time and a crew of three go to addJobDay in one call, and `recorded` says the crew as stored", async () => {
    const r = await scheduleDay({ date: "2026-11-17", start: "7:30", end_time: "15:30", crew: ["Sam Tillery", "Dana Rook", "Theo Vance"] });
    expect(sched.addJobDay).toHaveBeenCalledTimes(1);
    expect(sched.addJobDay).toHaveBeenCalledWith(
      JOB,
      { day: "2026-11-17", start: "07:30", length: 480, crew: { add: [SAM, DANA, THEO] } },
      { cancelProposals: undefined },
    );
    expect(sched.scheduleJobWindow).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true });
    expect(r.recorded).toBe("Added Tue, Nov 17, 7:30 AM – 3:30 PM. Crew on the job now: Sam Tillery, Dana Rook and Theo Vance.");
  });

  it("each kind of length: minutes, full_day, none (the door's default), and end_time with minutes that agree", async () => {
    await scheduleDay({ date: "2026-11-17", start: "08:00", minutes: 90 });
    expect(sched.addJobDay.mock.calls[0][1]).toEqual({ day: "2026-11-17", start: "08:00", length: 90, crew: undefined });
    await scheduleDay({ date: "2026-11-17", full_day: true });
    expect(sched.addJobDay.mock.calls[1][1]).toEqual({ day: "2026-11-17", start: undefined, length: "full", crew: undefined });
    await scheduleDay({ date: "2026-11-17" });
    expect(sched.addJobDay.mock.calls[2][1]).toEqual({ day: "2026-11-17", start: undefined, length: undefined, crew: undefined });
    await scheduleDay({ date: "2026-11-17", start: "08:00", end_time: "10:00", minutes: 120 });
    expect(sched.addJobDay.mock.calls[3][1]).toMatchObject({ start: "08:00", length: 120 });
  });

  it("the door's two-hour default is said once, in the door's own note, and a crew nobody passed is still read back", async () => {
    sched.addJobDay.mockResolvedValueOnce({ ok: true, note: "Added Tue, Nov 17, 7:00 AM – 9:00 AM (2 hours; change it on its block).", defaulted: true });
    const r = await scheduleDay({ date: "2026-11-17" });
    expect(r.recorded).toBe("Added Tue, Nov 17, 7:00 AM – 9:00 AM (2 hours; change it on its block). Nobody is on the job yet.");
    expect(r.recorded!.split("2 hours").length - 1).toBe(1);
  });

  it("a crew name that matches nobody asks, and nothing is written", async () => {
    const r = await scheduleDay({ date: "2026-11-17", start: "07:30", crew: ["Sam Tillery", "Casey Loam"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('No person named "Casey Loam"');
    for (const w of Object.values(sched)) expect(w).not.toHaveBeenCalled();
  });

  it("lengths that disagree, an end time with no start, an end before the start and a bad start are refused before any write", async () => {
    const said = async (input: Record<string, unknown>) => (await scheduleDay({ date: "2026-11-17", ...input })).error;
    expect(await said({ start: "08:00", end_time: "10:00", minutes: 90 })).toBe("Give one of end_time, minutes or full_day: they don't agree.");
    expect(await said({ start: "08:00", minutes: 90, full_day: true })).toBe("Give one of end_time, minutes or full_day: they don't agree.");
    expect(await said({ end_time: "10:00" })).toBe("An end time needs a start time: pass start too.");
    expect(await said({ start: "10:00", end_time: "09:00" })).toBe("The end time must be after the start time.");
    expect(await said({ start: "1:30 PM" })).toBe("start must be a 24-hour HH:MM time, like 13:30.");
    for (const w of Object.values(sched)) expect(w).not.toHaveBeenCalled();
  });

  it("a pick-a-date link out: the door's question plus the retry, and the retry carries the flag", async () => {
    sched.addJobDay.mockResolvedValueOnce({ ok: false, needsProposalConfirm: true, error: "A date-pick link is out to the customer for this job — adding a day withdraws that link." });
    const r = await scheduleDay({ date: "2026-11-17", start: "07:30" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "A date-pick link is out to the customer for this job — adding a day withdraws that link. Ask the user whether to withdraw it, then retry with cancel_proposals: true.",
    );
    await scheduleDay({ date: "2026-11-17", start: "07:30", cancel_proposals: true });
    expect(sched.addJobDay.mock.calls[1][2]).toEqual({ cancelProposals: true });
  });

  it("any other refusal passes through unchanged", async () => {
    sched.addJobDay.mockResolvedValueOnce({ ok: false, error: "Larkspur is complete, so it can't take a day." });
    expect(await scheduleDay({ date: "2026-11-17" })).toEqual({ ok: false, error: "Larkspur is complete, so it can't take a day." });
  });
});

describe("job.scheduleDay: a job already on that day", () => {
  const already = { ok: false, alreadyOnDay: true, error: "Larkspur is already on Tue, Nov 17. Tap its block there to change its time or crew." };

  it("with hours: the start, then the length from that start, then the crew; `recorded` says the day as READ BACK", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    book.job.assigned_to = [SAM];
    const r = await scheduleDay({ date: "2026-11-17", start: "07:30", minutes: 480, crew: ["Dana Rook"] });
    expect(sched.setJobDayTimes.mock.calls).toEqual([
      [JOB, "2026-11-17", { start: "07:30" }],
      [JOB, "2026-11-17", { length: 480 }],
    ]);
    expect(readJobDay).toHaveBeenCalledWith(expect.anything(), JOB, "2026-11-17");
    expect(sched.setJobCrew).toHaveBeenCalledWith(JOB, [SAM, DANA]);
    expect(r).toMatchObject({ ok: true });
    expect(r.recorded).toBe("The job was already on 2026-11-17. On that day it is now 07:30 to 15:30. Crew on the job now: Sam Tillery and Dana Rook.");
  });

  it("the stored day, not the asked one: 22:00 for 300 minutes that the writer clamps is said as it was stored", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    readJobDay.mockResolvedValueOnce({ ok: true, block: { day: "2026-11-17", start: "22:00", end: "23:59", all_day: false, own_hours: true } });
    const r = await scheduleDay({ date: "2026-11-17", start: "22:00", minutes: 300 });
    expect(r.recorded).toContain("On that day it is now 22:00 to 23:59.");
    expect(r.recorded).not.toMatch(/5 hours|300/);
  });

  it("the whole work day is said as such", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    readJobDay.mockResolvedValueOnce({ ok: true, block: { day: "2026-11-17", start: "07:00", end: "17:00", all_day: true, own_hours: true } });
    const r = await scheduleDay({ date: "2026-11-17", full_day: true });
    expect(r.recorded).toContain("On that day it is now 07:00 to 17:00 (the whole work day).");
  });

  it("a read-back that fails, or finds no block, never says the asked values as stored", async () => {
    for (const back of [{ ok: false, error: "no read" }, { ok: true, block: null }]) {
      sched.addJobDay.mockResolvedValueOnce(already);
      readJobDay.mockResolvedValueOnce(back);
      const r = await scheduleDay({ date: "2026-11-17", start: "08:15", minutes: 45 });
      expect(r.ok).toBe(true);
      expect(r.recorded).toContain("The hours were sent, but the day could not be read back: schedule_overview for 2026-11-17 has the truth.");
      expect(r.recorded).not.toContain("08:15");
    }
  });

  it("a half-write is not a failure: the start stored, the length refused, said with the writer's own words and the read-back", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    sched.setJobDayTimes.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "That length doesn't fit the day." });
    readJobDay.mockResolvedValueOnce({ ok: true, block: { day: "2026-11-17", start: "09:00", end: "11:00", all_day: false, own_hours: true } });
    const r = await scheduleDay({ date: "2026-11-17", start: "09:00", minutes: 900 });
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe(
      "The job was already on 2026-11-17. On that day it is now 09:00 to 11:00. The start there was changed, but its length did NOT change: That length doesn't fit the day. Nobody is on the job yet.",
    );
  });

  it("a refusal that stored nothing is a failure, said; nothing is read back and no crew is added", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    sched.setJobDayTimes.mockResolvedValueOnce({ ok: false, error: "That time is outside the work day." });
    const r = await scheduleDay({ date: "2026-11-17", start: "05:00", crew: ["Dana Rook"] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("That time is outside the work day.");
    expect(sched.setJobCrew).not.toHaveBeenCalled();
    sched.addJobDay.mockResolvedValueOnce(already);
    sched.setJobDayTimes.mockResolvedValueOnce({ ok: false, error: "That length doesn't fit the day." });
    const r2 = await scheduleDay({ date: "2026-11-17", minutes: 900 });
    expect(r2).toEqual({ ok: false, error: "The job is already on 2026-11-17, and its length there did not change: That length doesn't fit the day." });
    expect(readJobDay).not.toHaveBeenCalled();
  });

  it("with no hours and no crew: nothing changed, and that is not a failure", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    const r = await scheduleDay({ date: "2026-11-17" });
    expect(r).toMatchObject({ ok: true, recorded: "The job is already on 2026-11-17. Nothing changed." });
    expect(sched.setJobDayTimes).not.toHaveBeenCalled();
    expect(sched.setJobCrew).not.toHaveBeenCalled();
  });

  it("a crew alone is added and read back; with no hours written, no day is read back", async () => {
    sched.addJobDay.mockResolvedValueOnce(already);
    const r = await scheduleDay({ date: "2026-11-17", crew: ["Theo Vance"] });
    expect(r.recorded).toBe("The job was already on 2026-11-17. Crew on the job now: Theo Vance.");
    expect(readJobDay).not.toHaveBeenCalled();
  });
});

describe("job.scheduleDay: the WINDOW route is the old write", () => {
  it("{ id, date, replace: true } is exactly the old call, and its answer is passed back as it was", async () => {
    sched.scheduleJobWindow.mockResolvedValueOnce({ ok: true, note: "Kept Mon, Nov 16 (worked)." });
    const r = await scheduleDay({ date: "2026-11-17", replace: true });
    expect(sched.scheduleJobWindow).toHaveBeenCalledWith(JOB, "2026-11-17", "2026-11-17");
    expect(sched.addJobDay).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, note: "Kept Mon, Nov 16 (worked).", recorded: "Kept Mon, Nov 16 (worked)." });
  });

  it("date + end is a multi-day window; a crew passed with it is added after and read back", async () => {
    const r = await scheduleDay({ date: "2026-11-17", end: "2026-11-19", crew: ["Theo Vance"] });
    expect(sched.scheduleJobWindow).toHaveBeenCalledWith(JOB, "2026-11-17", "2026-11-19");
    expect(sched.setJobCrew).toHaveBeenCalledWith(JOB, [THEO]);
    expect(r.recorded).toBe("Crew on the job now: Theo Vance.");
  });

  it("hours on the window route are refused before anything is written", async () => {
    const r = await scheduleDay({ date: "2026-11-17", end: "2026-11-19", start: "07:30" });
    expect(r.error).toBe(
      "A multi-day window or a replaced plan takes no hours in this call. Put the job on each day with its own call (date, start, and end_time or minutes).",
    );
    const r2 = await scheduleDay({ date: "2026-11-17", replace: true, full_day: true });
    expect(r2.ok).toBe(false);
    for (const w of Object.values(sched)) expect(w).not.toHaveBeenCalled();
  });

  it("an end before the date is refused before anything is written", async () => {
    const r = await scheduleDay({ date: "2026-11-19", end: "2026-11-17" });
    expect(r).toEqual({ ok: false, error: "The end day is before the start day: pass date as the first day and end as the last." });
    for (const w of Object.values(sched)) expect(w).not.toHaveBeenCalled();
  });

  it("a job still on hold after the window says so, because the window never lifts a hold", async () => {
    book.job.status = "on_hold";
    const r = await scheduleDay({ date: "2026-11-17", replace: true });
    expect(r.recorded).toBe("It is still on hold: take it off hold with job.setStatus, or put it on a day without replace.");
    const r2 = await scheduleDay({ date: "2026-11-17", end: "2026-11-19", crew: ["Theo Vance"] });
    expect(r2.recorded).toBe("It is still on hold: take it off hold with job.setStatus, or put it on a day without replace. Crew on the job now: Theo Vance.");
  });

  it("date + end on the same day is a day, not a window", async () => {
    await scheduleDay({ date: "2026-11-17", end: "2026-11-17" });
    expect(sched.scheduleJobWindow).not.toHaveBeenCalled();
    expect(sched.addJobDay).toHaveBeenCalledTimes(1);
  });
});

describe("job.scheduleDay's description promises only what is true", () => {
  it("names the fresh plan for a job with no live plan, and that the window lifts no hold", () => {
    const d = jobActions["job.scheduleDay"].description;
    expect(d).toContain("the days of the job's live plan are kept, while a job on hold, or one with no day, starts a fresh plan with this day and only the days already worked stay");
    expect(d).toContain("does NOT take a job off hold");
    expect(d).not.toContain("Date alone ADDS that day and keeps the job's other days");
  });
});

describe("job.setStatus 'scheduled' says when the job has no day", () => {
  const setStatus = (status: string) => {
    const def = jobActions["job.setStatus"];
    return def.handler(def.input.parse({ id: JOB, status }), ctx);
  };

  it("no day: the status is written, and `recorded` says it is still under Waiting for a Day", async () => {
    setJobStatus.mockResolvedValue({ ok: true });
    const r = await setStatus("scheduled");
    expect(setJobStatus).toHaveBeenCalledWith(JOB, "scheduled");
    expect(r).toEqual({
      ok: true,
      recorded: "Its status says Scheduled, but it has no day yet, so it is still under Waiting for a Day. A job gets its day from job.scheduleDay.",
    });
  });

  it("with a day, or for any other status, the answer is the writer's own", async () => {
    setJobStatus.mockResolvedValue({ ok: true });
    book.job.scheduled_start = "2026-11-17T15:30:00Z";
    expect(await setStatus("scheduled")).toEqual({ ok: true });
    book.job.scheduled_start = null;
    expect(await setStatus("in_progress")).toEqual({ ok: true });
    setJobStatus.mockResolvedValueOnce({ ok: false, error: "No." });
    expect(await setStatus("scheduled")).toEqual({ ok: false, error: "No." });
  });
});
