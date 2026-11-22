import { describe, it, expect, vi, beforeEach } from "vitest";
import { client, makeDb, type Db, type Row } from "@/lib/appointments/visit-db.test-util";

/**
 * THE BY-HAND NEW JOB DOOR TIES ITS VISIT AND SAYS SO (cn-v1181, I3). The owner, 2026-11-22: "shouldnt
 * it have automatically filed having a name and address on it that match exactly the job". createJob,
 * after the job is written, ties EXACTLY ONE open sales visit that matches exactly
 * (lib/appointments/tie-matching-visit) and says it in its own result; none or several, nothing; a tie
 * that fails is said and the job is made. On a stand-in that honours every filter and select list.
 * Stand-ins only: Dana Rook at 410 Larkspur Lane, Theo Vance.
 */
const state = vi.hoisted(() => ({ db: null as unknown as Db, lang: "en" }));
const sb = () => {
  const c = client(state.db) as any;
  c.auth = { getUser: async () => ({ data: { user: { id: "office-1" } } }) };
  return c;
};
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: sb(), userId: "office-1", orgId: "org-1" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => sb()), createServiceClient: vi.fn(() => sb()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined), deleteCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), recordAppError: vi.fn() }));
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
const { reportError } = await import("@/lib/observe");

const visit = (id: string, over: Row = {}): Row => ({
  id,
  org_id: "org-1",
  type: "inspection",
  title: "Site inspection: Dana Rook",
  status: "scheduled",
  outcome: null,
  outcome_at: null,
  starts_at: "2026-11-08T18:00:00Z",
  location: "410 Larkspur Lane, Truckee, CA 96161",
  inquiry_id: null,
  customer_id: null,
  job_id: null,
  updated_at: "2026-11-08T19:00:00Z",
  ...over,
});
const JOB_COLS = ["id", "org_id", "name", "customer_id", "description", "status", "billing_type", "address", "unit", "city", "state", "zip", "scheduled_start", "scheduled_end", "created_by", "inquiry_id", "job_number"];

beforeEach(() => {
  vi.mocked(reportError).mockClear();
  state.db = makeDb(
    {
      organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }],
      profiles: [{ id: "office-1", language: state.lang }],
      customers: [
        { id: "cust-dana", org_id: "org-1", name: "Dana Rook", company_name: null, type: "residential" },
        { id: "cust-theo", org_id: "org-1", name: "Theo Vance", company_name: null, type: "residential" },
      ],
      appointments: [visit("v-dana")],
      inquiries: [],
      jobs: [],
    },
    { jobs: JOB_COLS, appointments: Object.keys(visit("x")) },
  );
});

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};
const NEW_JOB = { customer_id: "cust-dana", address: "410 Larkspur Ln", city: "Truckee", state: "CA", zip: "96161", scheduled_date: "" };

