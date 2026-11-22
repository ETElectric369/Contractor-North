import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ONE SALE, ONE DEPOSIT · THE PAPER'S WORD · A SENT ESTIMATE IS THE CUSTOMER'S COPY (cn-v1178, lane Q),
 * driven against a recording client that answers what a read ASKS (its table, its select list, its
 * filters): the sale's family comes from rpc("quote_family_ids") and a deposit request answers only when
 * its estimate is in the `in("quote_id", …)` list the read sent and it is not void. Nothing here mocks
 * the function that holds a rule (requireEditableQuote, liveRequestForQuote, readPrepaymentStates,
 * billingKindOfDocType, requestsAtAnEnding all run as written); only the job's two sync rules, the birth
 * and the paperwork doors are spies, as in one-editor-doors.test.ts.
 *
 *   Q4  a SENT estimate refuses every line door, the tax rate and the deposit, in one sentence naming
 *       Back to Draft; nothing is written.
 *   Q5  an ACCEPTED estimate whose sale's deposit request has money on it (less refunds) is locked; the
 *       one action is Revise. A refunded deposit locks nothing.
 *   Q6  setQuoteJob refuses, before anything moves, a sale whose deposit request is on another job, and
 *       an estimate and a job of two different customers.
 *   Q7  a job made from an estimate with no kind asked bills as the paper's word; a new estimate that
 *       states no word starts as the company's usual kind's; a standing one keeps its own.
 *   Q8  the catch-up branch writes the job's customer onto an estimate that has none (compare-and-set) and
 *       stamps its lead won.
 *   Q9  a won estimate marked Lost says what its job's requests still hold; nothing is voided.
 *   Q10 a fresh acceptance is compare-and-set: zero rows with the estimate accepted meanwhile is "already
 *       accepted", and who said yes is not written again.
 */
type Call = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; payload?: unknown; select?: string; filters: unknown[][] };
const s = vi.hoisted(() => ({ calls: [] as Call[], answer: null as null | ((c: Call) => unknown) }));

function builder(table: string) {
  const c: Call = { table, verb: "select", filters: [] };
  const run = () => s.answer?.(c) ?? { data: null, error: null };
  const b: any = {
    select: (cols?: string) => ((c.select = cols), b),
    insert: (p: unknown) => ((c.verb = "insert"), (c.payload = p), b),
    update: (p: unknown) => ((c.verb = "update"), (c.payload = p), b),
    delete: () => ((c.verb = "delete"), b),
    maybeSingle: async () => (s.calls.push(c), run()),
    single: async () => (s.calls.push(c), run()),
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (s.calls.push(c), Promise.resolve(run()).then(ok, err)),
  };
  for (const m of ["eq", "in", "is", "or", "order", "limit", "neq", "not"]) b[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), b);
  return b;
}
const client = {
  from: (t: string) => builder(t),
  rpc: async (fn: string, args: unknown) => {
    const c: Call = { table: fn, verb: "rpc", payload: args, filters: [] };
    s.calls.push(c);
    return s.answer?.(c) ?? { data: null, error: null };
  },
  auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}), orgStaffIds: vi.fn(async () => []) }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => {}) }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
