import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { countDoors, doorsIn, sectionOf, textOf } from "@/test/rendered-page";
import { answeredOnReconcile } from "@/lib/paperwork";

/**
 * ── A STATEMENT IS ANSWERED WHERE IT IS DROPPED (2026-10-03) ───────────────────────────────────
 *
 * Erik: "so it still doesnt make sense to me that all this reconcile stuff is on the bills page." He
 * dropped a supplier statement into Bring In A Statement on /reconcile and then had to walk to /bills
 * to press Apply on it — a merry-go-round for one paper, with the answer on a different page from the
 * question.
 *
 * THE RULE THESE TESTS PIN: a document comparing two records is answered on Reconcile; a paper that
 * becomes a cost is answered on Bills. It is one function (`answeredOnReconcile`), and both pages read
 * it, so they cannot drift into drawing the same card twice or neither.
 *
 * Every name, figure and account number below is invented. This repository is public.
 */

const ORG = "org-synthetic";
const ACCT = "acct-halverson";

/** A supplier's open list, exactly as `readOpenListTable` stores one: two papers, $600.54 open. */
const STORED_LIST = {
  list: {
    v: 1,
    from: "file",
    name: "Statement.pdf",
    listDate: "2026-09-25",
    listDateFrom: "printed",
    accountNumber: "AC-55012",
    printedTotal: 600.54,
    printedCount: 2,
    header: ["Reference", "Inv Date", "Open Balance"],
    columns: { reference: 0, invoiceDate: 1, openBalance: 2 },
    skipped: [],
    rows: [
      { reference: "7701-220114", kind: "invoice", typeWords: "Invoice", po: null, invoiceDate: "2026-09-08", dueDate: null, amount: 412.5, openBalance: 412.5, discountAmount: null, discountBy: null, accountNumber: null },
      { reference: "7701-220486", kind: "invoice", typeWords: "Invoice", po: null, invoiceDate: "2026-09-19", dueDate: null, amount: 188.04, openBalance: 188.04, discountAmount: null, discountBy: null, accountNumber: null },
    ],
  },
  needs: null,
};

const paper = (id: string, number: string, date: string, total: number) => ({
  id,
  supplier_account_id: ACCT,
  invoice_number: number,
  kind: "invoice",
  invoice_date: date,
  due_date: null,
  job_name_raw: null,
  job_id: null,
  total,
  open_balance: total,
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: null,
  jobs: null,
});

const TABLES: Record<string, unknown[]> = {
  profiles: [{ id: "user-owner", org_id: ORG, role: "owner", full_name: "A N Owner" }],
  organizations: [{ settings: { timezone: "America/Los_Angeles" }, name: "Synthetic Electric" }],
  // OUR OWN TICKETS ON THAT ACCOUNT, adding to exactly what their papers say is open, so there is no
  // money gap to lead with and the lead is free to speak about what IS waiting: the statement.
  bills: [
    { id: "b-1", supplier: "Halverson Electric Supply", bill_number: null, amount: 412.5, status: "unpaid", bill_date: "2026-09-08", job_id: null, po_id: null, category: null, notes: null, supplier_account_id: ACCT, supplier_invoice_number: "7701-220114", is_statement: false, superseded_by_bill_id: null, pricing_provisional: false, jobs: null, bill_line_items: [] },
    { id: "b-2", supplier: "Halverson Electric Supply", bill_number: null, amount: 188.04, status: "unpaid", bill_date: "2026-09-19", job_id: null, po_id: null, category: null, notes: null, supplier_account_id: ACCT, supplier_invoice_number: "7701-220486", is_statement: false, superseded_by_bill_id: null, pricing_provisional: false, jobs: null, bill_line_items: [] },
    { id: "b-3", supplier: "Halverson Electric Supply", bill_number: null, amount: 61.4, status: "unpaid", bill_date: "2026-09-02", job_id: null, po_id: null, category: null, notes: null, supplier_account_id: ACCT, supplier_invoice_number: "7701-219002", is_statement: false, superseded_by_bill_id: null, pricing_provisional: false, jobs: null, bill_line_items: [] },
  ],
  jobs: [],
  supplier_accounts: [{ id: ACCT, name: "Halverson Electric Supply", account_number: "AC-55012", branch_code: null, on_account: true, note: null }],
  supplier_aliases: [{ id: "al-1", supplier_account_id: ACCT, alias: "Halverson Electric Supply", branch_label: null }],
  supplier_payments: [],
  // Both papers the statement lists are already here, and one MORE that it does not list and that is
  // older than its printed date: Apply would mark that one paid.
  supplier_invoices: [
    paper("p-1", "7701-220114", "2026-09-08", 412.5),
    paper("p-2", "7701-220486", "2026-09-19", 188.04),
    paper("p-3", "7701-219002", "2026-09-02", 61.4),
  ],
  bill_supplier_invoices: [],
  organized_items: [
    {
      id: "tray-list",
      kind: "job_document",
      source: "bills_drop",
      status: "needs_review",
      doc_type: "statement",
      vendor: null,
      amount: 600.54,
      title: "Statement.pdf",
      created_at: "2026-09-26T12:00:00Z",
      file_url: null,
      jobs: null,
      proposal: { openList: STORED_LIST },
    },
  ],
};