describe("createJob ties the one visit that matches it exactly, and says so", () => {
  it("the visit is filed with the new job, and the answer names it and its day", async () => {
    const res = await createJob(fd(NEW_JOB));
    expect(res.ok).toBe(true);
    const job = state.db.tables.jobs[0];
    expect(res.id).toBe(job.id);
    expect(state.db.tables.appointments[0]).toMatchObject({ job_id: job.id, customer_id: "cust-dana", outcome: "won" });
    expect(res.note).toBe("Site inspection: Dana Rook (Sun Nov 8) is filed with this job.");
    expect(res.warning).toBeUndefined();
  });

  it("in Spanish", async () => {
    state.db.tables.profiles = [{ id: "office-1", language: "es" }];
    const res = await createJob(fd(NEW_JOB));
    expect(res.note).toBe("Site inspection: Dana Rook (dom 8 de nov) quedó archivada con este trabajo.");
  });

  it("another company's visit is never tied", async () => {
    state.db.tables.appointments = [visit("v-other", { org_id: "org-2" })];
    const res = await createJob(fd(NEW_JOB));
    expect(res.ok).toBe(true);
    expect(state.db.tables.appointments[0].job_id).toBeNull();
    expect(res.note).toBeUndefined();
  });

  it("a visit whose day is still ahead is not tied", async () => {
    state.db.tables.appointments = [visit("v-ahead", { starts_at: "2099-01-05T18:00:00Z" })];
    const res = await createJob(fd(NEW_JOB));
    expect(state.db.tables.appointments[0].job_id).toBeNull();
    expect(res.note).toBeUndefined();
  });

  it("another customer, or two visits that match: nothing is written", async () => {
    let res = await createJob(fd({ ...NEW_JOB, customer_id: "cust-theo" }));
    expect(state.db.tables.appointments[0].job_id).toBeNull();
    expect(res.note).toBeUndefined();
    state.db.tables.appointments = [visit("v-1"), visit("v-2", { starts_at: "2026-11-09T18:00:00Z" })];
    res = await createJob(fd(NEW_JOB));
    expect(state.db.tables.appointments.map((v) => v.job_id)).toEqual([null, null]);
    expect(res.note).toBeUndefined();
  });

  it("a tie that fails is said and filed; the job is made", async () => {
    state.db.fail!.write!.add("appointments");
    const res = await createJob(fd(NEW_JOB));
    expect(res.ok).toBe(true);
    expect(state.db.tables.jobs).toHaveLength(1);
    expect(res.note).toBeUndefined();
    expect(res.warning).toBe("Site inspection: Dana Rook (Sun Nov 8) matches this job but couldn't be filed with it. File it from Inspections.");
    expect(reportError).toHaveBeenCalledWith("tieMatchingVisit:write", expect.anything(), expect.objectContaining({ appointmentId: "v-dana" }));
  });

  it("the open visits unread: said, the job is made", async () => {
    state.db.fail!.read!.add("appointments");
    const res = await createJob(fd(NEW_JOB));
    expect(res.ok).toBe(true);
    expect(res.warning).toBe("The open inspections couldn't be checked for this job. Any that match it are offered on Inspections.");
  });
});

describe("cn-v1181 fixer: every door that makes a job by hand SAYS the tie (skeptic #84, S6)", () => {
  it("the Schedule sheet's new job for a customer (startJobOnDay) appends createJob's sentence to its own", async () => {
    const { startJobOnDay } = await import("./actions");
    Object.assign(state.db.tables.customers[0], { address: "410 Larkspur Ln", unit: null, city: "Truckee", state: "CA", zip: "96161" });
    const res = await startJobOnDay({ customerId: "cust-dana" }, { day: "2026-11-25" });
    // Whether the day went on or not on this stand-in, the visit filed with the job is said.
    expect(`${res.note ?? ""} ${res.error ?? ""}`).toContain("Site inspection: Dana Rook (Sun Nov 8) is filed with this job.");
    expect(state.db.tables.appointments[0].job_id).toBeTruthy();
  });

  it("sayTie: the note as a success and the warning as an error, each sticky; nothing when neither", async () => {
    const { sayTie } = await import("@/lib/appointments/say-tie");
    const toast = vi.fn();
    sayTie(toast, { note: "Site inspection: Dana Rook (Sun Nov 8) is filed with this job." });
    sayTie(toast, { warning: "The visit couldn't be filed with this job." });
    sayTie(toast, {});
    expect(toast.mock.calls).toEqual([
      ["Site inspection: Dana Rook (Sun Nov 8) is filed with this job.", "success", undefined, { sticky: true }],
      ["The visit couldn't be filed with this job.", "error", undefined, { sticky: true }],
    ]);
  });

  it("the New Job form and the Timeclock's quick add both say it, after the job is made", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");
    expect(src("src/app/(app)/schedule/new-job-button.tsx")).toMatch(/const res = await createJob\(formData\);[\s\S]{0,400}sayTie\(toast, res\);/);
    expect(src("src/app/(app)/timeclock/new-job-inline.tsx")).toMatch(/onCreated\(\{ id: res\.id, name: res\.name \|\| trimmed \}\);[\s\S]{0,200}sayTie\(toast, res\);/);
  });
});
