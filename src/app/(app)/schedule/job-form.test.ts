import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NEW JOB IN FOUR FIELDS, EDIT JOB IN FIVE (W1-22), on the server, without a database.
 *
 *   updateJob   writes a column only when its field is in the form: the short Edit Job can never
 *               clear the job's dates, its scope or its crew (or push an empty schedule to Google),
 *               while a caller that still sends them keeps the old behaviour. A typed new customer
 *               goes through the one match-then-insert door, so no twin is made.
 *   createJob   the status comes from the date on the company's today (none: To Be Scheduled), the
 *               instant is built on the company's clock at its work-day start, the name is "Smith ·
 *               1871 Apache Ct" when none is sent, the billing is the company's usual kind, and a
 *               sent status or name still wins (the Timeclock's quick add, Nort). Never on hold.
 */
type Row = Record<string, any>;
type Call = { table: string; op: "select" | "insert" | "update"; cols: string; head: boolean; filters: Record<string, unknown>; row?: Row };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  settings: { timezone: "America/Denver", work_day_start: "07:30", work_day_end: "15:30" } as Row,
  customers: [] as Row[],
  counts: { tm: 0, fixed: 0 } as Record<string, number>,
}));

function builder(table: string) {
  const call: Call = { table, op: "select", cols: "", head: false, filters: {} };
  const run = (single: boolean) => {
    state.calls.push(call);
    if (call.op === "insert") return { data: { id: table === "customers" ? "cust-new" : "job-new" }, error: null };
    if (call.op === "update") return { data: [{ id: String(call.filters.id ?? "x") }], error: null };
    if (table === "organizations") return { data: { settings: state.settings }, error: null };
    if (table === "customers") {
      if (single) return { data: state.customers.find((c) => c.id === call.filters.id) ?? null, error: null };
      return { data: state.customers, error: null };
    }
    if (table === "jobs" && call.head) return { data: null, count: state.counts[String(call.filters.billing_type)] ?? 0, error: null };
    if (table === "jobs" && single) return { data: { assigned_to: ["p-old"], org_id: "org-1", job_number: "J-011" }, error: null };
    return { data: [], error: null };
  };
  const b: any = {
    select(cols?: string, opts?: { head?: boolean }) {
      if (call.op === "select") {
        call.cols = cols ?? "";
        call.head = !!opts?.head;
      }
      return b;
    },
    insert(row: Row) {
      call.op = "insert";
      call.row = row;
      return b;
    },
    update(row: Row) {
      call.op = "update";
      call.row = row;
      return b;
    },
    eq(c: string, v: unknown) {
      call.filters[c] = v;
      return b;
    },
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
  };
  for (const m of ["neq", "in", "is", "not", "or", "order", "limit"]) b[m] = () => b;
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "office-1", orgId: "org-1" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined), deleteCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("../billing/actions", () => ({
  createInvoiceFromQuote: vi.fn(),
  createBlankInvoice: vi.fn(),
  importLaborIntoInvoice: vi.fn(),
  importCostsIntoInvoice: vi.fn(),
  importChangeOrdersIntoInvoice: vi.fn(),
  createProgressReportInvoice: vi.fn(),
  emailInvoice: vi.fn(),
  setInvoiceTaxRate: vi.fn(),
}));

const { createJob } = await import("./actions");
const { updateJob } = await import("../jobs/actions");
const { notifyJobCrewAdded } = await import("@/lib/crew-notify");
const { pushCalendarItem } = await import("@/lib/calendar-sync");
const { todayStrInTz, tzDateTimeUtc } = await import("@/lib/tz");
const { addDays } = await import("@/lib/come-back-days");

const fd = (entries: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
};
const writes = (table: string, op: "insert" | "update") => state.calls.filter((c) => c.table === table && c.op === op);
const inserted = () => writes("jobs", "insert")[0]?.row ?? {};
const today = () => todayStrInTz("America/Denver");

