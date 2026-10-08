import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { owedByCustomer, owedByLateness, type PipelineInvoice } from "@/lib/billing-pipeline";

/**
 * ONE INVOICES PAGE (W1-29): who owes you, and what came in. Renders THE PAGE ITSELF against a fake
 * database (made-up customers and figures), and pins what moved:
 *   · the three tiles are gone: one Owed To You figure (the pipeline's outstanding), what of it is
 *     late in red, and one thin bar; $0 owed reads "Owed To You $0" with no bar;
 *   · the To Invoice dollars moved onto the Done - Not Invoiced header, never vanished;
 *   · no all-time figure (Analytics owns lifetime money), and no link to /payments;
 *   · Accounts Receivable folded in: "N Days Late" on late rows, and By Customer · N (closed, opened
 *     by ?open=customers, the old /billing/ar);
 *   · Payments In is a LINK with "$X This Month" from its own small read; the ledger is read only
 *     with ?open=payments, and Get Paid… sits with it.
 */

const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  selects: [] as { table: string; cols: string }[],
  role: "owner" as string,
  redirected: null as string | null,
}));

function chain(table: string) {
  const c: Record<string, unknown> = {};
  let cols = "";
  const rows = () => state.tables[table] ?? [];
  c.select = (s?: string) => {
    cols = s ?? "";
    state.selects.push({ table, cols });
    return c;
  };
  for (const m of ["eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "lt", "filter", "range"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
  c.single = c.maybeSingle;
  c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok, err);
  return c;
}
const fake = {
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  from: (t: string) => {
    if (t === "profiles") state.tables.profiles = [{ role: state.role, org_id: "org-1", active: true, organizations: { settings: { timezone: "America/Los_Angeles" } } }];
    return chain(t);
  },
  rpc: async () => ({ data: null, error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    state.redirected = to;
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/billing",
  useSearchParams: () => new URLSearchParams(),
}));
// The page's own client doors, drawn as markers: this is about what the page hands them.
vi.mock("./new-invoice-button", () => ({ NewInvoiceButton: () => createElement("button", null, "New Invoice") }));
vi.mock("./invoice-job-button", () => ({ InvoiceJobButton: ({ label }: { label?: string }) => createElement("button", null, label ?? "Bill It") }));
// THE ONE FUNCTION behind Waiting To Be Billed, answered per job here: job-1's oldest work is newer
// than job-2's, so job-2 lists first.
vi.mock("@/lib/unbilled-work", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/unbilled-work")>()),
  unbilledWorkForJob: vi.fn(async (_sb: unknown, jobId: string) => ({
    schemaReady: true,
    hours: jobId === "job-1" ? 3.5 : 12,
    billsCount: 1,
    stockCount: 0,
    billsBilled: jobId === "job-1" ? 120 : 80,
    stockBilled: 0,
    total: jobId === "job-1" ? 500 : 1400,
    oldestAt: jobId === "job-1" ? "2026-09-20T15:00:00Z" : "2026-09-02",
  })),
}));
vi.mock("./record-payment-button", () => ({
  GetPaidPickButton: ({ invoices }: { invoices: unknown[] }) => createElement("button", { "data-get-paid": invoices.length }, "Get Paid…"),
}));

