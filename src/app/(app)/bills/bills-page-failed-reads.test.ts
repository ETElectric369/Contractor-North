import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BillsSearchRow } from "./bills-search";

/**
 * A READ THAT FAILED SAYS SO, ON /bills (audit v1018, classes 2 and 14).
 *
 * The page reads fifteen things in one breath. Any one of the supplier half failing used to read as
 * "nothing there": Needs You vanished with no sentence, CED's balance quietly switched to bills-
 * less-payments (the model the page's own comments call wrong for CED: $3,355.84 shown against
 * CED's $5,174.62), the ledger said "No bills here yet", a lost links read named linked bills "+ $N
 * they never sent paper for", and the search box called covered papers "not in your books". This
 * renders THE PAGE ITSELF against a fake database, once whole and once per failed read.
 *
 * The search rows are read off the box's props: the box shows nothing until he types.
 */

const ORG = "org-fixture";
const CED = "acct-ced";
const ACE = "acct-ace";
const J011 = "job-011";
const J045 = "job-045";

const JOBS = [
  { id: J011, job_number: "J-011", name: "13897 Herringbone", status: "in_progress", address: "13897 Herringbone Way", created_at: "2026-06-20T00:00:00Z" },
  { id: J045, job_number: "J-045", name: "13683 Hillside", status: "complete", address: "13683 Hillside Dr", created_at: "2026-09-01T00:00:00Z" },
];
const bill = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier: "Consolidated Electrical Distributors, Inc. (CED)",
  bill_number: null,
  amount: 0,
  status: "unpaid",
  bill_date: "2026-09-04",
  job_id: J011,
  po_id: null,
  category: null,
  notes: null,
  supplier_account_id: CED,
  supplier_invoice_number: null,
  is_statement: false,
  superseded_by_bill_id: null,
  pricing_provisional: false,
  jobs: { job_number: "J-011", name: "13897 Herringbone" },
  bill_line_items: [],
  ...over,
});
const BILLS = [
  bill("b-her", { amount: 301.81, bill_number: "8802-1106969" }),
  // Covered ONLY by a Record link: a lost links read must not call it paperless.
  bill("b-link", { amount: 187.64, bill_date: "2026-09-16" }),
  bill("b-ace", { supplier: "Ace Mountain Hardware", amount: 40, supplier_account_id: ACE, bill_date: "2026-09-10" }),
];
const doc = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier_account_id: CED,
  invoice_number: "",
  kind: "invoice",
  invoice_date: "2026-09-01",
  due_date: null,
  job_name_raw: null,
  job_id: null,
  total: 0,
  open_balance: null,
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: null,
  waiting_credit_since: null,
  jobs: null,
  ...over,
});
const PAPERS = [
  doc("si-1106969", { invoice_number: "8802-1106969", invoice_date: "2026-09-04", job_name_raw: "13897 HERRINGBONE", total: 301.81, open_balance: 301.81 }),
  doc("si-1107820", { invoice_number: "8802-1107820", invoice_date: "2026-09-16", job_name_raw: "13897 HERRINGBONE", total: 187.64, open_balance: 187.64 }),
  // His real credit memo on no job: its only home is CED's own Invoices With No Job list.
  doc("si-1104645", { invoice_number: "8802-1104645", kind: "credit_memo", invoice_date: "2026-08-06", job_name_raw: "13631 NORTHWOODS", total: -31.86, open_balance: -31.86 }),
  // 13683 HILLSIDE, set aside for a credit on Sep 20: Stop Waiting is in its Waiting On A Credit fold.
  doc("si-1107139", { invoice_number: "8802-1107139", invoice_date: "2026-09-10", job_name_raw: "13683 HILLSIDE", total: 59.17, open_balance: 59.17, waiting_credit_since: "2026-09-20T18:00:00Z" }),
];

