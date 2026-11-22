import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * HOW A SALE BECOMES A JOB WITH NO ESTIMATE (cn-v1176, lane ENDINGS), pinned against a stand-in client.
 *
 *   E1  every door through createJobFromAppointment stamps a sales visit Won (only where nothing is
 *       stamped, only on a visit with a win to record); since cn-v1178 (C2) the Start a Job card on a
 *       sales visit takes the sale's path (the job waits for a day, the visit is attached and Done).
 *   E2  startJobFromSale leaves the job the way an ACCEPTED ESTIMATE leaves it: waiting for a day, the
 *       inspection attached (never absorbed), Done, Won; the billing kind is the sheet's, else the
 *       company's; a visit with a job answers with it; the office only; a Not Sold, cancelled, work or
 *       already-accepted visit is refused with nothing made.
 *   E3  searchJobsForVisit re-reads the visit and offers only its customer's, its lead's customer's and
 *       its lead's jobs, never a cancelled one, with no money column read.
 *
 * Stand-in people and places only (Sam Tillery, Dana Rook; Larkspur, Snowbell).
 */
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  staff: true,
  db: {} as Record<string, Row[]>,
  selects: [] as { table: string; cols: string }[],
  seq: 0,
  usualKind: "tm" as "tm" | "fixed",
  taskMinutes: 0,
  workNotes: [] as string[],
  // The Won sheet's decision as startJobFromSale reads it (cn-v1176 fix F1: called, never copied). Its
  // own rows are pinned in lib/appointments/won-sheet.test.ts and appointments/won-actions.test.ts.
  sheet: null as any,
  sheetReads: 0,
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: client(), userId: "office-1", orgId: "org-1" } : { error: "This action is staff-only." })),
  requireMember: vi.fn(async () => ({ supabase: client(), userId: "office-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({
  notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })),
  officeRecipients: vi.fn(async () => []),
  ringOffice: vi.fn(async () => "nobody"),
}));
vi.mock("@/lib/actions/win-customer", () => ({ customerForInquiry: vi.fn(async () => null) }));
vi.mock("@/lib/lang-of", () => ({ callerLang: vi.fn(async () => "en") }));
vi.mock("@/lib/appointments/visit-work", () => ({
  visitWork: vi.fn(async () => ({ birth: { tasks: [], parts: [], plannedMinutes: state.taskMinutes || null }, typedItems: [], notes: state.workNotes })),
}));
vi.mock("@/lib/schedule-options", async (orig) => ({
  ...(await orig<typeof import("@/lib/schedule-options")>()),
  readUsualBillingKind: vi.fn(async () => state.usualKind),
}));
vi.mock("../timeclock/actions", () => ({ clockIn: vi.fn(), switchJob: vi.fn() }));
vi.mock("./won-actions", () => ({
  readWonSheet: vi.fn(async () => {
    state.sheetReads += 1;
    return state.sheet ?? { ok: true, state: "plain", why: "nothing_priced", billingKind: "tm", noCustomer: false };
  }),
}));

import { createJobFromAppointment, searchJobsForVisit } from "./actions";
import { startJobFromSale } from "./start-job-actions";
import { narrowJobRows, visitJobArms } from "@/lib/appointments/narrow-jobs";

type Filter = { op: string; col: string; val: any };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ op, col, val }) => {
    if (op === "eq") return row[col] === val;
    if (op === "neq") return row[col] !== val;
    if (op === "is") return (row[col] ?? null) === val;
    if (op === "in") return (val as unknown[]).includes(row[col]);
    if (op === "or")
      return String(val)
        .split(",")
        .some((arm) => {
          const [c, o, ...v] = arm.split(".");
          return o === "eq" && String(row[c] ?? "") === v.join(".");
        });
    return true;
  });
}

/** A projection read back with only the columns named (an alias `a:b->>c` reads the json key). */
function project(row: Row, cols: string): Row {
  const out: Row = {};
  for (const raw of cols.split(",").map((c) => c.trim())) {
    if (!raw || raw.includes("(")) continue;
    const alias = raw.match(/^(\w+):(\w+)->>(\w+)$/);
    if (alias) out[alias[1]] = row[alias[2]]?.[alias[3]] ?? null;
    else out[raw] = row[raw] ?? null;
  }
  return out;
}

