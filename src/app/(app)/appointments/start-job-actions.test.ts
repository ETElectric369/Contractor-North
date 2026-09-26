import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * START THE JOB FROM THE VISIT, pinned without a database (Erik, 2026-09-25, Tom Goodman).
 *
 *   - create + clock in: the job comes from createJobFromAppointment, the clock from the Timeclock's
 *     own clockIn, and the sentence names the job, the customer and the time on the ORG's clock;
 *   - already on the clock elsewhere: nothing is made, the answer offers the switch, and the switch
 *     goes through the Timeclock's switchJob, never a second open clock;
 *   - a tech is refused before anything is read or made;
 *   - a start in the future, or before midnight yesterday, is refused with nothing made;
 *   - "Link To J-055 Instead" is offered only for exactly one job of the same customer made on the
 *     visit's day that is not cancelled (open OR finished: Tom Goodman's J-055 was finished and
 *     invoiced before anybody came back to the visit), and the link re-asks that rule before it writes;
 *   - a switch never cuts the shift on that very job onto a duplicate (Tom Goodman as it stood);
 *   - a start in the past that lands on hours already recorded is refused before anything is made;
 *   - a job-less clock is MOVED whole, and the sentence says so;
 *   - a lead-booked visit that links instead marks the lead won and hands the job its lead.
 *
 * The fake refuses any read it was not told about, by name.
 */
const state = vi.hoisted(() => ({
  staff: true,
  client: null as any,
  visit: null as any,
  jobs: [] as any[],
  open: [] as (any | null)[], // successive answers to the open-entry read
  inquiryCustomer: null as string | null,
  staffIds: ["office-1"],
  closed: [] as any[], // the tapper's recorded shifts, for the overlap read
  writes: [] as { table: string; patch: any; filters: [string, string, unknown][] }[],
  jobReads: [] as { neq?: string; gte?: string; lt?: string }[], // the same-day job reads, as asked
}));
const spies = vi.hoisted(() => ({
  createJob: vi.fn(),
  link: vi.fn(),
  clockIn: vi.fn(),
  switchJob: vi.fn(),
  revalidate: vi.fn(),
  ring: vi.fn(),
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    state.staff ? { supabase: state.client, userId: "erik", orgId: "org-et" } : { error: "This action is staff-only." },
  ),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: spies.revalidate }));
vi.mock("@/lib/notifications", () => ({
  officeRecipients: vi.fn(async () => state.staffIds),
  ringOffice: spies.ring,
}));
vi.mock("./actions", () => ({ createJobFromAppointment: spies.createJob, linkAppointmentTo: spies.link }));
vi.mock("../timeclock/actions", () => ({ clockIn: spies.clockIn, switchJob: spies.switchJob }));

import { startJobFromVisit, linkVisitInstead, askOfficeToStartJob } from "./start-job-actions";
import {
  clockOffered,
  linkInsteadPick,
  linkableStatus,
  startedAtProblem,
  startFloorMs,
  visitDay,
  visitDayBounds,
  visitIsOver,
} from "@/lib/appointments/visit-start";

const TZ = "America/Los_Angeles";

type Q = { table: string; cols: string; filters: [string, string, unknown][]; patch?: any };