const inv = (id: string, over: Record<string, unknown>) => ({
  id,
  invoice_number: id.toUpperCase(),
  total: 0,
  amount_paid: 0,
  status: "sent",
  due_date: null,
  job_id: null,
  customer_id: null,
  customers: null,
  jobs: null,
  ...over,
});
const OWING = {
  organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles", payment_methods: ["Check", "Cash"] }, stripe_account_id: null, stripe_account_status: null, stripe_charges_enabled: false }],
  invoices: [
    // 26 days late, Pat.
    inv("inv-1", { total: 1000, due_date: "2026-09-01", customer_id: "c-pat", customers: { name: "Pat Lee" }, job_id: "job-1" }),
    // Partly paid, not due yet, Sam.
    inv("inv-2", { total: 500, amount_paid: 200, status: "partial", due_date: "2026-10-15", customer_id: "c-sam", customers: { name: "Sam Roe" } }),
    // A draft is never owed.
    inv("inv-3", { total: 300, status: "draft", customer_id: "c-sam", customers: { name: "Sam Roe" } }),
    // Paid in full.
    inv("inv-4", { total: 400, amount_paid: 400, status: "paid", customer_id: "c-pat", customers: { name: "Pat Lee" } }),
    // 88 days late, Pat.
    inv("inv-5", { total: 250, due_date: "2026-07-01", customer_id: "c-pat", customers: { name: "Pat Lee" } }),
  ],
  jobs: [
    { id: "job-1", name: "41 Larkspur Place", job_number: "J-028", status: "complete", customer_id: "c-pat", customers: { name: "Pat Lee" } },
    // Finished, never invoiced: its accepted estimate is what it would bill.
    { id: "job-2", name: "13897 Honeysuckle", job_number: "J-011", status: "complete", customer_id: "c-sam", customers: { name: "Sam Roe" } },
  ],
  quotes: [{ job_id: "job-2", total: 1200, status: "accepted", created_at: "2026-09-01T00:00:00Z" }],
  payment_milestones: [],
  payments: [
    { id: "p-sep", amount: 300, method: "check", note: null, paid_at: "2026-09-20T18:00:00Z", invoices: { id: "inv-2", invoice_number: "INV-2", status: "partial", customers: { name: "Sam Roe" } } },
    { id: "p-aug", amount: 900, method: "card", note: null, paid_at: "2026-08-10T18:00:00Z", invoices: { id: "inv-4", invoice_number: "INV-4", status: "paid", customers: { name: "Pat Lee" } } },
  ],
  customer_credits: [],
  customers: [],
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

let BillingPage: (p: { searchParams?: Promise<Record<string, string>> }) => Promise<unknown>;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T18:00:00Z"));
  BillingPage = (await import("./page")).default as any;
}, 30_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.tables = structuredClone(OWING) as any;
  state.selects = [];
  state.role = "owner";
  state.redirected = null;
});

const render = async (search: Record<string, string> = {}) =>
  renderToStaticMarkup((await BillingPage({ searchParams: Promise.resolve(search) })) as React.ReactElement);
const ledgerAsked = () => state.selects.some((s) => s.table === "payments" && s.cols.includes("method"));
const waitingAsked = () => state.selects.some((s) => s.table === "jobs" && s.cols.includes("billing_type"));

describe("Owed To You: one figure, what's late, one bar", () => {
  it("the pipeline's outstanding (sent or partly paid, never a draft), the late part in red, and the bar", async () => {
    const html = await render();
    const t = text(html);
    // $1,000 + $300 + $250 open; the $300 draft and the paid bill are not owed.
    expect(t).toContain("Owed To You $1,550.00");
    expect(t).toContain("$1,250.00 late · 2");
    expect(html).toMatch(/text-red-700[^>]*>\s*\$1,250\.00 late · 2/);
    expect(html).toMatch(/role="img" aria-label="Not Late \$300\.00, 1–30 Days Late \$1,000\.00, Over 60 Days Late \$250\.00"/);
  });

  it("the three tiles are gone: no To Invoice tile, no Outstanding tile, no all-time figure, no link to /payments", async () => {
    const t = text(await render());
    expect(t).not.toMatch(/To Invoice ·/);
    expect(t).not.toMatch(/Outstanding ·/);
    expect(t).not.toMatch(/Overdue ·/);
    expect(t).not.toContain("All Time");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/page.tsx"), "utf8");
    expect(src).not.toContain("getCollected(");
    expect(src).not.toContain('href="/payments"');
  });

  it("the To Invoice dollars moved onto Done - Not Invoiced's header", async () => {
    expect(text(await render())).toContain("Done - Not Invoiced · 1 · $1,200.00");
  });

  it("nothing owed reads Owed To You $0, with no late line and no bar", async () => {
    state.tables.invoices = [];
    state.tables.jobs = [];
    const html = await render();
    expect(text(html)).toContain("Owed To You $0");
    expect(text(html)).not.toMatch(/ late · /);
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('id="customers"');
  });
});