function client(): any {
  return {
    from(table: string) {
      const q: { op: string; patch?: any; cols: string; filters: Filter[] } = { op: "select", cols: "*", filters: [] };
      const rows = () => (state.db[table] ??= []);
      const run = async (one: boolean): Promise<{ data: any; error: null }> => {
        if (q.op === "insert") {
          const id = `${table}-${++state.seq}`;
          const row = { id, ...q.patch };
          rows().push(row);
          return { data: one ? { id } : [{ id }], error: null };
        }
        const hit = rows().filter((r) => matches(r, q.filters));
        if (q.op === "update") {
          hit.forEach((r) => Object.assign(r, q.patch));
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        if (q.op === "delete") {
          state.db[table] = rows().filter((r) => !hit.includes(r));
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        const shaped = hit.map((r) => (q.cols === "*" ? { ...r } : project(r, q.cols)));
        return { data: one ? (shaped[0] ?? null) : shaped, error: null };
      };
      const chain: any = {
        select(cols?: string) {
          if (q.op === "select" && cols) {
            q.cols = cols;
            state.selects.push({ table, cols });
          }
          return chain;
        },
        insert: (p: any) => ((q.op = "insert"), (q.patch = p), chain),
        update: (p: any) => ((q.op = "update"), (q.patch = p), chain),
        delete: () => ((q.op = "delete"), chain),
        eq: (col: string, val: any) => (q.filters.push({ op: "eq", col, val }), chain),
        neq: (col: string, val: any) => (q.filters.push({ op: "neq", col, val }), chain),
        is: (col: string, val: any) => (q.filters.push({ op: "is", col, val }), chain),
        in: (col: string, val: any) => (q.filters.push({ op: "in", col, val }), chain),
        or: (val: string) => (q.filters.push({ op: "or", col: "", val }), chain),
        order: () => chain,
        limit: () => chain,
        single: () => run(true),
        maybeSingle: () => run(true),
        then: (ok: any, bad: any) => run(false).then(ok, bad),
      };
      return chain;
    },
  };
}

const VISIT: Row = {
  id: "visit-1",
  title: "Inspection: Sam Tillery",
  type: "inspection",
  outcome: null,
  status: "scheduled",
  customer_id: "cust-sam",
  location: "12 Larkspur Ln",
  unit: null,
  city: null,
  state: null,
  zip: null,
  job_id: null,
  starts_at: "2026-11-20T17:00:00.000Z",
  ends_at: "2026-11-20T18:00:00.000Z",
  planned_minutes: 60,
  inquiry_id: null,
  notes: null,
  absorbed: false,
  capture: {},
};

beforeEach(() => {
  state.staff = true;
  state.seq = 0;
  state.usualKind = "tm";
  state.taskMinutes = 0;
  state.workNotes = [];
  state.selects = [];
  state.sheet = null;
  state.sheetReads = 0;
  state.db = {
    appointments: [{ ...VISIT, capture: {} }],
    customers: [{ id: "cust-sam", name: "Sam Tillery", company_name: null, type: "residential" }],
    organizations: [{ id: "org-1", settings: {} }],
    inquiries: [],
    jobs: [],
    quotes: [],
    schedule_proposals: [],
  };
});

const visit = () => state.db.appointments.find((a) => a.id === "visit-1")!;
const jobsMade = () => state.db.jobs;

describe("E1: Start a Job marks a sales visit Won", () => {
  it("an undecided inspection becomes Won on the claim, with its time; since cn-v1178 (C2) the card's job takes the sale's path: it waits for a day and the inspection is attached and Done", async () => {
    const res = await createJobFromAppointment("visit-1");
    expect(res.ok).toBe(true);
    expect(visit().outcome).toBe("won");
    expect(typeof visit().outcome_at).toBe("string");
    expect(visit().absorbed).toBe(false);
    const job = jobsMade()[0];
    expect(job.status).toBe("to_be_scheduled");
    expect(job.scheduled_start).toBeNull();
    expect(visit().status).toBe("completed");
  });

  it("an outcome already stamped is kept: Not Sold is refused (cn-v1178) and nothing is made", async () => {
    visit().outcome = "lost";
    visit().outcome_at = "2026-11-01T00:00:00.000Z";
    const res = await createJobFromAppointment("visit-1");
    expect(res.ok).toBe(false);
    expect(jobsMade()).toEqual([]);
    expect(visit().outcome).toBe("lost");
    expect(visit().outcome_at).toBe("2026-11-01T00:00:00.000Z");
  });

  it("a visit with no win to record (a work visit, the city's final inspection) is never stamped", async () => {
    for (const type of ["job", "service_call", "final_inspection"]) {
      state.db.appointments = [{ ...VISIT, type, capture: {} }];
      state.db.jobs = [];
      await createJobFromAppointment("visit-1");
      expect(visit().outcome ?? null, type).toBeNull();
    }
  });

  it("the read names type, outcome and status (the projection law)", async () => {
    await createJobFromAppointment("visit-1");
    const read = state.selects.find((s) => s.table === "appointments" && s.cols.includes("planned_minutes"))!;
    for (const c of ["type", "outcome", "status"]) expect(read.cols.split(", "), c).toContain(c);
  });
});

describe("E2: startJobFromSale leaves the job the way an accepted estimate does", () => {
  it("the job waits for a day (to_be_scheduled, no start, no end); the inspection is attached, not absorbed, Done and Won", async () => {
    const res = await startJobFromSale("visit-1");
    expect(res).toEqual({ ok: true, job: { id: "jobs-1", number: null }, warnings: [] });
    const job = jobsMade()[0];
    expect(job.status).toBe("to_be_scheduled");
    expect(job.scheduled_start).toBeNull();
    expect(job.scheduled_end).toBeNull();
    // The inspection's own length is not the work's: unsized unless his tasks size it.
    expect(job.planned_minutes).toBeNull();
    expect(job.customer_id).toBe("cust-sam");
    expect(visit().job_id).toBe("jobs-1");
    expect(visit().absorbed).toBe(false);
    expect(visit().outcome).toBe("won");
    expect(visit().status).toBe("completed");
    expect(visit().type).toBe("inspection");
    // No multi-day segments for a job with no day.
    expect(state.db.job_schedule_segments ?? []).toEqual([]);
  });

  it("a warning is never dropped: the job maker's note comes back as the sheet's warning, in its words", async () => {
    state.workNotes = ["The tasks could not be read, so the job has none listed yet."];
    const res = await startJobFromSale("visit-1");
    expect(res).toMatchObject({ ok: true, job: { id: "jobs-1" } });
    expect(res.ok && res.warnings.join(" ")).toContain("The tasks could not be read, so the job has none listed yet.");
  });

  it("his task hours size the job; a long one still has no day", async () => {
    state.taskMinutes = 1200;
    await startJobFromSale("visit-1");
    expect(jobsMade()[0].planned_minutes).toBe(1200);
    expect(jobsMade()[0].scheduled_start).toBeNull();
    expect(state.db.job_schedule_segments ?? []).toEqual([]);
  });

  it("a pending pick-a-time link is withdrawn when the inspection is marked Done (the header's own door)", async () => {
    visit().status = "proposed";
    state.db.schedule_proposals = [{ id: "p-1", appointment_id: "visit-1", status: "pending" }];
    await startJobFromSale("visit-1");
    expect(visit().status).toBe("completed");
    expect(state.db.schedule_proposals[0].status).toBe("cancelled");
  });

  it("an inspection already done stays done; one stamped Won with no job keeps its stamp", async () => {
    visit().status = "completed";
    visit().outcome = "won";
    visit().outcome_at = "2026-11-19T00:00:00.000Z";
    const res = await startJobFromSale("visit-1");
    expect(res.ok).toBe(true);
    expect(visit().status).toBe("completed");
    expect(visit().outcome_at).toBe("2026-11-19T00:00:00.000Z");
  });

  it("the billing kind is the sheet's pick; absent, the company's usual one", async () => {
    state.usualKind = "tm";
    await startJobFromSale("visit-1", { billingType: "fixed" });
    expect(jobsMade()[0].billing_type).toBe("fixed");
    state.db.appointments = [{ ...VISIT, capture: {} }];
    state.db.jobs = [];
    state.usualKind = "fixed";
    await startJobFromSale("visit-1");
    expect(jobsMade()[0].billing_type).toBe("fixed");
    state.db.appointments = [{ ...VISIT, capture: {} }];
    state.db.jobs = [];
    state.usualKind = "tm";
    await startJobFromSale("visit-1", { billingType: "bogus" as never });
    expect(jobsMade()[0].billing_type).toBe("tm");
  });

  it("twice-safe: a second tap answers with the same job and makes nothing", async () => {
    const first = await startJobFromSale("visit-1");
    state.db.jobs[0].job_number = "J-900";
    const second = await startJobFromSale("visit-1");
    expect(first.ok && second.ok).toBe(true);
    expect(second).toEqual({ ok: true, job: { id: "jobs-1", number: "J-900" }, warnings: [] });
    expect(jobsMade()).toHaveLength(1);
  });

  it("the office only: a tech is refused before anything is read or made", async () => {
    state.staff = false;
    const res = await startJobFromSale("visit-1");
    expect(res).toEqual({ ok: false, error: "Only the office can start a job. Ask the office to start it, then clock in here." });
    expect(jobsMade()).toHaveLength(0);
  });

  it("refused with nothing made: cancelled, Not Sold, a work visit, and a visit whose estimate is already accepted", async () => {
    const refused = async (patch: Row, quote?: Row) => {
      state.db.appointments = [{ ...VISIT, capture: {}, ...patch }];
      state.db.quotes = quote ? [quote] : [];
      state.db.jobs = [];
      const res = await startJobFromSale("visit-1");
      expect(res.ok, JSON.stringify(patch)).toBe(false);
      expect(jobsMade(), JSON.stringify(patch)).toHaveLength(0);
      return res.ok ? "" : res.error;
    };
    expect(await refused({ status: "cancelled" })).toBe("This visit was cancelled. Tap Put It Back on the Schedule in its ⋯ first. Nothing was started.");
    expect(await refused({ outcome: "lost" })).toMatch(/^This inspection is marked Not Sold\. Tap Change on it and Clear the Answer first\./);
    expect(await refused({ type: "job" })).toBe("Only an inspection or an estimate visit is won. Nothing was started.");
    // A call is not a sale the Won sheet takes (won-sheet isWonVisitType, the door's own rule).
    expect(await refused({ type: "call" })).toBe("Only an inspection or an estimate visit is won. Nothing was started.");
    state.sheet = { ok: true, state: "finish", quote: { id: "q-1", number: "E-900" }, total: 500, billingKind: "tm" };
    expect(await refused({ capture: { quote_id: "q-1" } })).toBe(
      "E-900 is already accepted, so the job comes from it: tap Finish the Job from E-900. Nothing was started.",
    );
  });

  it("cn-v1176 fix F1 (re-pinned): a draft or sent estimate that stands for the visit or its lead refuses the plain start, naming it and the sheet's own button", async () => {
    // Was: "A draft or sent estimate behind the visit does not stop the plain start." That made a SECOND
    // job when the estimate was accepted later. The Won sheet's decision is called, never copied.
    for (const status of ["draft", "sent"]) {
      state.db.appointments = [{ ...VISIT, capture: {} }];
      state.db.jobs = [];
      state.sheet = { ok: true, state: "estimate", source: "existing", quote: { id: "q-2", number: "E-900" }, stamp: "x", lines: [], taxRate: 0, subtotal: 0, tax: 0, total: 0, billingKind: "tm", noCustomer: false, status };
      const res = await startJobFromSale("visit-1");
      expect(res).toEqual({ ok: false, error: "E-900 stands for this visit, so the job comes from it: tap Approve and Start the Job. Nothing was started." });
      expect(jobsMade()).toHaveLength(0);
    }
    // The lead's accepted estimate that has its job: the refer state's one button, by its exact words.
    state.sheet = { ok: true, state: "refer", quote: { id: "q-3", number: "E-901" }, job: { id: "j-9", number: "J-900" } };
    expect(await startJobFromSale("visit-1")).toEqual({
      ok: false,
      error: "E-901 is already accepted and has its job, J-900: tap Tie This Inspection to J-900. Nothing was started.",
    });
    // The sheet's own refusal rides through as said.
    state.sheet = { ok: false, error: "Couldn't read this inspection just now. Try again." };
    expect(await startJobFromSale("visit-1")).toEqual({ ok: false, error: "Couldn't read this inspection just now. Try again." });
    expect(jobsMade()).toHaveLength(0);
    // Only plain, or the visit's own lines, starts a job with no estimate.
    state.sheet = { ok: true, state: "estimate", source: "visit", quote: null, stamp: "x", lines: [], taxRate: 0, subtotal: 0, tax: 0, total: 0, billingKind: "tm", noCustomer: false };
    expect((await startJobFromSale("visit-1")).ok).toBe(true);
    expect(jobsMade()).toHaveLength(1);
  });

  it("cn-v1176 fix F1 + S1: the decision is the Won sheet's, called; Not Sold is the one rule", () => {
    const src = readFileSync("src/app/(app)/appointments/start-job-actions.ts", "utf8");
    expect(src).toContain("const sheet = await readWonSheet(visit.id);");
    expect(src).toContain("if (isNotSoldOutcome(visit.outcome))");
    expect(src).toContain("if (!isWonVisitType(visit.type))");
    expect(src).not.toMatch(/outcome === "lost" \|\| visit\.outcome === "no_bid"/);
    expect(src).not.toContain('status === "accepted"');
  });

  it("no money is read: every select names its columns and none is a price", async () => {
    await startJobFromSale("visit-1");
    for (const s of state.selects) {
      expect(s.cols, s.table).not.toBe("*");
      expect(s.cols, s.table).not.toMatch(/price|amount|total|rate|cost/);
    }
  });

  it("the Start a Job card's door is unchanged: the option is off by default and only startJobFromSale turns it on", () => {
    const src = readFileSync("src/app/(app)/appointments/start-job-actions.ts", "utf8");
    expect(src).toContain("const made = await createJobFromAppointment(visit.id);");
    expect(src).toContain("createJobFromAppointment(visit.id, { asSale: true, ...(billingType ? { billingType } : {}) })");
    const actions = readFileSync("src/app/(app)/appointments/actions.ts", "utf8");
    expect(actions).toContain("const asSale = opts?.asSale === true;");
  });
});

describe("E3: the narrowed pick", () => {
  beforeEach(() => {
    state.db.inquiries = [{ id: "lead-1", customer_id: "cust-dana" }];
    state.db.jobs = [
      { id: "j-sam", job_number: "J-900", name: "12 Larkspur Ln", address: "12 Larkspur Ln", status: "in_progress", customer_id: "cust-sam", inquiry_id: null, contract_amount: 9000 },
      { id: "j-dana", job_number: "J-901", name: "4 Snowbell Ct", address: "4 Snowbell Ct", status: "complete", customer_id: "cust-dana", inquiry_id: null },
      { id: "j-lead", job_number: "J-902", name: "Porch light", address: null, status: "to_be_scheduled", customer_id: null, inquiry_id: "lead-1" },
      { id: "j-gone", job_number: "J-903", name: "12 Larkspur Ln", address: "12 Larkspur Ln", status: "cancelled", customer_id: "cust-sam", inquiry_id: null },
      { id: "j-other", job_number: "J-904", name: "9 Catbird Way", address: "9 Catbird Way", status: "in_progress", customer_id: "cust-theo", inquiry_id: null },
    ];
  });

  it("re-reads the visit: its customer, its lead's customer and its lead; never a cancelled job or a stranger's; unfinished first", async () => {
    visit().inquiry_id = "lead-1";
    const rows = await searchJobsForVisit("visit-1", "");
    expect(rows.map((r) => r.id)).toEqual(["j-sam", "j-lead", "j-dana"]);
    expect(rows.every((r) => r.kind === "job")).toBe(true);
    // A typed term narrows inside that set only.
    expect((await searchJobsForVisit("visit-1", "snowbell")).map((r) => r.id)).toEqual(["j-dana"]);
    expect((await searchJobsForVisit("visit-1", "catbird")).map((r) => r.id)).toEqual([]);
  });

  it("names its columns, and none is money", async () => {
    visit().inquiry_id = "lead-1";
    await searchJobsForVisit("visit-1", "");
    const jobRead = state.selects.find((s) => s.table === "jobs")!;
    expect(jobRead.cols).toBe("id, job_number, name, address, city, state, zip, status");
    expect(state.selects.find((s) => s.table === "appointments")!.cols).toBe("id, customer_id, inquiry_id");
    expect(state.selects.find((s) => s.table === "inquiries")!.cols).toBe("customer_id");
  });

  it("a visit tied to nobody is offered nothing; a tech gets nothing", async () => {
    visit().customer_id = null;
    expect(await searchJobsForVisit("visit-1", "")).toEqual([]);
    visit().customer_id = "cust-sam";
    state.staff = false;
    expect(await searchJobsForVisit("visit-1", "")).toEqual([]);
  });

  it("the pure rules: the arms, and the order", () => {
    expect(visitJobArms({ customerId: "c1", leadCustomerId: "c1", inquiryId: "l1" })).toBe("customer_id.eq.c1,inquiry_id.eq.l1");
    expect(visitJobArms({ customerId: null, leadCustomerId: "c2", inquiryId: null })).toBe("customer_id.eq.c2");
    expect(visitJobArms({ customerId: null, leadCustomerId: null, inquiryId: null })).toBeNull();
    const rows = [
      { id: "a", name: "A", status: "complete" },
      { id: "b", name: "B", status: "cancelled" },
      { id: "c", name: "C", status: "in_progress" },
    ];
    expect(narrowJobRows(rows, "").map((r) => r.id)).toEqual(["c", "a"]);
    expect(narrowJobRows(rows, "  a ").map((r) => r.id)).toEqual(["a"]);
    // cn-v1176 fix F11: an invoiced job is finished too, after every unfinished one.
    const withBilled = [{ id: "i", name: "I", status: "invoiced" }, { id: "s", name: "S", status: "scheduled" }];
    expect(narrowJobRows(withBilled, "").map((r) => r.id)).toEqual(["s", "i"]);
  });
});
