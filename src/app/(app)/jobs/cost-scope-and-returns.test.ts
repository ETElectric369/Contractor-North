import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A TYPED COST ANSWERS THE SAME TWO QUESTIONS A SNAPPED ONE DOES (items C1, C2, C3).
 *
 * C1: only the receipt reader ever wrote `bills.scope_category`, so the same $900 of decking landed
 *     in Decking when it was snapped and in Uncategorized when it was typed, filed from the tray or
 *     recorded by Nort — and no screen could set it afterwards.
 * C2: the lineless-return rule was on the paper door only. Typing a credit with no lines straight
 *     onto a job, and re-pointing a bank credit onto a job in the Edit Bill box, both walked past it
 *     into the INV-078 housings failure (the whole credit at markup, for parts nobody was charged).
 * C3: a receipt filed from Add Cost was not stamped "the job owns this photo", so Undo and Delete
 *     only spared it because the upload happened to land before the link row.
 */

const state = vi.hoisted(() => ({
  client: null as any,
  /** Every write this test's fake saw: table, verb, payload. */
  wrote: [] as { table: string; verb: string; payload: any }[],
  /** The stored bill updateBill reads before it writes. */
  stored: null as { job_id: string | null; amount: number; scope_category?: string | null } | null,
  /** The lines the stored bill carries (the guard's second half). */
  storedLines: [] as { description: string }[],
  /** What the job's estimate is broken into. */
  scopes: [] as string[],
  /** A job id the RLS-scoped read can see (visibleJobIdOrNull). */
  visibleJobs: ["job-1", "job-2"] as string[],
  /** The receipt document Add Cost attaches, when a test sets one. */
  doc: null as { id: string; job_id: string | null; file_url: string } | null,
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/stock-ledger", async (orig) => ({
  ...(await orig<typeof import("@/lib/stock-ledger")>()),
  restampLotsForBill: vi.fn(async () => ({ ok: true, restamped: 0, unshelved: 0 })),
}));
vi.mock("@/lib/analytics/job-profitability", async (orig) => ({
  ...(await orig<typeof import("@/lib/analytics/job-profitability")>()),
  listJobScopes: vi.fn(async () => state.scopes),
}));

const { createBill, updateBill } = await import("./actions");

/** A PostgREST-shaped fake: every insert/update is recorded, every read answered from `state`. */
function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      let verb = "select";
      let payload: any = null;
      const answer = () => {
        if (verb === "insert") {
          state.wrote.push({ table, verb, payload });
          if (table === "bills") return { data: { id: "bill-new" }, error: null };
          return { data: [{ id: `${table}-new` }], error: null };
        }
        if (verb === "update") {
          state.wrote.push({ table, verb, payload });
          const jid = payload && "job_id" in payload ? payload.job_id : (state.stored?.job_id ?? null);
          return { data: { id: "bill-1", job_id: jid }, error: null };
        }
        // Reads.
        if (table === "jobs") return { data: state.visibleJobs.length ? { id: state.visibleJobs[0] } : null, error: null };
        if (table === "bills") return { data: state.stored, error: null };
        if (table === "bill_line_items") return { data: state.storedLines, error: null };
        if (table === "documents") return { data: state.doc, error: null };
        if (table === "supplier_aliases" || table === "supplier_accounts") return { data: [], error: null };
        if (table === "invoice_items") return { data: [], error: null };
        return { data: null, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          if (table === "jobs" && col === "id") state.visibleJobs = state.visibleJobs.filter((j) => j === v);
          return chain;
        },
        neq: () => chain,
        is: () => chain,
        in: () => chain,
        or: () => chain,
        contains: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: (p: any) => ((verb = "insert"), (payload = p), chain),
        update: (p: any) => ((verb = "update"), (payload = p), chain),
        delete: () => ((verb = "delete"), chain),
        single: async () => answer(),
        maybeSingle: async () => answer(),
        then: (res: any) => Promise.resolve(answer()).then(res),
      };
      return chain;
    },
  };
}

const wroteTo = (table: string, verb: string) => state.wrote.find((w) => w.table === table && w.verb === verb);

const TYPED = {
  job_id: "job-1",
  supplier: "A Lumber Yard",
  bill_number: "",
  amount: 900,
  status: "paid",
  bill_date: "2026-10-01",
  notes: "",
  category: "Materials",
};

beforeEach(() => {
  state.wrote = [];
  state.stored = null;
  state.storedLines = [];
  state.scopes = [];
  state.visibleJobs = ["job-1", "job-2"];
  state.doc = null;
  state.client = client();
});