const rules = vi.hoisted(() => ({
  estimateLines: vi.fn(async () => ({ lines: [], minutes: 0, taskMinutes: new Map(), partCounts: new Map() })),
  syncJobTasks: vi.fn(async () => ({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, sizeNow: null })),
  syncJobMaterials: vi.fn(async () => ({ inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] })),
  bornWithTasks: vi.fn(async () => ({ inserted: 0, plannedSet: false, birth: { tasks: [], plannedMinutes: null, parts: [] } })),
  createWorkOrderFromQuote: vi.fn(async () => ({ ok: true })),
  createMaterialListFromQuote: vi.fn(async () => ({ ok: true })),
  supersedeRevised: vi.fn(async () => ({ superseded: [] })),
  closeVisitsBehindQuote: vi.fn(async () => {}),
}));
vi.mock("@/lib/estimate/sync-job-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), estimateLines: rules.estimateLines, syncJobTasks: rules.syncJobTasks }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: rules.syncJobMaterials }));
vi.mock("@/lib/estimate/born-with-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), bornWithTasks: rules.bornWithTasks }));
vi.mock("@/lib/estimate/revision", async (importOriginal) => ({ ...(await importOriginal<object>()), supersedeRevised: rules.supersedeRevised }));
vi.mock("@/lib/appointments/behind-quote", async (importOriginal) => ({ ...(await importOriginal<object>()), closeVisitsBehindQuote: rules.closeVisitsBehindQuote }));
vi.mock("@/app/(app)/work-orders/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createWorkOrderFromQuote: rules.createWorkOrderFromQuote }));
vi.mock("@/app/(app)/materials/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createMaterialListFromQuote: rules.createMaterialListFromQuote }));

const { appendQuoteLines, updateQuoteItem, deleteQuoteItem, updateQuoteMeta, setQuoteDeposit, setQuoteJob, createJobFromQuote, updateQuoteStatus, saveQuote, deleteQuote } = await import("./actions");

const REF = "id, invoice_number, public_token, title, total, amount_paid, status, job_id, quote_id";
type Req = { id: string; quote_id: string; job_id: string; invoice_number: string; total: number; amount_paid: number; status: string; refunded?: number; created_at?: string };

/** The world the reads see. */
type World = {
  quote?: Record<string, unknown>;
  family?: string[];
  requests?: Req[];
  jobs?: Record<string, { id: string; name: string | null; job_number: string | null; customer_id: string | null }>;
  customers?: Record<string, string>;
  usual?: { tm: number; fixed: number };
  /** The rows a quotes update answers (compare-and-set): a function of the call. */
  quoteUpdate?: (c: Call) => unknown[];
  /** The status a re-read of the estimate sees. */
  statusNow?: string;
  /** Estimates of the company that revise another (deleteQuote's read), and a read that fails. */
  revisions?: { id: string; quote_number: string; revises_quote_id: string }[];
  /** The lead behind the estimate (lib/actions/win-customer reads it whole). */
  lead?: Record<string, unknown>;
  /** The rows a jobs update answers. */
  jobUpdate?: unknown[];
  deleteReadFails?: boolean;
};
const QUOTE = { id: "q1", status: "draft", job_id: null, quote_number: "E-900", doc_type: "estimate", org_id: "org-1", customer_id: null, inquiry_id: null };

function world(w: World) {
  const q = { ...QUOTE, ...(w.quote ?? {}) };
  return (c: Call): unknown => {
    if (c.verb === "rpc" && c.table === "quote_family_ids") return { data: w.family ?? [], error: null };
    if (c.table === "invoices" && c.verb === "select" && c.select === REF) {
      const list = (c.filters.find((f) => f[0] === "in" && f[1] === "quote_id")?.[2] as string[] | undefined) ?? [];
      const hit = (w.requests ?? []).find((r) => list.includes(r.quote_id) && r.status !== "void");
      return { data: hit ? { public_token: "t", title: "Deposit", ...hit } : null, error: null };
    }
    // deleteQuote's two reads: the live requests naming THIS estimate, and the estimates that revise it.
    if (c.table === "invoices" && c.verb === "select" && c.select === "id, invoice_number, status, invoice_kind, quote_id") {
      if (w.deleteReadFails) return { data: null, error: { message: "the reader tripped" } };
      const qid = c.filters.find((f) => f[0] === "eq" && f[1] === "quote_id")?.[2];
      const kind = c.filters.find((f) => f[0] === "eq" && f[1] === "invoice_kind")?.[2];
      return { data: (w.requests ?? []).filter((r) => r.quote_id === qid && kind === "prepayment" && r.status !== "void").map((r) => ({ ...r, invoice_kind: "prepayment" })), error: null };
    }
    if (c.table === "quotes" && c.verb === "select" && c.select === "id, quote_number, revises_quote_id") {
      const of = c.filters.find((f) => f[0] === "eq" && f[1] === "revises_quote_id")?.[2];
      return { data: (w.revisions ?? []).filter((r) => r.revises_quote_id === of), error: null };
    }
    if (c.table === "quotes" && c.verb === "delete") return { data: null, error: null };
    if (c.table === "inquiries" && c.verb === "select" && c.select === "*") return { data: w.lead ?? null, error: null };
    if (c.table === "jobs" && c.verb === "update") return { data: w.jobUpdate ?? [{ id: "j1" }], error: null };
    // readPrepaymentStates: the job's requests, their own lines, their refunds, the credit lines on other bills.
    if (c.table === "invoices" && c.verb === "select" && c.select === "id, invoice_number, status, title, created_at, amount_paid") {
      const job = c.filters.find((f) => f[0] === "eq" && f[1] === "job_id")?.[2];
      return { data: (w.requests ?? []).filter((r) => r.job_id === job).map((r) => ({ id: r.id, invoice_number: r.invoice_number, status: r.status, title: "Deposit", created_at: r.created_at ?? "2026-11-20T00:00:00Z", amount_paid: r.amount_paid })), error: null };
    }
    if (c.table === "invoice_items" && c.verb === "select" && c.select === "invoice_id, line_total") {
      const ids = (c.filters.find((f) => f[0] === "in")?.[2] as string[]) ?? [];
      return { data: (w.requests ?? []).filter((r) => ids.includes(r.id)).map((r) => ({ invoice_id: r.id, line_total: r.total })), error: null };
    }
    if (c.table === "customer_credits" && c.verb === "select") {
      const ids = (c.filters.find((f) => f[0] === "in")?.[2] as string[]) ?? [];
      return { data: (w.requests ?? []).filter((r) => ids.includes(r.id) && r.refunded).map((r) => ({ invoice_id: r.id, amount: -(r.refunded as number) })), error: null };
    }
    if (c.table === "invoice_items" && c.verb === "select") return { data: [], error: null };
    // the estimate
    if (c.table === "quotes" && c.verb === "select" && c.select === "status") return { data: { status: w.statusNow ?? q.status }, error: null };
    if (c.table === "quotes" && c.verb === "select") return { data: q, error: null };
    if (c.table === "quotes" && c.verb === "update") return { data: w.quoteUpdate ? w.quoteUpdate(c) : [{ id: "q1" }], error: null };
    if (c.table === "quotes" && c.verb === "insert") return { data: { id: "q-new", quote_number: "E-901" }, error: null };
    if (c.table === "jobs" && c.verb === "select" && c.select === "id" && c.filters.some((f) => f[0] === "eq" && f[1] === "billing_type")) {
      const kind = c.filters.find((f) => f[1] === "billing_type")?.[2] as "tm" | "fixed";
      return { data: null, count: w.usual?.[kind] ?? 0, error: null };
    }
    if (c.table === "jobs" && c.verb === "select") {
      const id = c.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2] as string;
      return { data: w.jobs?.[id] ?? null, error: null };
    }
    if (c.table === "jobs" && c.verb === "insert") return { data: { id: "j-new" }, error: null };
    if (c.table === "customers" && c.verb === "select" && c.select === "id, name, company_name") {
      const ids = (c.filters.find((f) => f[0] === "in")?.[2] as string[]) ?? [];
      return { data: ids.map((id) => ({ id, name: w.customers?.[id] ?? null, company_name: null })), error: null };
    }
    if (c.table === "inquiries" && c.verb === "update") return { data: [{ id: "lead-1" }], error: null };
    if (c.table === "quote_line_items" && c.verb === "select") return { data: [], error: null };
    if (c.table === "quote_line_items" && (c.verb === "update" || c.verb === "delete")) return { data: [{ id: "l1" }], error: null };
    if (c.table === "quote_line_items" && c.verb === "insert") return { data: (c.payload as unknown[]).map((_, i) => ({ id: `l-${i}` })), error: null };
    if (c.verb === "rpc" && c.table === "save_quote_draft") return { data: [{ id: (c.payload as { p_id: string }).p_id, quote_number: "E-900" }], error: null };
    return { data: null, error: null };
  };
}

const lineWrites = () => s.calls.filter((c) => c.table === "quote_line_items" && c.verb !== "select");
const SENT = "E-900 was sent: it is the customer's copy, so its lines, totals and deposit don't change while it is out. Tap Back to Draft to change it, then send it again.";
const LINE = "a0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  s.calls = [];
  s.answer = world({});
  for (const spy of Object.values(rules)) spy.mockClear();
});

describe("Q4 · a sent estimate is the customer's copy", () => {
  it("every line door, the tax rate and the deposit refuse it in one sentence naming Back to Draft; nothing is written", async () => {
    s.answer = world({ quote: { status: "sent" } });
    expect(await appendQuoteLines("q1", [{ id: LINE, description: "Larkspur outlet", quantity: 1, unit: "ea", unit_price: 90 } as never])).toEqual({ ok: false, error: SENT });
    expect(await updateQuoteItem("l1", "q1", { unit_price: 120 })).toEqual({ ok: false, error: SENT });
    expect(await deleteQuoteItem("l1", "q1")).toEqual({ ok: false, error: SENT });
    expect(await updateQuoteMeta("q1", { tax_rate: 0.08 })).toEqual({ ok: false, error: SENT });
    expect(await setQuoteDeposit("q1", 200)).toEqual({ ok: false, error: SENT });
    expect(lineWrites()).toEqual([]);
    expect(s.calls.filter((c) => c.table === "quotes" && c.verb === "update")).toEqual([]);
  });

  it("a draft takes the same line (the rule is the status, nothing else)", async () => {
    expect(await updateQuoteItem("l1", "q1", { unit_price: 120 })).toEqual({ ok: true });
    expect(lineWrites()).toHaveLength(1);
  });
});

describe("Q5 · a paid deposit locks the accepted estimate it was paid against", () => {
  const LOCKED = "E-900 is accepted and its deposit, INV-900, has $480.00 paid on it — changing it now would change the price the customer paid against. Revise it instead.";
  it("the sale's request (on the ORIGINAL of this revision) with money on it locks; nothing is written", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j1" }, family: ["q1", "q0"], requests: [{ id: "inv-900", quote_id: "q0", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 480, status: "paid" }] });
    expect(await updateQuoteItem("l1", "q1", { unit_price: 120 })).toEqual({ ok: false, error: LOCKED });
    expect(lineWrites()).toEqual([]);
  });

  it("partly paid locks for what was paid; refunded in full, or unpaid, or another sale's, locks nothing", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j1" }, family: ["q1"], requests: [{ id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 200, status: "partial" }] });
    expect((await updateQuoteItem("l1", "q1", { unit_price: 120 })).error).toContain("has $200.00 paid on it");
    for (const r of [
      { id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 480, status: "paid", refunded: 480 },
      { id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 0, status: "sent" },
      { id: "inv-901", quote_id: "q-other-sale", job_id: "j1", invoice_number: "INV-901", total: 480, amount_paid: 480, status: "paid" },
    ]) {
      s.calls = [];
      s.answer = world({ quote: { status: "accepted", job_id: "j1" }, family: ["q1"], requests: [r] });
      expect(await updateQuoteItem("l1", "q1", { unit_price: 120 })).toEqual({ ok: true });
    }
  });

  it("skeptic S9: a SUPERSEDED estimate with no revision standing is still locked by the sale's paid deposit; one with nothing paid is editable", async () => {
    s.answer = world({ quote: { status: "superseded", job_id: "j1" }, family: ["q1"], requests: [{ id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 480, status: "paid" }] });
    expect(await updateQuoteItem("l1", "q1", { unit_price: 120 })).toEqual({
      ok: false,
      error: "E-900's sale has its deposit, INV-900, with $480.00 paid on it — changing it now would change the price the customer paid against. Revise it instead.",
    });
    expect(lineWrites()).toEqual([]);
    s.calls = [];
    s.answer = world({ quote: { status: "superseded", job_id: "j1" }, family: ["q1"], requests: [{ id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 0, status: "sent" }] });
    expect(await updateQuoteItem("l1", "q1", { unit_price: 120 })).toEqual({ ok: true });
  });

  it("a family read that fails is said, never read as no deposit", async () => {
    const w = world({ quote: { status: "accepted", job_id: "j1" } });
    s.answer = (c) => (c.verb === "rpc" ? { data: null, error: { message: "function public.quote_family_ids does not exist" } } : w(c));
    const res = await updateQuoteItem("l1", "q1", { unit_price: 120 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Couldn't check this sale's deposit request, so nothing was changed");
    expect(lineWrites()).toEqual([]);
  });
});

describe("Q6 · setQuoteJob moves nothing the sale's deposit or customer disagrees with", () => {
  const jobs = {
    "j-old": { id: "j-old", name: "Larkspur job", job_number: "J-900", customer_id: "c1" },
    "j-new": { id: "j-new", name: "Snowbell job", job_number: "J-901", customer_id: "c1" },
    "j-other": { id: "j-other", name: "Snowbell job", job_number: "J-902", customer_id: "c2" },
  };
  const moves = () => s.calls.filter((c) => c.verb === "update" && ["quotes", "work_orders", "material_lists"].includes(c.table));

  it("a deposit request on another job refuses, naming the request and that job; nothing moves", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j-old", customer_id: "c1" }, jobs, family: ["q1"], requests: [{ id: "inv-900", quote_id: "q1", job_id: "j-old", invoice_number: "INV-900", total: 480, amount_paid: 480, status: "paid" }] });
    expect(await setQuoteJob("q1", "j-new")).toEqual({ ok: false, error: "E-900's deposit request, INV-900, is on Larkspur job. Keep the estimate there, or void the request first. Nothing was moved." });
    expect(moves()).toEqual([]);
  });

  it("two customers refuse, naming both; nothing moves", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: null, customer_id: "c1" }, jobs, customers: { c1: "Sam Tillery", c2: "Dana Rook" } });
    const res = await setQuoteJob("q1", "j-other");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("E-900 is for Sam Tillery");
    expect(res.error).toContain("is for Dana Rook");
    expect(moves()).toEqual([]);
  });

  it("the same customer and the request on the target job: it moves", async () => {
    s.answer = world({ quote: { status: "sent", job_id: "j-old", customer_id: "c1" }, jobs, family: ["q1"], requests: [{ id: "inv-900", quote_id: "q1", job_id: "j-new", invoice_number: "INV-900", total: 480, amount_paid: 0, status: "sent" }] });
    expect((await setQuoteJob("q1", "j-new")).ok).toBe(true);
    expect(s.calls.some((c) => c.table === "quotes" && c.verb === "update" && (c.payload as { job_id?: string }).job_id === "j-new")).toBe(true);
  });
});