beforeEach(() => {
  state.calls = [];
  state.customers = [
    { id: "cust-smith", name: "Rita Smith", company_name: null, type: "residential", phone: "(530) 606-0045", email: null },
    { id: "cust-hoa", name: "Pat Lee", company_name: "Tahoe Tavern HOA", type: "commercial", phone: null, email: "pat@example.test" },
  ];
  state.counts = { tm: 0, fixed: 0 };
  vi.mocked(notifyJobCrewAdded).mockClear();
  vi.mocked(pushCalendarItem).mockClear();
});

describe("updateJob: the short Edit Job never clears what it didn't send", () => {
  const EDIT_FORM = { name: "Smith · 1871 Apache Ct", customer_id: "cust-smith", address: "1871 Apache Ct", city: "Olympic Valley", state: "CA", zip: "96146", unit: "", billing_type: "tm" };

  it("the five fields are written; the dates, the description and the crew are left alone", async () => {
    expect(await updateJob("j1", fd(EDIT_FORM))).toEqual({ ok: true });
    const patch = writes("jobs", "update")[0].row!;
    expect(patch).toMatchObject({ name: EDIT_FORM.name, customer_id: "cust-smith", address: "1871 Apache Ct", city: "Olympic Valley", unit: null, billing_type: "tm" });
    for (const col of ["scheduled_start", "scheduled_end", "description", "assigned_to"]) expect(patch, col).not.toHaveProperty(col);
    // No crew was sent, so nobody is told they were put on the job.
    expect(notifyJobCrewAdded).not.toHaveBeenCalled();
  });

  it("a caller that still sends the dates, the scope and the crew gets them written, as before", async () => {
    const start = "2026-10-01T15:00:00.000Z";
    await updateJob("j1", fd({ ...EDIT_FORM, description: "Swap the panel", scheduled_start: start, scheduled_end: "", assigned_to: ["p-1", "p-2"] }));
    const patch = writes("jobs", "update")[0].row!;
    expect(patch).toMatchObject({ description: "Swap the panel", scheduled_start: start, scheduled_end: null, assigned_to: ["p-1", "p-2"] });
    expect(notifyJobCrewAdded).toHaveBeenCalledOnce();
  });

  it("a name only: nothing else moves", async () => {
    await updateJob("j1", fd({ name: "Renamed" }));
    expect(Object.keys(writes("jobs", "update")[0].row!).sort()).toEqual(["name", "updated_at"]);
  });

  it("a typed new customer already in the book is linked, never made twice", async () => {
    await updateJob("j1", fd({ name: "X", new_customer_name: "Rita Smith", new_customer_phone: "5306060045" }));
    expect(writes("customers", "insert")).toEqual([]);
    expect(writes("jobs", "update")[0].row!.customer_id).toBe("cust-smith");
  });

  it("a billing kind the database doesn't know is refused in words, and nothing is written", async () => {
    expect(await updateJob("j1", fd({ name: "X", billing_type: "draw" }))).toEqual({ ok: false, error: "Pick Time & Material or Fixed Price." });
    expect(writes("jobs", "update")).toEqual([]);
  });
});

