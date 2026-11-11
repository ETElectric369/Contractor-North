import { describe, it, expect, vi, beforeEach } from "vitest";

// setJobCustomer: the one rule behind Nort's job.setCustomer. Its one refusal is keyed on WHO THE
// JOB'S INVOICES ARE FOR (each invoice's own customer_id), never on who the job is for: any invoice
// under somebody other than the customer being set refuses the change in words. A zero-row update is
// a refusal, never "Saved".

type Invoice = { id: string; customer_id: string | null };
type Customer = { id: string; name: string; company_name?: string | null; email?: string | null; phone?: string | null };

const s = vi.hoisted(() => ({
  job: null as null | { id: string; name: string; job_number: string; customer_id: string | null },
  invoices: [] as Invoice[],
  invoicesError: null as null | { message: string },
  customers: [] as Customer[],
  updated: [{ id: "j1" }] as { id: string }[],
  writes: [] as unknown[],
  inserts: [] as unknown[],
  selects: [] as { table: string; cols: string }[],
  client: null as any,
}));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: s.client, userId: "u1", orgId: "o1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { setJobCustomer } from "./actions";
import { pushCalendarItem } from "@/lib/calendar-sync";

/** The book and the job's invoices, answered by table. A pick reads ONE customer by id (.eq + maybeSingle);
 *  the match-or-create door reads the whole book (awaited) and inserts with .select("id").single(). */
function fake() {
  return {
    from(table: string) {
      let verb = "select";
      let payload: unknown = null;
      let byId: string | null = null;
      const rows = (): unknown[] => {
        if (verb === "update") { s.writes.push(payload); return s.updated; }
        if (table === "invoices") return s.invoices;
        if (table === "jobs") return s.job ? [s.job] : [];
        if (table === "customers") return byId ? s.customers.filter((c) => c.id === byId) : s.customers;
        return [];
      };
      const error = () => (table === "invoices" && verb === "select" ? s.invoicesError : null);
      const chain: any = {
        select: (cols: string) => { if (verb === "select") s.selects.push({ table, cols }); return chain; },
        update: (p: unknown) => { verb = "update"; payload = p; return chain; },
        insert: (p: unknown) => { verb = "insert"; s.inserts.push(p); return chain; },
        eq: (col: string, v: string) => { if (table === "customers" && col === "id") byId = v; return chain; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: error() }),
        single: async () => ({ data: verb === "insert" ? { id: "c-made" } : (rows()[0] ?? null), error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: error() ? null : rows(), error: error() }),
      };
      for (const m of ["limit", "in", "is", "order"]) chain[m] = () => chain;
      return chain;
    },
  };
}

const REFUSAL = "That job already has invoices under another customer. Change the customer in Edit Job, then check its invoices.";

beforeEach(() => {
  vi.clearAllMocks();
  s.client = fake();
  s.job = { id: "j1", name: "Larkspur", job_number: "J-014", customer_id: null };
  s.invoices = [];
  s.invoicesError = null;
  s.customers = [
    { id: "c-new", name: "Dana Rook", phone: "(530) 555-0111" },
    { id: "c-old", name: "Casey Loam", phone: "(530) 555-0122" },
  ];
  s.updated = [{ id: "j1" }];
  s.writes = [];
  s.inserts = [];
  s.selects = [];
});