function fake() {
  const calls: Q[] = [];
  const answer = (q: Q) => {
    const f = (col: string) => q.filters.find(([, c]) => c === col)?.[2];
    if (q.patch !== undefined) {
      state.writes.push({ table: q.table, patch: q.patch, filters: q.filters });
      return { data: [{ id: f("id") }], error: null };
    }
    if (q.table === "appointments") return { data: state.visit, error: null };
    if (q.table === "organizations") return { data: { settings: { timezone: TZ } }, error: null };
    if (q.table === "time_entries" && q.filters.some(([op]) => op === "gte")) return { data: state.closed, error: null };
    if (q.table === "time_entries") return { data: state.open.length ? state.open.shift() : null, error: null };
    if (q.table === "jobs" && f("id")) {
      return { data: { id: f("id"), job_number: "J-056", name: "Inspection — Tom Goodman" }, error: null };
    }
    if (q.table === "jobs" && f("customer_id")) {
      // The read the page and the link share: this customer, not cancelled, made inside [gte, lt).
      const op = (o: string, col: string) => q.filters.find(([x, c]) => x === o && c === col)?.[2] as string | undefined;
      const not = op("neq", "status");
      const from = op("gte", "created_at");
      const to = op("lt", "created_at");
      state.jobReads.push({ neq: not, gte: from, lt: to });
      return {
        data: state.jobs.filter(
          (j) =>
            j.customer_id === f("customer_id") &&
            j.status !== not &&
            (!from || Date.parse(j.created_at) >= Date.parse(from)) &&
            (!to || Date.parse(j.created_at) < Date.parse(to)),
        ),
        error: null,
      };
    }
    if (q.table === "inquiries") return { data: { customer_id: state.inquiryCustomer }, error: null };
    if (q.table === "profiles") return { data: { full_name: "Brian Tech", org_id: "org-et", active: true }, error: null };
    throw new Error(`unrouted read: ${q.table} [${q.cols}] ${JSON.stringify(q.filters)}`);
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "brian" } } }) },
    from(table: string) {
      const q: Q = { table, cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(c: string) {
          q.cols = c;
          return chain;
        },
        eq(c: string, v: unknown) {
          q.filters.push(["eq", c, v]);
          return chain;
        },
        in(c: string, v: unknown) {
          q.filters.push(["in", c, v]);
          return chain;
        },
        is(c: string, v: unknown) {
          q.filters.push(["is", c, v]);
          return chain;
        },
        gte(c: string, v: unknown) {
          q.filters.push(["gte", c, v]);
          return chain;
        },
        lt(c: string, v: unknown) {
          q.filters.push(["lt", c, v]);
          return chain;
        },
        neq(c: string, v: unknown) {
          q.filters.push(["neq", c, v]);
          return chain;
        },
        lte(c: string, v: unknown) {
          q.filters.push(["lte", c, v]);
          return chain;
        },
        update(patch: any) {
          q.patch = patch;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(answer(q)),
        then: (ok: any, bad: any) => Promise.resolve(answer(q)).then(ok, bad),
      };
      return chain;
    },
  };
  return { client, calls };
}

// 2026-09-25 3:32 PM Pacific: the moment Erik filed the report.
const NOW = Date.parse("2026-09-25T22:32:00Z");
const NOON = "2026-09-25T19:00:00.000Z";

const tomVisit = {
  id: "appt-tom",
  title: "Inspection — Tom Goodman",
  status: "completed",
  job_id: null,
  starts_at: "2026-09-25T17:00:00.000Z",
  customer_id: "cust-tom",
  inquiry_id: null,
  customers: { name: "Tom Goodman" },
  inquiries: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.staff = true;
  state.visit = { ...tomVisit };
  state.jobs = [];
  state.open = [];
  state.inquiryCustomer = null;
  state.staffIds = ["office-1"];
  state.closed = [];
  state.writes = [];
  state.jobReads = [];
  state.client = fake().client;
  for (const s of Object.values(spies)) s.mockReset();
  spies.createJob.mockResolvedValue({ ok: true, id: "job-56" });
  spies.link.mockResolvedValue({ ok: true, id: "appt-tom" });
  spies.clockIn.mockResolvedValue({ ok: true });
  spies.switchJob.mockResolvedValue({ ok: true, entry_id: "entry-new", mode: "cut" });
  spies.ring.mockResolvedValue("rang");
});
afterEach(() => vi.useRealTimers());