const BASE: Record<string, unknown[]> = {
  profiles: [{ org_id: ORG }],
  organizations: [{ settings: { timezone: "America/Los_Angeles" } }],
  purchase_orders: [],
  bills: BILLS,
  documents: [],
  jobs: JOBS,
  material_lists: [],
  supplier_accounts: [
    { id: CED, name: "Consolidated Electrical Distributors", account_number: "TR-34426", branch_code: "8802", on_account: true, note: null },
    { id: ACE, name: "Ace Mountain Hardware", account_number: null, branch_code: null, on_account: true, note: null },
  ],
  supplier_aliases: [
    { id: "al-1", supplier_account_id: CED, alias: "Consolidated Electrical Distributors, Inc. (CED)", branch_label: null },
    { id: "al-2", supplier_account_id: ACE, alias: "Ace Mountain Hardware", branch_label: null },
  ],
  supplier_payments: [
    { id: "pay-1", supplier_account_id: CED, amount: 100, paid_on: "2026-09-05", method: "check", reference: null, note: null, voided_at: null },
    { id: "pay-2", supplier_account_id: ACE, amount: 10, paid_on: "2026-09-12", method: "check", reference: null, note: null, voided_at: null },
  ],
  supplier_invoices: PAPERS,
  bill_supplier_invoices: [{ bill_id: "b-link", supplier_invoice_id: "si-1107820" }],
  organized_items: [],
  stock_lot_balance: [],
  inventory_items: [],
  invoice_items: [],
};

const state = vi.hoisted(() => ({ failing: new Set<string>(), rows: [] as BillsSearchRow[] }));

function chain(table: string) {
  const answer = () =>
    state.failing.has(table) ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : { data: BASE[table] ?? [], error: null };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "filter", "range"]) c[m] = () => c;
  c.maybeSingle = async () => {
    const a = answer();
    return { data: a.data ? (a.data as unknown[])[0] ?? null : null, error: a.error };
  };
  c.single = c.maybeSingle;
  c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, err);
  return c;
}
const fake = {
  auth: { getUser: async () => ({ data: { user: { id: "user-erik" } } }) },
  from: (t: string) => chain(t),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/bills",
  redirect: () => {},
}));
vi.mock("./bills-search-box", () => ({
  BillsSearchBox: ({ rows }: { rows: BillsSearchRow[] }) => {
    state.rows = rows;
    return null;
  },
}));

let BillsPage: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
  BillsPage = (await import("./page")).default as any;
}, 30_000);
afterAll(() => vi.useRealTimers());