describe("C1: a typed cost says which part of the job it is", () => {
  it("a scope the job's estimate really has is stored on the bill", async () => {
    state.scopes = ["Framing", "Decking"];
    const res = await createBill({ ...TYPED, scope: { kind: "scope", scope: "Decking" } });
    expect(res.ok).toBe(true);
    expect(wroteTo("bills", "insert")!.payload.scope_category).toBe("Decking");
  });

  it("a scope that is not one of the job's parts is refused in words, and nothing is written", async () => {
    state.scopes = ["Framing", "Decking"];
    const res = await createBill({ ...TYPED, scope: { kind: "scope", scope: "Plumbing" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Plumbing/);
    expect(res.error).toMatch(/Framing/);
    expect(wroteTo("bills", "insert")).toBeUndefined();
  });

  it("a door that could not ask leaves it unset rather than guessing", async () => {
    state.scopes = ["Framing"];
    const res = await createBill({ ...TYPED, scope: { kind: "notAsked" } });
    expect(res.ok).toBe(true);
    expect(wroteTo("bills", "insert")!.payload.scope_category).toBeNull();
  });

  it("a business cost has no part of a job, and saying it has one is refused", async () => {
    const ok = await createBill({ ...TYPED, job_id: null, category: "Fuel", scope: { kind: "noJob" } });
    expect(ok.ok).toBe(true);
    expect(wroteTo("bills", "insert")!.payload.scope_category).toBeNull();
    state.wrote = [];
    state.client = client();
    const no = await createBill({ ...TYPED, job_id: null, category: "Fuel", scope: { kind: "scope", scope: "Framing" } });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/business cost/i);
    expect(wroteTo("bills", "insert")).toBeUndefined();
  });

  it("a person can set the part of the job on a cost that already exists", async () => {
    state.scopes = ["Framing", "Decking"];
    state.stored = { job_id: "job-1", amount: 900 };
    expect(await updateBill("bill-1", { scope: { kind: "scope", scope: "Framing" } })).toEqual({ ok: true });
    expect(wroteTo("bills", "update")!.payload.scope_category).toBe("Framing");
  });

  it("and can take it back off", async () => {
    state.scopes = ["Framing"];
    state.stored = { job_id: "job-1", amount: 900 };
    expect(await updateBill("bill-1", { scope: { kind: "none" } })).toEqual({ ok: true });
    expect(wroteTo("bills", "update")!.payload.scope_category).toBeNull();
  });

  // NO DEAD ENDS: the estimate lost its Framing lines after this receipt was filed under Framing. The
  // Edit Bill box has to stay able to save the cost, or a typo in the supplier can never be fixed.
  it("saving a cost with the part it already carries works even when the estimate has lost it", async () => {
    state.scopes = ["Decking"];
    state.stored = { job_id: "job-1", amount: 900, scope_category: "Framing" };
    const res = await updateBill("bill-1", { supplier: "A Lumber Yard", scope: { kind: "scope", scope: "Framing" } });
    expect(res.ok).toBe(true);
    expect(wroteTo("bills", "update")!.payload.scope_category).toBe("Framing");
  });

  it("moving a cost to a job whose estimate has no such part clears it, and says so", async () => {
    state.scopes = ["Siding"]; // the job it is moving TO
    state.stored = { job_id: "job-1", amount: 900, scope_category: "Framing" };
    const res = await updateBill("bill-1", { job_id: "job-2" });
    expect(res.ok).toBe(true);
    expect(wroteTo("bills", "update")!.payload.scope_category).toBeNull();
    expect(res.warning ?? "").toMatch(/part of the job/i);
  });
});

describe("C2: a return with no lines cannot be put on a job by any door", () => {
  it("typing a credit with no lines onto a job is refused in plain words", async () => {
    const res = await createBill({ ...TYPED, amount: -51.58, scope: { kind: "notAsked" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credit the customer the whole amount/i);
    expect(wroteTo("bills", "insert")).toBeUndefined();
  });

  it("the company's own book is not held to it (a business cost never reaches a customer)", async () => {
    const res = await createBill({ ...TYPED, job_id: null, amount: -51.58, category: "Fuel", scope: { kind: "noJob" } });
    expect(res.ok).toBe(true);
    expect(wroteTo("bills", "insert")!.payload.amount).toBe(-51.58);
  });

  it("re-pointing a bank credit onto a job in the Edit Bill box is refused, and nothing is written", async () => {
    state.stored = { job_id: null, amount: -51.58 };
    state.storedLines = [];
    const res = await updateBill("bill-1", { job_id: "job-2" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credit the customer the whole amount/i);
    expect(wroteTo("bills", "update")).toBeUndefined();
  });

  it("a credit with lines under it moves onto a job as before", async () => {
    state.stored = { job_id: null, amount: -51.58 };
    state.storedLines = [{ description: "H245ICAT 4 in LED Shallow IC HSG" }];
    expect((await updateBill("bill-1", { job_id: "job-2" })).ok).toBe(true);
    expect(wroteTo("bills", "update")!.payload.job_id).toBe("job-2");
  });

  it("turning a job's bill negative in the Edit Bill box is refused when it has no lines", async () => {
    state.stored = { job_id: "job-1", amount: 51.58 };
    state.storedLines = [];
    const res = await updateBill("bill-1", { amount: -51.58 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credit the customer the whole amount/i);
    expect(wroteTo("bills", "update")).toBeUndefined();
  });
});

describe("C3: a receipt filed from Add Cost is stamped the job's own", () => {
  it("the link row says the job owns the photo, so Undo and Delete never take it off the job", async () => {
    state.doc = { id: "doc-1", job_id: "job-1", file_url: "org-1/job-1/r.jpg" };
    const res = await createBill({ ...TYPED, receipt_document_id: "doc-1", scope: { kind: "notAsked" } });
    expect(res.ok).toBe(true);
    expect(wroteTo("organized_items", "insert")!.payload.source).toBe("job");
  });
});