describe("Start The Job And Clock In", () => {
  it("makes the job through createJobFromAppointment and clocks the tapper in through the Timeclock's clockIn", async () => {
    state.open = [null, { id: "entry-1", job_id: "job-56", job_code: null, clock_in: NOON, job: null }];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in", startAt: NOON, gps: null });

    expect(spies.createJob).toHaveBeenCalledTimes(1);
    expect(spies.createJob).toHaveBeenCalledWith("appt-tom");
    expect(spies.clockIn).toHaveBeenCalledWith({ job_id: "job-56", job_code: null, gps: null, clock_in_at: NOON });
    expect(spies.switchJob).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      ok: true,
      jobId: "job-56",
      jobNumber: "J-056",
      message: "Started J-056 for Tom Goodman and clocked you in at 12:00 PM.",
      undoEntryId: "entry-1",
    });
    // My Day shows the visit and who is on the clock: it is told.
    expect(spies.revalidate).toHaveBeenCalledWith("/planner");
    expect(spies.revalidate).toHaveBeenCalledWith("/jobs/job-56");
  });

  it("now is the default: no start time goes to clockIn, and the sentence reads the stored clock-in", async () => {
    const nowIso = new Date(NOW).toISOString();
    state.open = [null, { id: "entry-1", job_id: "job-56", job_code: null, clock_in: nowIso, job: null }];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in" });
    expect(spies.clockIn.mock.calls[0][0].clock_in_at).toBeNull();
    expect(res.message).toBe("Started J-056 for Tom Goodman and clocked you in at 3:32 PM.");
  });

  it("the job alone: Start The Job never touches the clock", async () => {
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "none" });
    expect(spies.createJob).toHaveBeenCalledTimes(1);
    expect(spies.clockIn).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, message: "Started J-056 for Tom Goodman." });
    expect(res.undoEntryId).toBeUndefined();
  });

  it("a clock-in that fails after the job is made says so, and the job stands", async () => {
    spies.clockIn.mockResolvedValue({ ok: false, error: "You're already clocked in." });
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Started J-056 for Tom Goodman.");
    expect(res.warning).toContain("The clock-in didn't go through: You're already clocked in.");
    expect(res.undoEntryId).toBeUndefined();
  });

  it("refuses a start in the future, and one before midnight yesterday, with nothing made", async () => {
    const future = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in", startAt: "2026-09-25T23:30:00Z" });
    expect(future).toMatchObject({ ok: false });
    expect(future.error).toContain("That time hasn't happened yet.");
    // 11:30 PM on Sep 23, Pacific: before midnight yesterday.
    const old = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in", startAt: "2026-09-24T06:30:00Z" });
    expect(old.error).toContain("since midnight yesterday");
    expect(spies.createJob).not.toHaveBeenCalled();
    expect(spies.clockIn).not.toHaveBeenCalled();
  });

  it("a cancelled visit starts nothing", async () => {
    state.visit = { ...tomVisit, status: "cancelled" };
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "none" });
    expect(res.ok).toBe(false);
    expect(spies.createJob).not.toHaveBeenCalled();
  });
});

describe("already on the clock elsewhere: Switch To This Job, never a second open clock", () => {
  const running = {
    id: "entry-50",
    job_id: "job-50",
    job_code: null,
    clock_in: "2026-09-25T15:00:00.000Z",
    job: { job_number: "J-050", name: "Apache Ct" },
  };

  it("a clock-in is refused before anything is made, and the answer names the running clock", async () => {
    state.open = [running];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in" });
    expect(res.ok).toBe(false);
    expect(res.onClock).toEqual({ entryId: "entry-50", jobId: "job-50", label: "J-050", since: "8:00 AM", whole: false });
    expect(res.error).toContain("Switch To This Job");
    expect(spies.createJob).not.toHaveBeenCalled();
    expect(spies.clockIn).not.toHaveBeenCalled();
  });

  it("the switch makes the job and moves the running clock through switchJob", async () => {
    state.open = [running];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "switch", gps: null });
    expect(spies.createJob).toHaveBeenCalledTimes(1);
    expect(spies.switchJob).toHaveBeenCalledWith({ entry_id: "entry-50", job_id: "job-56", job_code: null, gps: null });
    expect(spies.clockIn).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      ok: true,
      message: "Started J-056 for Tom Goodman and switched your clock here from J-050 at 3:32 PM.",
    });
    expect(res.undoEntryId).toBeUndefined(); // a switch is a cut, not a punch to delete
  });

  it("a job-less clock is MOVED whole onto the new job, and the sentence says since when", async () => {
    const jobless = { ...running, job_id: null, job: null };
    state.open = [jobless];
    const refused = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in" });
    expect(refused.onClock).toMatchObject({ label: "no job", whole: true, jobId: null });

    state.open = [jobless];
    spies.switchJob.mockResolvedValue({ ok: true, entry_id: "entry-50", mode: "repointed" });
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "switch" });
    expect(res.message).toBe("Started J-056 for Tom Goodman and moved your shift since 8:00 AM onto it.");
    expect(res.message).not.toContain("switched");
  });

  it("a switch the Timeclock refuses (the long-shift guard) leaves the clock where it was and says so", async () => {
    state.open = [running];
    spies.switchJob.mockResolvedValue({ ok: false, needsTime: true, error: "You've been on the clock since Thu Sep 24, 7:00 AM, more than 12 hours." });
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "switch" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Started J-056 for Tom Goodman.");
    expect(res.warning).toContain("Your clock is still on J-050: You've been on the clock since");
  });
});