async function renderWith(...failing: string[]) {
  state.failing = new Set(failing);
  state.rows = [];
  const html = renderToStaticMarkup((await BillsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return { html, text, rows: state.rows };
}
const paper = (rows: BillsSearchRow[], id: string) => rows.find((r) => r.key === `paper:${id}`)!;

describe("every read answered (the baseline the failures are measured against)", () => {
  it("CED is counted from its own papers, Ace from bills less payments", async () => {
    const { text } = await renderWith();
    expect(text).toContain("Consolidated Electrical Distributors says");
    expect(text).toContain("your bills less payments");
    expect(text).not.toContain("Couldn't");
    expect(text).not.toContain("they never sent paper for");
  });

  it("search: every paper lands where its own buttons are (class 14)", async () => {
    const { rows } = await renderWith();
    // The credit memo on no job: CED's own lists (Invoices With No Job), not a dead row.
    expect(paper(rows, "si-1104645").href).toBe(`#supplier-invoices-${CED}`);
    // Waiting on a credit: its fold, where Stop Waiting is.
    expect(paper(rows, "si-1107139").href).toBe(`#supplier-waiting-credit-${CED}`);
    expect(paper(rows, "si-1107139").sub).toContain("waiting on a credit from CED since Sep 20");
    // In the books through a Record link: the job the covering bill is on.
    expect(paper(rows, "si-1107820").href).toBe(`/jobs/${J011}`);
    expect(paper(rows, "si-1107820").sub).toContain("in your books");
  });
});

describe("the supplier's own papers unread", () => {
  it("Needs You says so, and CED's balance is never quietly counted the other way", async () => {
    const { html, text } = await renderWith("supplier_invoices");
    expect(html).toMatch(/id="needs-you"/);
    expect(text).toContain("Couldn't read your suppliers' own papers just now");
    // No bills-less-payments figure for any account on account: CED would have been $389.45.
    expect(text).not.toContain("your bills less payments");
    expect(text).not.toContain("$389.45");
    expect(text).toContain("Couldn't Total Just Now");
    expect((text.match(/Couldn't Total(?! Just Now)/g) ?? []).length).toBe(2);
    expect(html).toMatch(/role="alert"/);
  });
});

describe("the bills unread", () => {
  it("All Bills says it couldn't read them, never 'No bills here yet'", async () => {
    const { text } = await renderWith("bills");
    expect(text).toContain("Couldn't read your bills just now");
    expect(text).not.toContain("No bills here yet");
    expect(text).not.toContain("All Bills (0)");
  });

  it("Needs You says it couldn't check; a bills-less-payments account never reads 'ahead'", async () => {
    const { text } = await renderWith("bills");
    expect(text).toContain("Couldn't check your books just now");
    expect(text).not.toMatch(/\$10\.00 ahead/);
    expect(text).not.toContain("Square With Everyone");
    // CED is counted from its own papers, which were read: its figure stands.
    expect(text).toContain("Consolidated Electrical Distributors says");
  });

  it("search never says 'not in your books' when the books were not read", async () => {
    const { rows } = await renderWith("bills");
    for (const r of rows.filter((x) => x.kind === "paper")) expect(r.sub).not.toMatch(/\bnot in your books|in your books\b/);
    expect(paper(rows, "si-1106969").sub).toContain("couldn't check your books just now");
    // A waiting paper's own stamp still answers.
    expect(paper(rows, "si-1107139").sub).toContain("waiting on a credit from CED since Sep 20");
  });
});

describe("the links unread", () => {
  it("a bill covered only by a Record link is never named 'never sent paper for'", async () => {
    const { text, rows } = await renderWith("bill_supplier_invoices");
    expect(text).not.toContain("they never sent paper for");
    expect(text).toContain("Couldn't check your books just now");
    expect(paper(rows, "si-1107820").sub).toContain("couldn't check your books just now");
  });

  it("the Suppliers card says so too, and never calls his unpaid bills 'your paperwork rather than theirs'", async () => {
    const { text } = await renderWith("bill_supplier_invoices");
    expect(text).toContain("Couldn't check your bills against the papers Consolidated Electrical Distributors sent just now");
    expect(text).toContain("Couldn't check your bills against their papers");
    expect(text).not.toContain("your paperwork rather than theirs");
    expect(text).toContain("Which of your unpaid bills there they never billed you for couldn't be checked just now");
    // CED's own figure stands: the links are not in it.
    expect(text).toContain("Consolidated Electrical Distributors says");
  });
});

describe("the supplier accounts unread", () => {
  it("the Suppliers card is there, saying so, and Needs You says so too", async () => {
    const { html, text } = await renderWith("supplier_accounts");
    expect(html).toMatch(/id="suppliers"/);
    expect(text).toContain("Couldn't read your supplier accounts just now");
    expect(html).toMatch(/id="needs-you"/);
  });
});

describe("the payments unread", () => {
  it("a bills-less-payments account can't total; CED's own figure stands", async () => {
    const { text } = await renderWith("supplier_payments");
    expect(text).not.toContain("your bills less payments");
    expect(text).toContain("Couldn't Total");
    expect(text).toContain("Consolidated Electrical Distributors says");
  });

  it("CED never reads 'you have sent them $0.00': its payments say they couldn't be read", async () => {
    const whole = await renderWith();
    expect(whole.text).toContain("$100.00 you have sent them");
    const { text } = await renderWith("supplier_payments");
    expect(text).not.toMatch(/\$0\.00 you have sent them/);
    expect(text).toContain("Couldn't Read you have sent them");
    expect(text).toContain("Couldn't read your payments to Consolidated Electrical Distributors just now");
    expect(text).toContain("Couldn't read your payments to Ace Mountain Hardware just now");
  });
});