describe("createJob: what the four-field form doesn't ask, the server works out", () => {
  it("today (the company's) is In Progress, a later day Scheduled, no day To Be Scheduled", async () => {
    await createJob(fd({ scheduled_date: today(), scheduled_time: "", address: "1 A St" }));
    expect(inserted().status).toBe("in_progress");
    state.calls = [];
    await createJob(fd({ scheduled_date: addDays(today(), 3), scheduled_time: "", address: "1 A St" }));
    expect(inserted().status).toBe("scheduled");
    state.calls = [];
    await createJob(fd({ scheduled_date: "", scheduled_time: "", address: "1 A St" }));
    expect(inserted().status).toBe("to_be_scheduled");
    expect(inserted().scheduled_start).toBeNull();
    expect(pushCalendarItem).toHaveBeenCalledTimes(2); // the two dated jobs, never the undated one
  });

  it("the instant is built on the company's clock: a blank time is its work-day start, a picked time is kept", async () => {
    const day = addDays(today(), 2);
    await createJob(fd({ scheduled_date: day, scheduled_time: "", address: "1 A St" }));
    expect(inserted().scheduled_start).toBe(tzDateTimeUtc(day, "07:30", "America/Denver"));
    state.calls = [];
    await createJob(fd({ scheduled_date: day, scheduled_time: "13:15", address: "1 A St" }));
    expect(inserted().scheduled_start).toBe(tzDateTimeUtc(day, "13:15", "America/Denver"));
  });

  it("no name sent: the customer's last name · the street, a business by its own name, else New Job on the company's day", async () => {
    await createJob(fd({ customer_id: "cust-smith", address: "1871 Apache Ct", scheduled_date: "" }));
    expect(inserted().name).toBe("Smith · 1871 Apache Ct");
    state.calls = [];
    await createJob(fd({ customer_id: "cust-hoa", address: "300 W Lake Blvd", scheduled_date: "" }));
    expect(inserted().name).toBe("Tahoe Tavern HOA · 300 W Lake Blvd");
    state.calls = [];
    await createJob(fd({ scheduled_date: "" }));
    const words = new Date(`${today()}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    expect(inserted().name).toBe(`New Job · ${words}`);
  });

  it("an explicit status and name still win (the Timeclock's quick add, Nort)", async () => {
    await createJob(fd({ name: "Panel swap", status: "in_progress", scheduled_date: addDays(today(), 5) }));
    expect(inserted()).toMatchObject({ name: "Panel swap", status: "in_progress" });
  });

  it("a caller that sends no date at all keeps In Progress (Nort's job.create)", async () => {
    await createJob(fd({ name: "The Miller deck" }));
    expect(inserted().status).toBe("in_progress");
  });

  it("the billing: what was sent, else the kind most of the company's jobs use, else Time & Material", async () => {
    state.counts = { tm: 2, fixed: 7 };
    await createJob(fd({ name: "A", scheduled_date: "" }));
    expect(inserted().billing_type).toBe("fixed");
    state.calls = [];
    await createJob(fd({ name: "B", scheduled_date: "", billing_type: "tm" }));
    expect(inserted().billing_type).toBe("tm");
    state.calls = [];
    state.counts = { tm: 0, fixed: 0 };
    await createJob(fd({ name: "C", scheduled_date: "" }));
    expect(inserted().billing_type).toBe("tm");
  });

  it("a new customer already in the book (by phone) is linked, never a twin", async () => {
    await createJob(fd({ new_customer_name: "Rita S", new_customer_phone: "530.606.0045", address: "9 Pine Rd", scheduled_date: "" }));
    expect(writes("customers", "insert")).toEqual([]);
    expect(inserted().customer_id).toBe("cust-smith");
  });

  it("still never born on hold", async () => {
    expect(await createJob(fd({ status: "on_hold", scheduled_date: "" }))).toEqual({
      ok: false,
      error: "Make the job first, then put it on hold. It asks why and for a day.",
    });
    expect(state.calls.filter((c) => c.op !== "select")).toEqual([]);
  });
});

describe("the forms (source)", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

  it("New Job asks no Job Name and no Status; it says what the job will be called", () => {
    const s = code(read("src/app/(app)/schedule/new-job-button.tsx"));
    expect(s).not.toMatch(/name="name"/);
    expect(s).not.toMatch(/name="status"/);
    expect(s).toContain("It&apos;ll Be Called:");
    expect(s).toContain('title="New Job"');
    expect(s).toContain('saveLabel="Create Job"');
    expect(s).toContain("More Options");
    expect(s).toContain("Not Scheduled Yet");
  });

  it("Edit Job is five fields: no dates, no description, no crew", () => {
    const s = code(read("src/app/(app)/jobs/[id]/job-edit-button.tsx"));
    for (const gone of ['name="scheduled_start"', 'name="description"', 'name="assigned_to"', 'type="date"', 'htmlFor="ej-city"', "<StateSelect"]) {
      expect(s, gone).not.toContain(gone);
    }
    expect(s).toContain('title="Edit Job"');
    expect(s).toContain('saveLabel="Save Changes"');
    expect(s).toContain("<CustomerPicker");
  });
});