describe("Tom Goodman as it stood: on the clock on J-055, the visit unlinked", () => {
  const j55 = {
    id: "job-55",
    job_number: "J-055",
    name: "3245 West Lake Boulevard",
    status: "in_progress",
    customer_id: "cust-tom",
    created_at: "2026-09-25T22:29:56.167Z",
  };
  const onJ55 = { id: "entry-849", job_id: "job-55", job_code: null, clock_in: NOON, job: { job_number: "J-055", name: j55.name } };

  it("a switch that would cut the J-055 shift onto a new duplicate job is refused, with nothing made", async () => {
    state.jobs = [j55];
    state.open = [onJ55];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "switch" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Link this visit to J-055 instead");
    expect(spies.createJob).not.toHaveBeenCalled();
    expect(spies.switchJob).not.toHaveBeenCalled();
  });

  it("the link says the clock is already running there", async () => {
    state.jobs = [j55];
    state.open = [onJ55];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Linked this visit to J-055. Nothing new was made. Your clock is already running on J-055.");
  });

  it("a switch from some other job still goes through", async () => {
    state.jobs = [j55];
    state.open = [{ ...onJ55, job_id: "job-50", job: { job_number: "J-050", name: "Apache Ct" } }];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "switch" });
    expect(res.ok).toBe(true);
    expect(spies.switchJob).toHaveBeenCalledTimes(1);
  });
});

describe("a start in the past never lands on hours already recorded", () => {
  it("a closed 9:00 to 11:30 shift and a 10:00 start is refused, with nothing made", async () => {
    state.closed = [{ id: "entry-j50", clock_in: "2026-09-25T16:00:00.000Z", clock_out: "2026-09-25T18:30:00.000Z" }];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in", startAt: "2026-09-25T17:00:00.000Z" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("9:00 AM to 11:30 AM");
    expect(res.error).toContain("Nothing was started.");
    expect(spies.createJob).not.toHaveBeenCalled();
    expect(spies.clockIn).not.toHaveBeenCalled();
  });

  it("a start after that shift is clear", async () => {
    state.closed = [{ id: "entry-j50", clock_in: "2026-09-25T16:00:00.000Z", clock_out: "2026-09-25T18:30:00.000Z" }];
    state.open = [null, { id: "entry-1", job_id: "job-56", job_code: null, clock_in: NOON, job: null }];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in", startAt: NOON });
    expect(res.ok).toBe(true);
    expect(spies.clockIn).toHaveBeenCalledTimes(1);
  });
});

describe("two devices, one visit", () => {
  it("when the other device's job won, the tap clocks into THAT job and says the visit already had it", async () => {
    spies.createJob.mockResolvedValue({ ok: true, id: "job-55", already: true });
    state.open = [null, { id: "entry-1", job_id: "job-55", job_code: null, clock_in: NOON, job: null }];
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in", startAt: NOON });
    expect(spies.clockIn.mock.calls[0][0].job_id).toBe("job-55");
    expect(res.message).toMatch(/^This visit already had /);
  });
});

describe("only the office starts a job", () => {
  it("a tech is refused with the office named, and nothing is read or made", async () => {
    state.staff = false;
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "in" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Only the office can start a job/);
    expect(spies.createJob).not.toHaveBeenCalled();
    expect(spies.clockIn).not.toHaveBeenCalled();
  });

  it("a tech can't link either", async () => {
    state.staff = false;
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(res.ok).toBe(false);
    expect(spies.link).not.toHaveBeenCalled();
  });

  it("a tech's Ask The Office rings the office's bell for this visit", async () => {
    const res = await askOfficeToStartJob("appt-tom");
    expect(res.ok).toBe(true);
    expect(spies.ring).toHaveBeenCalledTimes(1);
    const [org, who, n] = spies.ring.mock.calls[0];
    expect(org).toBe("org-et");
    expect(who).toEqual(["office-1"]);
    expect(n).toMatchObject({ title: "Brian needs a job started for Tom Goodman", url: "/appointments/appt-tom", mode: "once_per_window" });
  });

  it("on a visit that is over, the bell never says he is at it or can't clock in (audit v1018)", async () => {
    // tomVisit is marked completed.
    const res = await askOfficeToStartJob("appt-tom");
    expect(res).toMatchObject({ ok: true, message: "The office has been asked to start a job for this visit." });
    const body = spies.ring.mock.calls[0][2].body as string;
    expect(body).toBe("Brian asks for a job on Inspection — Tom Goodman, a visit that is done, so the work can go on. Start it from the visit.");
    expect(body).not.toContain(" is at ");
    expect(body).not.toContain("clock in");
  });

  it("on a visit still under way, the bell says he is at it and can't clock in yet", async () => {
    state.visit = { ...tomVisit, status: "scheduled", starts_at: new Date().toISOString(), ends_at: null };
    const res = await askOfficeToStartJob("appt-tom");
    expect(res).toMatchObject({ ok: true, message: "The office has been asked. Once they start the job, you can clock in right here." });
    expect(spies.ring.mock.calls[0][2].body).toBe("Brian is at Inspection — Tom Goodman and can't clock in until it has a job. Start it from the visit.");
  });

  it("with nobody in the office to ring, it says call them instead", async () => {
    state.staffIds = [];
    const res = await askOfficeToStartJob("appt-tom");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Call them instead");
  });
});

