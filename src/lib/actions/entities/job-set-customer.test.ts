import { describe, it, expect, vi, beforeEach } from "vitest";

// Nort's job.setCustomer: the owner, driving, could not name who a job was for once it existed.
// The handler is driven for real with the one server action stubbed and a fake book behind the
// resolvers: one match sets; zero or several ask and write nothing; a new customer only when
// new_customer_name was passed; the invoices refusal reaches the person as said.

const { setJobCustomer, book } = vi.hoisted(() => ({
  setJobCustomer: vi.fn(),
  book: { jobs: [] as { id: string }[], customers: [] as { id: string }[] },
}));

vi.mock("@/app/(app)/jobs/actions", () => ({
  setJobStatus: vi.fn(),
  finishJob: vi.fn(),
  updateJobDescription: vi.fn(),
  setJobCustomer,
}));
vi.mock("@/app/(app)/schedule/actions", () => ({
  scheduleJobWindow: vi.fn(), setJobCrew: vi.fn(), createJob: vi.fn(), moveJobDay: vi.fn(),
  createScheduleProposal: vi.fn(), setJobHold: vi.fn(), snoozeJobHold: vi.fn(),
}));
vi.mock("@/app/(app)/jobs/[id]/job-contacts-actions", () => ({ linkJobContact: vi.fn(), unlinkJobContact: vi.fn() }));

/** A chainable fake: the table decides which rows the name lookup finds. */
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const rows = () => (table === "jobs" ? book.jobs : table === "customers" ? book.customers : []);
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "or", "ilike", "in", "is", "limit", "order"]) chain[k] = () => chain;
      chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) => res({ data: rows(), error: null });
      return chain;
    },
  })),
}));

import { REGISTRY } from "../registry";

const H = REGISTRY["job.setCustomer"].handler;
const ctx = { userId: "u1", orgId: "o1", role: "owner" } as never;
const JOB = "11111111-1111-4111-8111-111111111111";
const CUST = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  book.jobs = [{ id: JOB }];
  book.customers = [{ id: CUST }];
  setJobCustomer.mockResolvedValue({ ok: true, jobLabel: "J-014 · Larkspur", customerName: "Sam Tillery" });
});

describe("job.setCustomer handler", () => {
  it("one match sets, and says the job and the customer by name", async () => {
    const r = await H({ job_id: "Larkspur", customer_id: "Sam Tillery" }, ctx);
    expect(setJobCustomer).toHaveBeenCalledWith(JOB, { customerId: CUST });
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe("Recorded: J-014 · Larkspur is now for Sam Tillery.");
  });

  it("zero or several customers ask, and nothing is written", async () => {
    book.customers = [];
    const none = await H({ job_id: "Larkspur", customer_id: "Dana Rook" }, ctx);
    expect(none.ok).toBe(false);
    book.customers = [{ id: "a" }, { id: "b" }];
    const many = await H({ job_id: "Larkspur", customer_id: "Dana Rook" }, ctx);
    expect(many.ok).toBe(false);
    expect(many.error).toMatch(/which one/i);
    expect(setJobCustomer).not.toHaveBeenCalled();
  });

  it("zero or several jobs ask, and nothing is written", async () => {
    book.jobs = [{ id: "a" }, { id: "b" }];
    const many = await H({ job_id: "Snowbell", customer_id: "Sam Tillery" }, ctx);
    expect(many.ok).toBe(false);
    book.jobs = [];
    const none = await H({ job_id: "Snowbell", customer_id: "Sam Tillery" }, ctx);
    expect(none.ok).toBe(false);
    expect(setJobCustomer).not.toHaveBeenCalled();
  });

  it("a new customer only when new_customer_name was passed; with neither, it asks", async () => {
    await H({ job_id: "Larkspur", new_customer_name: "Theo Vance", phone: "5305550100", email: "theo@example.com" }, ctx);
    expect(setJobCustomer).toHaveBeenCalledWith(JOB, { newCustomer: { name: "Theo Vance", phone: "5305550100", email: "theo@example.com" } });
    setJobCustomer.mockClear();
    const neither = await H({ job_id: "Larkspur" }, ctx);
    expect(neither.ok).toBe(false);
    expect(setJobCustomer).not.toHaveBeenCalled();
  });

  it("the invoices refusal comes back as said", async () => {
    const said = "That job already has invoices under another customer. Change the customer in Edit Job, then check its invoices.";
    setJobCustomer.mockResolvedValue({ ok: false, error: said });
    const r = await H({ job_id: "Larkspur", customer_id: "Casey Loam" }, ctx);
    expect(r).toEqual({ ok: false, error: said });
  });

  it("a job with NO customer whose invoice is under somebody else: the action's refusal reaches the person, for a pick and for a typed new customer alike (skeptic #60)", async () => {
    // The rule itself is driven in jobs/set-job-customer.test.ts (it reads the invoices' own customer,
    // never the job's). Here: the handler hands the job and the customer over untouched, adds no rule
    // of its own in front (it does not look at whether the job has a customer), and says the refusal as said.
    const said = "That job already has invoices under another customer. Change the customer in Edit Job, then check its invoices.";
    setJobCustomer.mockResolvedValue({ ok: false, error: said });
    expect(await H({ job_id: "Larkspur", customer_id: "Dana Rook" }, ctx)).toEqual({ ok: false, error: said });
    expect(setJobCustomer).toHaveBeenLastCalledWith(JOB, { customerId: CUST });
    expect(await H({ job_id: "Larkspur", new_customer_name: "Theo Vance" }, ctx)).toEqual({ ok: false, error: said });
    expect(setJobCustomer).toHaveBeenLastCalledWith(JOB, { newCustomer: { name: "Theo Vance", phone: null, email: null } });
    // The sentence is the action's own, word for word (one rule, one place).
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/jobs/actions.ts"), "utf8");
    expect(actions).toContain(`"${said}"`);
    expect(actions).not.toContain("so the invoices can be checked"); // Edit Job checks nothing: the old promise
    // …and the description Nort reads still says when it refuses and where to send the person.
    expect(REGISTRY["job.setCustomer"].description).toContain("refuses when the job already has invoices under a different customer");
    expect(REGISTRY["job.setCustomer"].description).toContain("Edit Job");
  });

  it("says the customer the action SET, never the name that was typed (a typed name can match somebody on file under another spelling)", async () => {
    setJobCustomer.mockResolvedValue({ ok: true, jobLabel: "J-014 · Larkspur", customerName: "Sam Tillery" });
    const r = await H({ job_id: "Larkspur", new_customer_name: "Sam Tilery", phone: "5305550142" }, ctx);
    expect(r.recorded).toBe("Recorded: J-014 · Larkspur is now for Sam Tillery.");
    expect(r.recorded).not.toContain("Tilery");
  });

  it("is a staff door: a tech is not offered it", async () => {
    const { agentWriteToolsForRole } = await import("../agent-tools");
    expect(agentWriteToolsForRole("tech").tools.map((t) => t.name)).not.toContain("job__setCustomer");
    expect(REGISTRY["job.setCustomer"].auth).toBe("staff");
  });
});