describe("Q7 · the paper's word decides how the job bills", () => {
  const born = () => (s.calls.find((c) => c.table === "jobs" && c.verb === "insert")?.payload as { billing_type?: string } | undefined)?.billing_type;
  it("a Quote makes a Fixed Price job and an Estimate a Time and Material one, whatever the company usually does", async () => {
    s.answer = world({ quote: { status: "accepted", doc_type: "quote", customer_id: "c1" }, usual: { tm: 9, fixed: 1 }, quoteUpdate: () => [{ id: "q1" }] });
    await createJobFromQuote("q1");
    expect(born()).toBe("fixed");
    s.calls = [];
    s.answer = world({ quote: { status: "accepted", doc_type: "estimate", customer_id: "c1" }, usual: { tm: 1, fixed: 9 } });
    await createJobFromQuote("q1");
    expect(born()).toBe("tm");
  });

  it("a kind the Won sheet asked for still rides (the sheet itself now sends the paper's word for an estimate that stands)", async () => {
    s.answer = world({ quote: { status: "accepted", doc_type: "estimate", customer_id: "c1" } });
    await createJobFromQuote("q1", undefined, "fixed");
    expect(born()).toBe("fixed");
  });

  it("a NEW estimate that states no word starts as the company's usual kind's; a standing one keeps its own", async () => {
    const insertWord = () => (s.calls.find((c) => c.table === "quotes" && c.verb === "insert")?.payload as { doc_type?: string } | undefined)?.doc_type;
    const base = world({ usual: { tm: 1, fixed: 5 } });
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id, doc_type" ? { data: null, error: null } : base(c));
    await saveQuote({ id: null, customer_id: null, title: "Snowbell panel", notes: "", tax_rate: 0, valid_until: null, items: [] });
    expect(insertWord()).toBe("quote");
    s.calls = [];
    const tm = world({ usual: { tm: 4, fixed: 1 } });
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id, doc_type" ? { data: null, error: null } : tm(c));
    await saveQuote({ id: null, customer_id: null, title: "Snowbell panel", notes: "", tax_rate: 0, valid_until: null, items: [] });
    expect(insertWord()).toBe("estimate");
    // A standing draft with no word sent keeps the Quote it is (the draft RPC is handed it).
    s.calls = [];
    const standing = world({ usual: { tm: 9, fixed: 0 } });
    s.answer = (c) => (c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id, doc_type" ? { data: { id: LINE, status: "draft", inquiry_id: null, doc_type: "quote" }, error: null } : standing(c));
    await saveQuote({ id: LINE, customer_id: null, title: "Snowbell panel", notes: "", tax_rate: 0, valid_until: null, items: [{ description: "Panel", quantity: 1, unit: "ea", unit_price: 900 }] });
    const rpc = s.calls.find((c) => c.verb === "rpc" && c.table === "save_quote_draft")!;
    expect((rpc.payload as { p_fields: { doc_type: string } }).p_fields.doc_type).toBe("quote");
  });
});

describe("Q8 · the catch-up branch gives the estimate its job's customer and wins its lead", () => {
  it("an accepted estimate with no customer on a job that has one: compare-and-set, read back; the lead is stamped won", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j1", customer_id: null, inquiry_id: "lead-1" }, jobs: { j1: { id: "j1", name: "Larkspur job", job_number: "J-900", customer_id: "c1" } } });
    const res = await createJobFromQuote("q1");
    expect(res.ok).toBe(true);
    const cas = s.calls.find((c) => c.table === "quotes" && c.verb === "update" && (c.payload as { customer_id?: string }).customer_id === "c1")!;
    expect(cas.filters).toEqual([["eq", "id", "q1"], ["is", "customer_id", null]]);
    expect(cas.select).toBe("id");
    const won = s.calls.find((c) => c.table === "inquiries" && c.verb === "update" && (c.payload as { status?: string }).status === "won")!;
    expect(won.filters).toEqual([["eq", "id", "lead-1"], ["neq", "status", "won"]]);
    expect(s.calls.some((c) => c.table === "inquiries" && c.verb === "update" && (c.payload as { customer_id?: string }).customer_id === "c1")).toBe(true);
  });

  it("skeptic S7: no customer on the estimate nor on its job: the lead's customer goes on the estimate AND the job, compare-and-set, read back", async () => {
    s.answer = world({
      quote: { status: "accepted", job_id: "j1", customer_id: null, inquiry_id: "lead-1" },
      jobs: { j1: { id: "j1", name: "Larkspur job", job_number: "J-900", customer_id: null } },
      lead: { id: "lead-1", customer_id: "c5", status: "won", converted_at: "2026-11-01T00:00:00Z" },
    });
    expect((await createJobFromQuote("q1")).ok).toBe(true);
    expect(s.calls.some((c) => c.table === "quotes" && c.verb === "update" && (c.payload as { customer_id?: string }).customer_id === "c5")).toBe(true);
    const job = s.calls.find((c) => c.table === "jobs" && c.verb === "update" && (c.payload as { customer_id?: string }).customer_id === "c5")!;
    expect(job.payload).toEqual({ customer_id: "c5" });
    expect(job.filters).toEqual([["eq", "id", "j1"], ["is", "customer_id", null]]);
    expect(job.select).toBe("id");
  });

  it("a job that has a customer is never given another by the catch-up", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j1", customer_id: null, inquiry_id: "lead-1" }, jobs: { j1: { id: "j1", name: "Larkspur job", job_number: "J-900", customer_id: "c1" } }, lead: { id: "lead-1", customer_id: "c5" } });
    await createJobFromQuote("q1");
    expect(s.calls.some((c) => c.table === "jobs" && c.verb === "update" && "customer_id" in (c.payload as object))).toBe(false);
  });

  it("an estimate that already has its customer is never re-pointed", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j1", customer_id: "c9", inquiry_id: null }, jobs: { j1: { id: "j1", name: "Larkspur job", job_number: "J-900", customer_id: "c1" } } });
    await createJobFromQuote("q1");
    expect(s.calls.some((c) => c.table === "quotes" && c.verb === "update" && "customer_id" in (c.payload as object))).toBe(false);
  });
});