let CURRENT: Record<string, unknown[]> = TABLES;

function chain(table: string) {
  const rows = CURRENT[table] ?? [];
  let window = rows;
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "filter"]) c[m] = () => c;
  // `range` IS HONOURED, because a paged read (readAllPages, behind loadPapers) asks for the next
  // window until one comes back short. A fake that handed every row back to every page would never
  // come back short, and the read would stop itself with "more than 50000 rows to read at once".
  c.range = (from: number, to: number) => {
    window = rows.slice(from, to + 1);
    return c;
  };
  c.maybeSingle = async () => ({ data: window[0] ?? null, error: null });
  c.single = c.maybeSingle;
  c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve({ data: window, error: null }).then(ok, err);
  return c;
}
const fake = {
  auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
  from: (t: string) => chain(t),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/reconcile",
  redirect: (to: string) => {
    throw new Error(to);
  },
}));

const render = async () => {
  const { default: ReconcilePage } = await import("./page");
  return renderToStaticMarkup((await ReconcilePage()) as React.ReactElement);
};

let html = "";
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
  html = await render();
}, 30_000);
afterAll(() => vi.useRealTimers());

describe("which screen answers a paper is one rule", () => {
  const item = (proposal: unknown, over: Record<string, unknown> = {}) => ({ id: "x", status: "needs_review", kind: "job_document", proposal, ...over }) as never;

  it("a document comparing two records is answered on Reconcile", () => {
    expect(answeredOnReconcile(item({ openList: STORED_LIST }))).toBe(true);
    expect(answeredOnReconcile(item({ bankImport: { download: { lines: [] } } }))).toBe(true);
  });

  it("a paper that becomes a cost is answered on Bills", () => {
    // A receipt with a total, a bill, a picture asking what it is, a paper nothing has read, and a
    // statement whose list of open papers could NOT be read: every one of them ends up on a job or in
    // a bucket, so every one of them stays on Bills.
    expect(answeredOnReconcile(item({ receipt: true }, { doc_type: "receipt", amount: 84.12, summary: "Home Depot" }))).toBe(false);
    expect(answeredOnReconcile(item({}, { doc_type: "bill", amount: 212, summary: "A bill" }))).toBe(false);
    expect(answeredOnReconcile(item({ picture: true }, { file_url: "org/organize/x.jpg", summary: "A photo" }))).toBe(false);
    expect(answeredOnReconcile(item({}, { file_url: "org/organize/y.pdf" }))).toBe(false);
    expect(answeredOnReconcile(item({}, { doc_type: "statement", summary: "A statement", amount: 90 }))).toBe(false);
  });

  it("a paper already filed is answered nowhere", () => {
    expect(answeredOnReconcile(item({ openList: STORED_LIST }, { status: "filed" }))).toBe(false);
  });
});

describe("the statement he dropped is answered on the page he dropped it on", () => {
  it("its card is inside Bring In A Statement, with the Apply, and no second home of its own", () => {
    const card = sectionOf(html, "bring-in-a-statement");
    expect(countDoors(doorsIn(card), "Apply")).toBe(1);
    // ONE HOME: the card that arrives is the answer to the intake card, so it is inside it. An Apply
    // anywhere else on this page would be a second place to answer the same paper.
    expect(countDoors(doorsIn(html), "Apply")).toBe(1);
    expect(textOf(card)).toContain("Halverson Electric Supply");
    expect(textOf(card)).toContain("Supplier's List");
  });

  it("and it never sends him to Bills to finish it", () => {
    expect(countDoors(doorsIn(html), "Open Bills")).toBe(0);
    expect(textOf(html)).not.toContain("Needs You on Bills");
  });

  /**
   * THE LEAD COUNTS WHAT IT CLAIMS. It used to say "Nothing here is waiting on you" *because* this page
   * did not read the paper queue. It reads it now, so the all-clear is gated on that read being empty
   * and the waiting statement is named where he stops reading.
   */
  it("the lead names the statement instead of printing an all-clear over it", () => {
    const lead = textOf(sectionOf(html, "reconcile-lead"));
    expect(lead).toContain("1 Statement Waiting On You");
    expect(lead).toContain("waiting under Bring In A Statement below");
    expect(lead).not.toContain("Nothing Disagrees Right Now");
    expect(lead).not.toContain("Nothing here is waiting on you");
  });

  it("with nothing dropped, the lead is an all-clear again and the card says what will happen", async () => {
    CURRENT = { ...TABLES, organized_items: [] };
    try {
      const quiet = await render();
      expect(textOf(sectionOf(quiet, "reconcile-lead"))).toContain("Nothing here is waiting on you");
      expect(countDoors(doorsIn(quiet), "Apply")).toBe(0);
      expect(textOf(sectionOf(quiet, "bring-in-a-statement"))).toContain("Whatever you drop waits here on its own card");
    } finally {
      CURRENT = TABLES;
    }
  });
});