describe("Accounts Receivable, folded in", () => {
  it("a late Sent row wears its N Days Late chip, in red", async () => {
    const html = await render();
    expect(html).toMatch(/text-red-700[^>]*>26 Days Late</);
    expect(html).toMatch(/text-red-700[^>]*>88 Days Late</);
    expect(text(html)).not.toContain("Sam Roe 0 Days Late");
  });

  it("By Customer · N is closed until asked, its customers worst-late first, each with their invoices", async () => {
    const html = await render();
    const fold = html.slice(html.indexOf('id="customers"') - 20);
    expect(fold).toMatch(/^[\s\S]*?<details id="customers"(?![^>]*open)/);
    expect(text(fold)).toMatch(/By Customer · 2/);
    const t = text(fold);
    expect(t.indexOf("Pat Lee")).toBeLessThan(t.indexOf("Sam Roe"));
    expect(t).toContain("Pat Lee 88 Days Late $1,250.00");
    // A 44px summary.
    expect(fold).toMatch(/<summary class="[^"]*min-h-11/);
  });

  it("?open=customers (the old /billing/ar) opens it; /billing/ar redirects there", async () => {
    expect(await render({ open: "customers" })).toMatch(/<details id="customers" open=""/);
    const ar = readFileSync(join(process.cwd(), "src/app/(app)/billing/ar/page.tsx"), "utf8");
    expect(ar).toContain('redirect("/billing?open=customers")');
  });

  it("a tech is sent to My Day (Accounts Receivable's staff door, kept)", async () => {
    state.role = "tech";
    await expect(render()).rejects.toThrow(/NEXT_REDIRECT \/planner/);
    expect(state.redirected).toBe("/planner");
  });
});

describe("Payments In: a link, and the ledger only when open", () => {
  it("closed: a 44px LINK with this month's money from its own small read, and no ledger read", async () => {
    const html = await render();
    const link = html.match(/<a[^>]*href="\/billing\?open=payments#payments"[^>]*>([\s\S]*?)<\/a>/);
    expect(link).not.toBeNull();
    expect(link![0]).toContain("min-h-11");
    // September's $300 only: August's $900 is last month.
    expect(text(link![1])).toContain("Payments In · $300.00 This Month");
    expect(ledgerAsked()).toBe(false);
    expect(html).not.toContain("data-get-paid");
  });

  it("open (?open=payments): the ledger is read and shown, with Get Paid…, and the line closes back to /billing", async () => {
    const html = await render({ open: "payments" });
    expect(ledgerAsked()).toBe(true);
    expect(html).toMatch(/<a[^>]*href="\/billing"[^>]*>[\s\S]*?Payments In/);
    const t = text(html);
    expect(t).toContain("Check");
    expect(t).toContain("Card");
    expect(t).toContain("$900.00");
    // Get Paid… is handed the invoices that can take a payment: the pipeline's open ones.
    expect(html).toContain('data-get-paid="3"');
    const pay = readFileSync(join(process.cwd(), "src/app/(app)/payments/page.tsx"), "utf8");
    expect(pay).toContain('redirect("/billing?open=payments")');
  });
});

/**
 * WAITING TO BE BILLED (2026-10-07): the T&M jobs with work no invoice holds, oldest first, on the
 * same link shape as Payments In - read only when open, no count on the closed line.
 */