describe("Q9 · a won estimate marked Lost says what its job's requests hold, and voids nothing", () => {
  it("an open request and money paid ahead are each said with their one action", async () => {
    s.answer = world({
      quote: { status: "accepted", job_id: "j1" },
      requests: [
        { id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 0, status: "sent", created_at: "2026-11-01T00:00:00Z" },
        { id: "inv-901", quote_id: "q1", job_id: "j1", invoice_number: "INV-901", total: 300, amount_paid: 300, status: "paid", created_at: "2026-11-02T00:00:00Z" },
      ],
    });
    const res = await updateQuoteStatus("q1", "declined");
    expect(res).toMatchObject({
      ok: true,
      warning:
        "INV-900 still asks for $480.00 and its link still takes a card: void it on the job if it is no longer owed. INV-901 holds $300.00 paid ahead that no bill has used: refund it, or bill the work that was done.",
    });
    expect(s.calls.some((c) => c.table === "invoices" && c.verb !== "select")).toBe(false);
  });

  it("skeptic S6: a partly paid request is said once, naming refund-then-void (its void door refuses it while money is on it)", async () => {
    s.answer = world({
      quote: { status: "accepted", job_id: "j1" },
      requests: [{ id: "inv-900", quote_id: "q1", job_id: "j1", invoice_number: "INV-900", total: 480, amount_paid: 200, status: "partial", created_at: "2026-11-01T00:00:00Z" }],
    });
    const res = await updateQuoteStatus("q1", "declined");
    expect(res).toMatchObject({
      ok: true,
      warning: "INV-900 still asks for $280.00 and its link still takes a card, and $200.00 was paid on it: if it is no longer owed, refund what was paid, then void it on the job.",
    });
    expect(s.calls.some((c) => c.table === "invoices" && c.verb !== "select")).toBe(false);
  });

  it("a sale with no requests says nothing more", async () => {
    s.answer = world({ quote: { status: "accepted", job_id: "j1" } });
    const res = await updateQuoteStatus("q1", "declined");
    expect(res).toEqual({ ok: true });
  });
});