describe("setJobCustomer", () => {
  it("puts a customer on a job that has none, writes only customer_id, and pushes the calendar", async () => {
    const r = await setJobCustomer("j1", { customerId: "c-new" });
    expect(r).toMatchObject({ ok: true, jobLabel: "J-014 · Larkspur", customerName: "Dana Rook" });
    expect(Object.keys(s.writes[0] as object).sort()).toEqual(["customer_id", "updated_at"]);
    expect((s.writes[0] as { customer_id: string }).customer_id).toBe("c-new");
    expect(pushCalendarItem).toHaveBeenCalledWith("job", "j1");
  });

  it("refuses in words when the job's invoice is under a DIFFERENT customer", async () => {
    s.job!.customer_id = "c-old";
    s.invoices = [{ id: "inv1", customer_id: "c-old" }];
    const r = await setJobCustomer("j1", { customerId: "c-new" });
    expect(r).toEqual({ ok: false, error: REFUSAL });
    expect(s.writes).toHaveLength(0);
  });

  it("THE JOB HAS NO CUSTOMER, ITS INVOICE DOES (skeptic #60): another customer is refused, the invoice's own goes through", async () => {
    // The rule used to ask "does the JOB have a customer?" first, so this job took anybody.
    s.job!.customer_id = null;
    s.invoices = [{ id: "inv1", customer_id: "c-old" }];
    expect(await setJobCustomer("j1", { customerId: "c-new" })).toEqual({ ok: false, error: REFUSAL });
    expect(s.writes).toEqual([]);
    expect(pushCalendarItem).not.toHaveBeenCalled();
    // The customer the invoice already carries is the repair, and it lands.
    const r = await setJobCustomer("j1", { customerId: "c-old" });
    expect(r).toMatchObject({ ok: true, customerName: "Casey Loam" });
    expect((s.writes[0] as { customer_id: string }).customer_id).toBe("c-old");
  });

  it("the invoices are read with their customer, for this job, whether or not the job has one", async () => {
    await setJobCustomer("j1", { customerId: "c-new" });
    expect(s.selects.filter((q) => q.table === "invoices")).toEqual([{ table: "invoices", cols: "id, customer_id" }]);
  });

  it("a different customer on an invoice-free job, or the same one its invoices carry, goes through", async () => {
    s.job!.customer_id = "c-old";
    expect((await setJobCustomer("j1", { customerId: "c-new" })).ok).toBe(true);
    s.job!.customer_id = "c-new";
    s.invoices = [{ id: "inv1", customer_id: "c-new" }, { id: "inv2", customer_id: "c-new" }];
    expect((await setJobCustomer("j1", { customerId: "c-new" })).ok).toBe(true);
  });

  it("an invoice with no customer on it refuses nothing; invoices under two customers refuse everybody", async () => {
    s.job!.customer_id = "c-old";
    s.invoices = [{ id: "inv1", customer_id: null }];
    expect((await setJobCustomer("j1", { customerId: "c-new" })).ok).toBe(true);
    s.writes = [];
    s.invoices = [{ id: "inv1", customer_id: "c-old" }, { id: "inv2", customer_id: "c-new" }];
    expect(await setJobCustomer("j1", { customerId: "c-new" })).toEqual({ ok: false, error: REFUSAL });
    expect(await setJobCustomer("j1", { customerId: "c-old" })).toEqual({ ok: false, error: REFUSAL });
    expect(s.writes).toEqual([]);
  });

  it("invoices that cannot be read change nothing, and say so", async () => {
    s.invoicesError = { message: "the reader tripped" };
    expect(await setJobCustomer("j1", { customerId: "c-new" })).toEqual({
      ok: false,
      error: "Couldn't check this job's invoices just now, so the customer wasn't changed. Try again.",
    });
    expect(s.writes).toEqual([]);
  });

  it("a missing job and a zero-row update are refusals said in words", async () => {
    s.job = null;
    expect(await setJobCustomer("j1", { customerId: "c-new" })).toEqual({ ok: false, error: "That job isn't available." });
    s.job = { id: "j1", name: "Larkspur", job_number: "J-014", customer_id: null };
    s.updated = [];
    expect(await setJobCustomer("j1", { customerId: "c-new" })).toEqual({ ok: false, error: "That job isn't available." });
    expect(pushCalendarItem).not.toHaveBeenCalled();
  });

  it("a typed NEW customer is refused BEFORE anyone is matched or made when an invoice already carries a customer — with or without one on the job", async () => {
    for (const jobCustomer of ["c-old", null]) {
      s.job = { id: "j1", name: "Larkspur", job_number: "J-014", customer_id: jobCustomer };
      s.invoices = [{ id: "inv1", customer_id: "c-old" }];
      s.selects = [];
      const r = await setJobCustomer("j1", { newCustomer: { name: "Theo Vance", phone: "(530) 555-0142" } });
      expect(r, String(jobCustomer)).toEqual({ ok: false, error: REFUSAL });
      expect(s.inserts).toEqual([]); // no customer was minted for a change that was never going to land
      expect(s.selects.some((q) => q.table === "customers")).toBe(false); // …and the book was not even read
      expect(s.writes).toEqual([]);
    }
  });

  it("a typed new customer who is ALREADY in the book under another spelling: the customer on file is set, and NAMED (never the typed spelling)", async () => {
    s.customers = [{ id: "c-sam", name: "Sam Tillery", phone: "(530) 555-0142" }];
    const r = await setJobCustomer("j1", { newCustomer: { name: "Sam Tilery", phone: "5305550142" } });
    expect(r).toMatchObject({ ok: true, jobLabel: "J-014 · Larkspur", customerName: "Sam Tillery" });
    expect(s.inserts).toEqual([]); // matched on the phone: nobody is made
    expect((s.writes[0] as { customer_id: string }).customer_id).toBe("c-sam");
  });

  it("a typed new customer nobody matches is made once, and named as typed", async () => {
    s.customers = [];
    const r = await setJobCustomer("j1", { newCustomer: { name: "  Theo Vance ", phone: "5305550142" } });
    expect(r).toMatchObject({ ok: true, customerName: "Theo Vance" });
    expect(s.inserts).toHaveLength(1);
    expect(s.inserts[0]).toMatchObject({ name: "Theo Vance", phone: "(530) 555-0142" });
    expect((s.writes[0] as { customer_id: string }).customer_id).toBe("c-made");
  });
});