describe("Link To J-055 Instead", () => {
  const j55 = {
    id: "job-55",
    job_number: "J-055",
    name: "3245 West Lake Boulevard",
    status: "in_progress",
    customer_id: "cust-tom",
    created_at: "2026-09-25T22:29:56.167Z", // 3:29 PM Pacific, the visit's day
  };

  it("offers the one open job of the same customer made on the visit's day", () => {
    expect(linkInsteadPick([j55], visitDay(tomVisit.starts_at, TZ), TZ)?.id).toBe("job-55");
  });

  it("Tom Goodman as it stands: J-055 FINISHED (INV-079 sent) is still the one to offer", () => {
    const day = visitDay(tomVisit.starts_at, TZ);
    expect(linkInsteadPick([{ ...j55, status: "complete" }], day, TZ)?.id).toBe("job-55");
    // Every standing status counts; cancelled and a status the app does not know never do.
    for (const st of ["to_be_scheduled", "scheduled", "in_progress", "on_hold", "complete", "invoiced"]) {
      expect(linkableStatus(st), st).toBe(true);
    }
    for (const st of ["cancelled", "completed", "", null, undefined]) expect(linkableStatus(st), String(st)).toBe(false);
  });

  it("an open job and a finished one made the same day: the open one is offered", () => {
    // The morning service call J-054 is finished; the office made J-055 for the afternoon work.
    const day = visitDay(tomVisit.starts_at, TZ);
    const j54 = { ...j55, id: "job-54", job_number: "J-054", status: "complete", created_at: "2026-09-25T16:00:00Z" };
    expect(linkInsteadPick([j54, j55], day, TZ)?.id).toBe("job-55");
    expect(linkInsteadPick([j55, { ...j54, status: "invoiced" }], day, TZ)?.id).toBe("job-55");
  });

  it("links the open J-055 when a finished J-054 was made the same day, and makes nothing new", async () => {
    state.jobs = [{ ...j55, id: "job-54", job_number: "J-054", status: "complete", created_at: "2026-09-25T16:00:00Z" }, j55];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(res).toMatchObject({ ok: true, jobId: "job-55" });
    expect(spies.link).toHaveBeenCalledWith("appt-tom", "job", "job-55");
    expect(spies.createJob).not.toHaveBeenCalled();
    // The finished one is not the offer, so a stale tap on it changes nothing.
    spies.link.mockClear();
    const stale = await linkVisitInstead("appt-tom", "job-54");
    expect(stale).toMatchObject({ ok: false });
    expect(spies.link).not.toHaveBeenCalled();
  });

  it("offers nothing for two open jobs, two finished ones, a cancelled one, or one made another day", () => {
    const day = visitDay(tomVisit.starts_at, TZ);
    expect(linkInsteadPick([j55, { ...j55, id: "job-57", job_number: "J-057" }], day, TZ)).toBeNull();
    // Two open ones plus a finished one is still a question.
    expect(
      linkInsteadPick([j55, { ...j55, id: "job-57", job_number: "J-057" }, { ...j55, id: "job-54", status: "complete" }], day, TZ),
    ).toBeNull();
    // No open one and two finished ones is a question too.
    expect(
      linkInsteadPick([{ ...j55, status: "complete" }, { ...j55, id: "job-57", job_number: "J-057", status: "invoiced" }], day, TZ),
    ).toBeNull();
    expect(linkInsteadPick([{ ...j55, status: "cancelled" }], day, TZ)).toBeNull();
    expect(linkInsteadPick([{ ...j55, created_at: "2026-09-24T22:00:00Z" }], day, TZ)).toBeNull();
    // 11:30 PM Pacific on the 25th is 06:30 UTC on the 26th: still the visit's day on the org's clock.
    expect(linkInsteadPick([{ ...j55, created_at: "2026-09-26T06:30:00Z" }], day, TZ)?.id).toBe("job-55");
    // A cancelled job alongside the standing one does not spoil the offer.
    expect(linkInsteadPick([j55, { ...j55, id: "job-40", status: "cancelled" }], day, TZ)?.id).toBe("job-55");
  });

  it("the read asks for this customer's standing jobs made on the visit's org-local day, and no other", async () => {
    state.jobs = [
      { ...j55, status: "complete" },
      // An older job of Tom's, and a cancelled duplicate from the same afternoon: neither is on offer.
      { ...j55, id: "job-12", job_number: "J-012", status: "complete", created_at: "2026-03-02T18:00:00Z" },
      { ...j55, id: "job-58", job_number: "J-058", status: "cancelled", created_at: "2026-09-25T23:10:00Z" },
    ];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(res).toMatchObject({ ok: true, jobId: "job-55" });
    const day = visitDayBounds("2026-09-25", TZ);
    expect(day).toEqual({ start: "2026-09-25T07:00:00.000Z", end: "2026-09-26T07:00:00.000Z" });
    expect(state.jobReads).toEqual([{ neq: "cancelled", gte: day.start, lt: day.end }]);
  });

  it("the day window follows the org's clock across a time change", () => {
    // 2026-11-01 is the fall-back day in Los Angeles: 25 hours long.
    expect(visitDayBounds("2026-11-01", TZ)).toEqual({ start: "2026-11-01T07:00:00.000Z", end: "2026-11-02T08:00:00.000Z" });
  });

  it("links a FINISHED J-055 to the completed visit through linkAppointmentTo, and says nothing new was made", async () => {
    state.jobs = [{ ...j55, status: "complete" }];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(spies.link).toHaveBeenCalledWith("appt-tom", "job", "job-55");
    expect(res).toMatchObject({ ok: true, jobId: "job-55", message: "Linked this visit to J-055. Nothing new was made." });
    expect(spies.createJob).not.toHaveBeenCalled();
  });

  it("a visit that is over offers no clock on a finished job; any other pairing still does", () => {
    expect(clockOffered(true, "complete")).toBe(false);
    expect(clockOffered(true, "invoiced")).toBe(false);
    expect(clockOffered(true, "in_progress")).toBe(true);
    expect(clockOffered(false, "complete")).toBe(true);
    expect(clockOffered(false, null)).toBe(true);
  });

  describe("a visit is over when it is marked completed, or when its day has passed on the org's clock (audit v1018)", () => {
    // 2026-09-26, 9:00 AM in Los Angeles.
    const now = Date.parse("2026-09-26T16:00:00.000Z");
    it("Matt Warren: left scheduled, ended 2026-09-02 (J-045 finished) is over, so no Clock In On J-045", () => {
      const matt = { status: "scheduled", starts_at: "2026-09-01T23:00:00.000Z", ends_at: "2026-09-02T00:00:00.000Z" };
      expect(visitIsOver(matt, TZ, now)).toBe(true);
      expect(clockOffered(visitIsOver(matt, TZ, now), "complete")).toBe(false);
    });
    it("marked completed is over whatever its date", () => {
      expect(visitIsOver({ status: "completed", starts_at: "2026-09-30T17:00:00.000Z" }, TZ, now)).toBe(true);
      expect(visitIsOver({ status: "completed" }, TZ, now)).toBe(true);
    });
    it("today's visit is not over even once its hour has passed (the work goes on: Tom Goodman)", () => {
      const earlier = { status: "scheduled", starts_at: "2026-09-26T14:00:00.000Z", ends_at: "2026-09-26T15:00:00.000Z" };
      expect(visitIsOver(earlier, TZ, now)).toBe(false);
      // 11 PM last night on the org's clock is 6 AM UTC today: still yesterday, so over.
      expect(visitIsOver({ status: "scheduled", ends_at: "2026-09-26T06:00:00.000Z" }, TZ, now)).toBe(true);
      // 12:30 AM today on the org's clock (7:30 AM UTC): today, not over.
      expect(visitIsOver({ status: "scheduled", ends_at: "2026-09-26T07:30:00.000Z" }, TZ, now)).toBe(false);
    });
    it("the end decides a visit that runs across days; with no end the start does; with neither it is not over", () => {
      expect(visitIsOver({ status: "scheduled", starts_at: "2026-09-25T16:00:00.000Z", ends_at: "2026-09-26T20:00:00.000Z" }, TZ, now)).toBe(false);
      expect(visitIsOver({ status: "scheduled", starts_at: "2026-09-25T16:00:00.000Z", ends_at: null }, TZ, now)).toBe(true);
      expect(visitIsOver({ status: "proposed", starts_at: null, ends_at: null }, TZ, now)).toBe(false);
      expect(visitIsOver({ status: "scheduled", starts_at: "not a date" }, TZ, now)).toBe(false);
      expect(visitIsOver({ status: "scheduled", starts_at: "2026-09-29T16:00:00.000Z" }, TZ, now)).toBe(false);
    });
  });

  it("links through linkAppointmentTo when the rule still names that job", async () => {
    state.jobs = [j55];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(spies.link).toHaveBeenCalledWith("appt-tom", "job", "job-55");
    expect(res).toMatchObject({ ok: true, jobId: "job-55", message: "Linked this visit to J-055. Nothing new was made." });
  });

  it("finds the customer through the lead when the visit has none, and the lead is won", async () => {
    state.visit = { ...tomVisit, customer_id: null, inquiry_id: "lead-tom" };
    state.inquiryCustomer = "cust-tom";
    state.jobs = [j55];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(res.ok).toBe(true);
    // The job carries the lead, only when it carries none.
    const jobWrite = state.writes.find((w) => w.table === "jobs");
    expect(jobWrite?.patch).toEqual({ inquiry_id: "lead-tom" });
    expect(jobWrite?.filters).toEqual(expect.arrayContaining([["eq", "id", "job-55"], ["is", "inquiry_id", null]]));
    // The lead is stamped won, only when nobody stamped it yet.
    const leadWrite = state.writes.find((w) => w.table === "inquiries");
    expect(leadWrite?.patch).toMatchObject({ status: "won" });
    expect(leadWrite?.filters).toEqual(expect.arrayContaining([["eq", "id", "lead-tom"], ["is", "converted_at", null]]));
    expect(spies.revalidate).toHaveBeenCalledWith("/leads");
  });

  it("a visit with no lead writes nothing to leads or the job", async () => {
    state.jobs = [j55];
    await linkVisitInstead("appt-tom", "job-55");
    expect(state.writes).toEqual([]);
  });

  it("refuses a job the rule no longer names, and a visit that already has a job", async () => {
    state.jobs = [j55, { ...j55, id: "job-57", job_number: "J-057" }];
    const two = await linkVisitInstead("appt-tom", "job-55");
    expect(two.ok).toBe(false);
    expect(two.error).toContain("Nothing was changed");

    state.jobs = [j55];
    state.visit = { ...tomVisit, job_id: "job-12" };
    const linked = await linkVisitInstead("appt-tom", "job-55");
    expect(linked.ok).toBe(false);
    expect(spies.link).not.toHaveBeenCalled();
  });
});

describe("the start window, on the org's clock", () => {
  it("midnight yesterday is the floor; a minute of skew past now is allowed", () => {
    expect(new Date(startFloorMs(NOW, TZ)).toISOString()).toBe("2026-09-24T07:00:00.000Z");
    expect(startedAtProblem("2026-09-24T07:00:00.000Z", NOW, TZ)).toBeNull();
    expect(startedAtProblem("2026-09-24T06:59:00.000Z", NOW, TZ)).toMatch(/midnight yesterday/);
    expect(startedAtProblem(new Date(NOW + 30_000).toISOString(), NOW, TZ)).toBeNull();
    expect(startedAtProblem(new Date(NOW + 5 * 60_000).toISOString(), NOW, TZ)).toMatch(/hasn't happened/);
    expect(startedAtProblem(null, NOW, TZ)).toBeNull();
  });
});