describe("Waiting To Be Billed: a link, and the list only when open", () => {
  it("closed: a 44px LINK with no count and no read of the jobs' work", async () => {
    const html = await render();
    const link = html.match(/<a[^>]*href="\/billing\?open=waiting#waiting"[^>]*>([\s\S]*?)<\/a>/);
    expect(link).not.toBeNull();
    expect(link![0]).toContain("min-h-11");
    expect(text(link![1])).toContain("Waiting To Be Billed");
    expect(text(link![1])).not.toMatch(/\d/);
    expect(waitingAsked()).toBe(false);
    expect(text(html)).not.toContain("Oldest work");
  });

  it("open (?open=waiting): the jobs are read, oldest work first, each with its figures and Bill It, and the line closes back", async () => {
    // Both fixture jobs are time & material for this one (the fake ignores filters; the rule reads the field).
    state.tables.jobs = (state.tables.jobs as Record<string, unknown>[]).map((j) => ({ ...j, billing_type: "tm" }));
    const html = await render({ open: "waiting" });
    expect(waitingAsked()).toBe(true);
    expect(html).toMatch(/<a[^>]*href="\/billing"[^>]*>[\s\S]*?Waiting To Be Billed/);
    const t = text(html);
    const second = t.indexOf("13897 Honeysuckle · J-011 — Sam Roe");
    const first = t.indexOf("41 Larkspur Place · J-028 — Pat Lee");
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(t).toContain("Oldest work Sep 2, 2026 · 12 h · Bills $80.00 · $1,400.00");
    expect(t).toContain("Oldest work Sep 20, 2026 · 3.5 h · Bills $120.00 · $500.00");
    expect(t).toContain("Finished");
    expect((html.match(/>Bill It</g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the pure roll-ups add up to the one figure", () => {
  const pi = (id: string, customer_id: string | null, customer: string, balance: number, daysLate: number): PipelineInvoice => ({
    id,
    invoice_number: id,
    total: balance,
    balance,
    status: "sent",
    due_date: null,
    customer,
    job: null,
    overdue: daysLate > 0,
    paid: 0,
    daysLate,
    customer_id,
  });
  const UNPAID = [pi("a", "c1", "Pat Lee", 100, 0), pi("b", "c1", "Pat Lee", 50, 45), pi("c", "c2", "Pat Lee", 20, 0), pi("d", null, "Sam Roe", 5, 70)];

  it("By Customer never folds two customers who share a name, and its balances sum to the total", () => {
    const by = owedByCustomer(UNPAID);
    expect(by.map((c) => [c.customer, c.balance, c.worstDaysLate])).toEqual([
      ["Sam Roe", 5, 70],
      ["Pat Lee", 150, 45],
      ["Pat Lee", 20, 0],
    ]);
    expect(by.reduce((s, c) => s + c.balance, 0)).toBe(175);
  });

  it("the bar's pieces sum to the total", () => {
    const l = owedByLateness(UNPAID);
    expect(l).toEqual({ current: 120, d30: 0, d60: 50, d90: 5 });
    expect(l.current + l.d30 + l.d60 + l.d90).toBe(175);
  });

  it("the bar, By Customer and Owed To You are Analytics' aging on the same invoices, cut the same way, to the cent", async () => {
    const { getMoneyPipeline } = await import("@/lib/billing-pipeline");
    const { computeArAging, computeArByCustomer } = await import("@/lib/analytics/money-metrics");
    const { unpaid, outstandingTotal } = await getMoneyPipeline(fake as any);
    const aging = computeArAging(OWING.invoices, "2026-09-27");
    expect(owedByLateness(unpaid)).toEqual(aging.buckets);
    expect(outstandingTotal).toBe(aging.outstanding);
    const rows = (list: { key: string; customer: string; balance: number; worstDaysLate: number; invoices: unknown[] }[]) =>
      list.map((c) => [c.key, c.customer, c.balance, c.worstDaysLate, c.invoices.length]);
    expect(rows(owedByCustomer(unpaid))).toEqual(rows(computeArByCustomer(aging)));
    // One roll-up and one set of buckets, never a second copy of either.
    const pipelineSrc = readFileSync(join(process.cwd(), "src/lib/billing-pipeline.ts"), "utf8");
    expect(pipelineSrc).toContain("computeArByCustomer({ invoices: unpaid })");
    expect(pipelineSrc).toContain("arBucketOf(i.daysLate)");
  });
});
