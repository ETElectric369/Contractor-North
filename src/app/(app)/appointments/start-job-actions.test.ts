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
 *   - "Link To J-055 Instead" is offered only for exactly one open job of the same customer made on
 *     the visit's day, and the link re-asks that rule before it writes.
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
import { linkInsteadPick, startedAtProblem, startFloorMs, visitDay } from "@/lib/appointments/visit-start";

const TZ = "America/Los_Angeles";

type Q = { table: string; cols: string; filters: [string, string, unknown][] };

function fake() {
  const calls: Q[] = [];
  const answer = (q: Q) => {
    const f = (col: string) => q.filters.find(([, c]) => c === col)?.[2];
    if (q.table === "appointments") return { data: state.visit, error: null };
    if (q.table === "organizations") return { data: { settings: { timezone: TZ } }, error: null };
    if (q.table === "time_entries") return { data: state.open.length ? state.open.shift() : null, error: null };
    if (q.table === "jobs" && f("id")) {
      return { data: { id: f("id"), job_number: "J-056", name: "Inspection — Tom Goodman" }, error: null };
    }
    if (q.table === "jobs" && f("customer_id")) {
      const statuses = f("status") as string[];
      return { data: state.jobs.filter((j) => j.customer_id === f("customer_id") && statuses.includes(j.status)), error: null };
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
    expect(res.onClock).toEqual({ entryId: "entry-50", label: "J-050", since: "8:00 AM" });
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

  it("a switch the Timeclock refuses (the long-shift guard) leaves the clock where it was and says so", async () => {
    state.open = [running];
    spies.switchJob.mockResolvedValue({ ok: false, needsTime: true, error: "You've been on the clock since Thu Sep 24, 7:00 AM, more than 12 hours." });
    const res = await startJobFromVisit({ appointmentId: "appt-tom", clock: "switch" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe("Started J-056 for Tom Goodman.");
    expect(res.warning).toContain("Your clock is still on J-050: You've been on the clock since");
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

  it("offers nothing for two such jobs, a closed one, or one made another day", () => {
    const day = visitDay(tomVisit.starts_at, TZ);
    expect(linkInsteadPick([j55, { ...j55, id: "job-57", job_number: "J-057" }], day, TZ)).toBeNull();
    expect(linkInsteadPick([{ ...j55, status: "completed" }], day, TZ)).toBeNull();
    expect(linkInsteadPick([{ ...j55, created_at: "2026-09-24T22:00:00Z" }], day, TZ)).toBeNull();
    // 11:30 PM Pacific on the 25th is 06:30 UTC on the 26th: still the visit's day on the org's clock.
    expect(linkInsteadPick([{ ...j55, created_at: "2026-09-26T06:30:00Z" }], day, TZ)?.id).toBe("job-55");
    // A closed job alongside the open one does not spoil the offer.
    expect(linkInsteadPick([j55, { ...j55, id: "job-40", status: "completed" }], day, TZ)?.id).toBe("job-55");
  });

  it("links through linkAppointmentTo when the rule still names that job", async () => {
    state.jobs = [j55];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(spies.link).toHaveBeenCalledWith("appt-tom", "job", "job-55");
    expect(res).toMatchObject({ ok: true, jobId: "job-55", message: "Linked this visit to J-055. Nothing new was made." });
  });

  it("finds the customer through the lead when the visit has none", async () => {
    state.visit = { ...tomVisit, customer_id: null, inquiry_id: "lead-tom" };
    state.inquiryCustomer = "cust-tom";
    state.jobs = [j55];
    const res = await linkVisitInstead("appt-tom", "job-55");
    expect(res.ok).toBe(true);
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
