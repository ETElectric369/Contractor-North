import { describe, it, expect } from "vitest";
import { readReconcileWork, figuresFrom } from "./reconcile-read";
import { reconcileBadge } from "@/lib/reconcile-kinds";
import { readSupplierOwed } from "@/lib/supplier-owed-read";

/**
 * THE DOT AND THE PAGE CAN NEVER SAY DIFFERENT THINGS (cn-v1037).
 *
 * The dock's amber dot and the page it opens are two readers of one pile. When two readers reach a
 * pile their own way, one of them eventually says 3 over a page showing 2 — the fault
 * tests/badge-economy.test.ts calls the never-disagree doctrine. So both call `readReconcileWork`,
 * and the only difference is that the badge passes no figures, because it draws no money.
 *
 * THIS IS THE PROOF OF THAT, not a restatement of it: one book of made-up paper, read twice, and the
 * counts have to match.
 *
 * SYNTHETIC. Every name, number and figure below is invented.
 */

const ORG = "org-synthetic";
const ACCOUNT = "acct-crestline";

const bill = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  supplier: "Crestline Electrical Wholesale",
  supplier_account_id: null,
  amount: 100,
  status: "unpaid",
  bill_date: "2026-09-01",
  job_id: "job-1",
  notes: null,
  supplier_invoice_number: null,
  superseded_by_bill_id: null,
  jobs: { name: "9 Alder Court" },
  bill_line_items: [{ description: "1/2 conduit" }],
  ...over,
});

const TICKET = [{ description: "Lever connector" }, { description: "1/2 conduit" }, { description: "Staples" }];

const BOOK = {
  supplier_accounts: [{ id: ACCOUNT, name: "Crestline Electrical Wholesale", account_number: "SYN-1", branch_code: null, on_account: true }],
  supplier_aliases: [{ alias: "Crestline Electrical Wholesale", supplier_account_id: ACCOUNT }],
  bills: [
    // On the account by its own name: never a spelling to file.
    bill("b-on", { amount: 400, supplier_account_id: ACCOUNT }),
    // Two spellings on no account that read as one name: a proposal.
    bill("b-m1", { supplier: "Fernside Pipe & Fitting", amount: 50, status: "paid" }),
    bill("b-m2", { supplier: "Fernside Pipe and Fitting", amount: 70, status: "paid" }),
    // A spelling with no relative at all: one loose row.
    bill("b-loose", { supplier: "Quarry Lane Rentals", amount: 90 }),
    // The same ticket on two jobs.
    bill("b-d1", { amount: 21.75, supplier_account_id: ACCOUNT, bill_line_items: TICKET, notes: "one.pdf", jobs: { name: "9 Alder Court" } }),
    bill("b-d2", { amount: 21.75, supplier_account_id: ACCOUNT, bill_line_items: TICKET, notes: "two.pdf", job_id: "job-2", jobs: { name: "31 Wren Street" }, bill_date: "2026-08-02" }),
  ],
  supplier_invoices: [
    {
      id: "d-1",
      supplier_account_id: ACCOUNT,
      invoice_number: "7700-1",
      kind: "invoice",
      invoice_date: "2026-09-01",
      due_date: null,
      job_name_raw: null,
      job_id: null,
      total: 300,
      open_balance: 300,
      closed: false,
      discount_amount: null,
      discount_by: null,
      source_file: null,
    },
  ],
  bill_supplier_invoices: [],
  supplier_payments: [],
  organizations: [{ settings: { timezone: "America/Los_Angeles" } }],
};

/** A PostgREST stand-in: every read answers that table's rows, or the error it was told to. */
function fakeDb(book: Record<string, unknown[]>, errors: Record<string, unknown> = {}) {
  return {
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte"]) c[m] = () => c;
      const answer = { data: errors[table] ? null : (book[table] ?? []), error: errors[table] ?? null };
      c.maybeSingle = async () => ({ data: answer.data?.[0] ?? null, error: answer.error });
      c.single = c.maybeSingle;
      c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(answer).then(ok, err);
      return c;
    },
  } as any;
}

const read = async (book: Record<string, unknown[]>, errors: Record<string, unknown> = {}) => {
  const db = fakeDb(book, errors);
  const owed = await readSupplierOwed(db, ORG);
  const page = await readReconcileWork(db, ORG, figuresFrom(owed));
  const badge = await readReconcileWork(db, ORG, null);
  return { owed, page, badge };
};