describe("Q10 · a fresh acceptance is compare-and-set", () => {
  const acceptWrite = (c: Call) => c.table === "quotes" && c.verb === "update" && (c.payload as { status?: string }).status === "accepted";
  it("the write lands only while the estimate is not accepted, and records who said yes", async () => {
    s.answer = world({ quote: { status: "sent", customer_id: "c1" } });
    await updateQuoteStatus("q1", "accepted");
    const w = s.calls.find(acceptWrite)!;
    expect(w.filters).toEqual([["eq", "id", "q1"], ["neq", "status", "accepted"]]);
    expect(w.payload).toMatchObject({ accepted_how: "office", accepted_by: "office-1" });
  });

  it("zero rows with the estimate accepted meanwhile (the customer's link): already accepted; nothing rewritten, nobody rung twice", async () => {
    const { createNotifications } = await import("@/lib/notifications");
    vi.mocked(createNotifications).mockClear();
    s.answer = world({ quote: { status: "sent", customer_id: "c1" }, quoteUpdate: (c) => (acceptWrite(c) ? [] : [{ id: "q1" }]), statusNow: "accepted" });
    const res = await updateQuoteStatus("q1", "accepted");
    expect(res.ok).toBe(true);
    expect(s.calls.filter(acceptWrite)).toHaveLength(1);
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("zero rows with the estimate NOT accepted is not found, said", async () => {
    s.answer = world({ quote: { status: "sent" }, quoteUpdate: (c) => (acceptWrite(c) ? [] : [{ id: "q1" }]), statusNow: "sent" });
    expect(await updateQuoteStatus("q1", "accepted")).toEqual({ ok: false, error: "That estimate could not be found." });
  });
});

describe("Q7 · the new-estimate page seeds the word (source pin: the page is a server component with many reads)", () => {
  it("the unsaved editor is handed the company's usual kind's word", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(`${process.cwd()}/src/app/(app)/quotes/new/page.tsx`, "utf8");
    expect(page).toContain("docType: docTypeOfBillingKind(await readUsualBillingKind(supabase)),");
  });
});

/**
 * SKEPTIC S3 · deleting an estimate never undoes one sale, one deposit. invoices.quote_id and
 * quotes.revises_quote_id are ON DELETE SET NULL, so the delete itself would cut the request (or the
 * revision) off the sale; deleteQuote refuses BEFORE anything is deleted, in one sentence with one action.
 */
describe("S3 · deleteQuote keeps the sale's deposit attached", () => {
  const deleted = () => s.calls.filter((c) => c.table === "quotes" && c.verb === "delete");
  const req: Req = { id: "inv-900", quote_id: "q1", job_id: "job-1", invoice_number: "INV-900", total: 480, amount_paid: 0, status: "sent" };

  it("a live payment request names this estimate: refused, naming it (void it first); nothing deleted", async () => {
    s.answer = world({ requests: [req] });
    expect(await deleteQuote("q1")).toEqual({ ok: false, error: "This estimate has a payment request, INV-900: void it first, then delete the estimate." });
    expect(deleted()).toEqual([]);
    // The read names the company and the kind.
    const read = s.calls.find((c) => c.table === "invoices" && c.select === "id, invoice_number, status, invoice_kind, quote_id")!;
    expect(read.filters).toEqual(expect.arrayContaining([["eq", "org_id", "org-1"], ["eq", "quote_id", "q1"], ["eq", "invoice_kind", "prepayment"], ["neq", "status", "void"]]));
  });

  it("a VOID request does not hold it: the estimate is deleted", async () => {
    s.answer = world({ requests: [{ ...req, status: "void" }] });
    expect(await deleteQuote("q1")).toEqual({ ok: true });
    expect(deleted()).toHaveLength(1);
  });

  it("another estimate revises this one and the sale has a live deposit request: refused, naming the revision and the request", async () => {
    s.answer = world({
      family: ["q1", "q2"],
      revisions: [{ id: "q2", quote_number: "E-901", revises_quote_id: "q1" }],
      requests: [{ ...req, quote_id: "q2" }],
    });
    expect(await deleteQuote("q1")).toEqual({ ok: false, error: "This estimate is revised by E-901, and the sale's deposit request is INV-900: delete E-901 first, or keep this one." });
    expect(deleted()).toEqual([]);
  });

  it("a revision with no deposit request in the sale: the estimate is deleted", async () => {
    s.answer = world({ family: ["q1", "q2"], revisions: [{ id: "q2", quote_number: "E-901", revises_quote_id: "q1" }] });
    expect(await deleteQuote("q1")).toEqual({ ok: true });
    expect(deleted()).toHaveLength(1);
  });

  it("a read that fails refuses and says so; nothing deleted", async () => {
    s.answer = world({ deleteReadFails: true });
    expect(await deleteQuote("q1")).toEqual({ ok: false, error: "This estimate's payment requests couldn't be read, so nothing was deleted: try again." });
    expect(deleted()).toEqual([]);
  });
});