describe("the badge reads the page's own read", () => {
  it("the counts are identical with the figures and without them", async () => {
    const { page, badge } = await read(BOOK as any);
    expect(page.counts).toEqual(badge.counts);
    expect(reconcileBadge(badge.counts)).toBe(reconcileBadge(page.counts));
  });

  it("this book has three kinds open, so the dot reads 3 — never the six rows behind it", async () => {
    const { page } = await read(BOOK as any);
    expect(page.counts).toEqual({
      "supplier-names": 1,
      "same-supplier-or-two": 0,
      "not-on-an-account": 1,
      "same-ticket-two-jobs": 1,
    });
    expect(reconcileBadge(page.counts)).toBe(3);
    expect(page.proposals[0].spellings.map((s) => s.alias).sort()).toEqual(["Fernside Pipe & Fitting", "Fernside Pipe and Fitting"]);
    expect(page.loose.map((s) => s.alias)).toEqual(["Quarry Lane Rentals"]);
  });

  /** THE MONEY IS THE ONLY DIFFERENCE, and only where the suppliers' own papers change it. */
  it("the page's rows carry money; the badge's do not pretend to", async () => {
    const { page, badge } = await read(BOOK as any);
    expect(page.unassigned.total).toBeGreaterThan(0);
    // "Same supplier, or two?" shows each side's balance; the badge has no balance to show, and a
    // zero invented there would print "owes nothing" beside a name.
    expect(badge.proposals.map((p) => p.id)).toEqual(page.proposals.map((p) => p.id));
  });
});

describe("what is counted is what still needs someone", () => {
  it("a pick already made keeps its row and leaves the count — badges show open", async () => {
    const answered = {
      ...BOOK,
      bills: BOOK.bills.map((b) => (b.id === "b-d2" ? { ...b, superseded_by_bill_id: "b-d1" } : b)),
    };
    const { page } = await read(answered as any);
    expect(page.duplicates).toHaveLength(1);
    expect(page.duplicates[0].resolution).toEqual({ keptBillId: "b-d1" });
    expect(page.counts["same-ticket-two-jobs"]).toBe(0);
  });

  it("the money on an unfiled spelling leaves out what the register already settled", async () => {
    // Fernside's two bills are paid at the till; Quarry Lane's one is still on account.
    const { page } = await read(BOOK as any);
    expect(page.unassigned.bills).toBe(1);
    expect(page.unassigned.total).toBe(90);
    expect(page.proposals[0].spellings.every((s) => s.unpaid === 0)).toBe(true);
  });

  it("without 0271's column the duplicate picker is not offered at all, and counts nothing", async () => {
    const noColumn = {
      ...BOOK,
      bills: BOOK.bills.map(({ superseded_by_bill_id: _drop, ...rest }) => rest),
    };
    const { page } = await read(noColumn as any);
    expect(page.supersedeReady).toBe(false);
    expect(page.duplicates).toEqual([]);
    expect(page.counts["same-ticket-two-jobs"]).toBe(0);
  });
});

describe("nothing is claimed off a read that failed", () => {
  it("a lost bills read counts nothing and names what it could not read", async () => {
    const { page } = await read(BOOK as any, { bills: { message: "boom" } });
    expect(page.failed).toContain("bills");
    expect(page.counts).toEqual({
      "supplier-names": 0,
      "same-supplier-or-two": 0,
      "not-on-an-account": 0,
      "same-ticket-two-jobs": 0,
    });
    expect(reconcileBadge(page.counts)).toBe(0);
  });

  it("a lost supplier-names read is the same: a spelling could be on an account and look loose", async () => {
    const { page } = await read(BOOK as any, { supplier_aliases: { message: "boom" } });
    expect(page.failed).toContain("supplier names");
    expect(reconcileBadge(page.counts)).toBe(0);
  });

  it("an empty company has nothing open and no sentence to say", async () => {
    const { page } = await read({ organizations: BOOK.organizations } as any);
    expect(reconcileBadge(page.counts)).toBe(0);
    expect(page.failed).toEqual([]);
    expect(page.unassigned).toEqual({ bills: 0, total: 0 });
  });

  it("no org id reads nothing at all", async () => {
    const page = await readReconcileWork(fakeDb(BOOK as any), "", null);
    expect(reconcileBadge(page.counts)).toBe(0);
  });
});

/**
 * THE FIGURES COME OUT OF THE ONE READ, PER ACCOUNT. Reconcile draws our side against theirs, and
 * both numbers are `readSupplierOwed`'s — never added up on the page.
 */
describe("the two records, both from readSupplierOwed", () => {
  it("their own papers and our own tickets come back per account, from the owning functions", async () => {
    const { owed } = await read(BOOK as any);
    const line = owed!.owed.lines.find((l) => l.accountId === ACCOUNT)!;
    // Theirs: their one open invoice.
    expect(line.how).toBe("their-own-papers");
    expect(line.owed).toBe(300);
    // Ours: the three open tickets the resolver placed on that account (400 + 21.75 + 21.75).
    expect(owed!.boughtByAccount[ACCOUNT]).toMatchObject({ total: 443.5, papers: 3 });
    // And the whole-book figure is still the whole book, loose spellings included.
    expect(owed!.bought.total).toBe(533.5);
  });
});
