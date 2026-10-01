import { describe, it, expect } from "vitest";
import { computeOwnerMoney, countedNotPaidLine, ownerMoneyWindow, type OwnerMoneyInputs } from "@/lib/analytics/owner-money";
import { buildAccountantWorkbook, periodFromKey, type AccountantWorkbookInput } from "@/lib/accountant-workbook";
import { readSupplierOwed } from "@/lib/supplier-owed-read";
import type { AccountantInputs } from "@/lib/accountant-lists";

/**
 * ONE BOOK, THREE DOORS, ONE FIGURE (8a982483, findings 1/6 and 2/7).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────
 *
 * "at the bottom it says 10k in open bills it at the top it says 5k but online it's saying a
 *  different number that's lower"
 *
 * The fix consolidated the readers. Twice afterwards, two of them still disagreed - and both times a
 * UNIT test of each reader passed, because each reader was self-consistent. What was wrong was the
 * relationship between them, and nothing in the tree asserted a relationship. So this file builds ONE
 * book of made-up paper and walks it through all three doors a figure about supplier money comes out
 * of, then insists they agree to the cent:
 *
 *   · /bills and Nort           `readSupplierOwed`          (the Suppliers card's headline)
 *   · the accountant's download `buildAccountantWorkbook`   (the Open tab, "Suppliers Say You Owe")
 *   · the P&L card              `computeOwnerMoney`         (Counted, Though Not Paid Yet)
 *
 * ── THE TWO FAULTS IT PINS ─────────────────────────────────────────────────────────────────────
 *
 * (1) THE P&L CARD NAMED THE SAME MONEY TWICE AND CALLED THE SUPPLIER A LIAR. Its model-B arm built
 *     the covering walk WITH the resolver and then re-filtered the covering tickets by the RAW
 *     `bills.supplier_account_id` column. A ticket the resolver had placed by the account's own name
 *     was dropped from `covering`, never landed in `covered`, and was then named by the loop below as
 *     a bill the supplier "has sent no invoice for yet" - beside the very invoice number printed on
 *     that ticket's own line. $5,000 named for $3,000 of materials, with a false sentence doing it.
 *
 * (2) THE WORKBOOK AND THE CARD NEVER READ THE FILED SPELLINGS. `supplierAliases` was declared on
 *     OwnerMoneyInputs and populated by nobody, so /bills resolved filed -> alias -> name while the
 *     workbook resolved filed -> name. A recurring expense writes exactly the ticket that splits them
 *     (recurring-engine.ts: free-text vendor, unpaid, no account id).
 *
 * SYNTHETIC. No real supplier, account number, invoice number or figure is in this repository.
 */

const ORG = "org-synthetic";
const ACCOUNT = "acct-northside";
const TZ = "America/Los_Angeles";
const TODAY = "2026-06-30";
const Q2 = periodFromKey("2026-Q2")!;
const WINDOW = ownerMoneyWindow("this_year", TODAY);

/** The supplier's own paper: ONE open invoice for $3,000.00, which two of our tickets make up. */
const DOCUMENT = {
  id: "d1",
  org_id: ORG,
  supplier_account_id: ACCOUNT,
  invoice_number: "9900-1234567",
  kind: "invoice",
  invoice_date: "2026-06-01",
  due_date: null,
  job_name_raw: null,
  job_id: null,
  total: 3000,
  open_balance: 3000,
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: null,
  bill_supplier_invoices: [],
};

const ACCOUNTS = [{ id: ACCOUNT, org_id: ORG, name: "Northside Wholesale Supply", account_number: "SYN-7", branch_code: null, on_account: true }];

/** The spelling somebody filed onto that account. t3 reaches it by nothing else. */
const ALIASES = [{ org_id: ORG, alias: "NWS Counter", supplier_account_id: ACCOUNT }];

/** A ticket in the shape PostgREST hands one back, named so a filter below can still see its id. */
type BillRow = {
  id: string;
  org_id: string;
  supplier: string;
  supplier_account_id: string | null;
  bill_number: string | null;
  supplier_invoice_number: string | null;
  amount: number;
  status: string;
  bill_date: string;
  created_at: string;
  job_id: string | null;
  category: string;
  is_statement: boolean;
  superseded_by_bill_id: string | null;
  notes: string | null;
  bill_line_items: { description: string }[];
};

const bill = (over: Partial<BillRow> & { id: string }): BillRow => ({
  org_id: ORG,
  supplier: "",
  supplier_account_id: null,
  bill_number: null,
  supplier_invoice_number: null,
  amount: 0,
  status: "unpaid",
  bill_date: "2026-06-10",
  created_at: "2026-06-10T15:00:00Z",
  job_id: null,
  category: "Receipt",
  is_statement: false,
  superseded_by_bill_id: null,
  notes: null,
  bill_line_items: [],
  ...over,
});

const BILLS = [
  // FILED on the account, and it carries the invoice number on its line.
  bill({
    id: "t1",
    supplier: "Northside Wholesale Supply",
    supplier_account_id: ACCOUNT,
    amount: 1000,
    bill_line_items: [{ description: "Materials (Invoice 9900-1234567)" }],
  }),
  // ON NO ACCOUNT. It reaches the account by the account's OWN NAME, and it carries the same invoice
  // number. This is the ticket the P&L card dropped from `covering` and then called un-invoiced.
  bill({
    id: "t2",
    supplier: "Northside Wholesale Supply",
    amount: 2000,
    bill_line_items: [{ description: "Materials (Invoice 9900-1234567)" }],
  }),
  // ON NO ACCOUNT, and reachable ONLY through the filed alias. The supplier has sent no paper for it.
  bill({ id: "t3", supplier: "NWS Counter", amount: 500 }),
];

// ── DOOR 1: /bills and Nort, through a fake PostgREST in the shapes the real one answers in ──────

const TABLES: Record<string, any[]> = {
  organizations: [{ id: ORG, settings: { timezone: TZ } }],
  supplier_accounts: ACCOUNTS,
  supplier_aliases: ALIASES,
  supplier_invoices: [DOCUMENT],
  bills: BILLS,
  bill_supplier_invoices: [],
  supplier_payments: [],
};

function fakeSupabase() {
  const build = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (col: string, v: unknown) => {
        filters.push((r) => String(r?.[col] ?? "") === String(v));
        return q;
      },
      is: (col: string, v: unknown) => {
        filters.push((r) => (v === null ? r?.[col] == null : r?.[col] === v));
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        filters.push((r) => (vs ?? []).map(String).includes(String(r?.[col] ?? "")));
        return q;
      },
      limit: () => settle(),
      maybeSingle: () => settle(true),
      then: (res: any, rej: any) => settle().then(res, rej),
    };
    const settle = (single = false) => {
      const rows = (TABLES[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
    };
    return q;
  };
  return { from: (table: string) => build(table) };
}

// ── DOORS 2 AND 3: the P&L card and the accountant's workbook, from the same rows ────────────────

const inputs = (over: Partial<OwnerMoneyInputs> = {}): OwnerMoneyInputs => ({
  payments: [],
  refunds: [],
  bills: BILLS,
  pos: [],
  pettyCash: [],
  entries: [],
  runs: [],
  payPayments: [],
  creditMemos: [],
  people: new Map(),
  recordsStart: "2026-06-01",
  supplierAccounts: ACCOUNTS,
  supplierAliases: ALIASES,
  supplierPayments: [],
  supplierDocuments: [DOCUMENT],
  ...over,
});

const EMPTY_LISTS: AccountantInputs = { items: [], lots: [], moves: [], bills: [], lines: [], jobs: [], claims: [] };

const workbookInput = (money: OwnerMoneyInputs): AccountantWorkbookInput => ({
  company: "Pinecrest Electric Co",
  period: Q2,
  tz: TZ,
  todayYmd: TODAY,
  showOwner: true,
  money,
  lists: EMPTY_LISTS,
  shelf: false,
  arInvoices: [],
  salesTax: null,
});

/** What the Open tab's "Suppliers Say You Owe" Total row says, in dollars. */
function workbookOwed(money: OwnerMoneyInputs): number {
  const wb = buildAccountantWorkbook(workbookInput(money));
  const open = wb.tabs.find((t) => t.name === "Open")!;
  const at = open.rows.findIndex((r) => r.cells[0] === "Suppliers Say You Owe");
  expect(at, "the Open tab still has a Suppliers Say You Owe section").toBeGreaterThan(-1);
  const totalRow = open.rows.slice(at).find((r) => r.cells[0] === "Total")!;
  const cell = totalRow.cells[1] as { money: number };
  return cell.money;
}

/** The supplier rows under that heading, name and figure, so a disagreement can be read not guessed. */
function workbookRows(money: OwnerMoneyInputs): { name: string; owed: number }[] {
  const wb = buildAccountantWorkbook(workbookInput(money));
  const open = wb.tabs.find((t) => t.name === "Open")!;
  const at = open.rows.findIndex((r) => r.cells[0] === "Suppliers Say You Owe");
  const out: { name: string; owed: number }[] = [];
  for (const r of open.rows.slice(at + 2)) {
    if (r.cells[0] === "Total") break;
    if (typeof r.cells[0] === "string" && r.cells[1] && typeof r.cells[1] === "object" && "money" in (r.cells[1] as any)) {
      out.push({ name: r.cells[0] as string, owed: (r.cells[1] as { money: number }).money });
    }
  }
  return out;
}

describe("one book of paper, three doors, one figure", () => {
  /**
   * THE SUPPLIER IS THE TRUTH ABOUT ITS OWN OPEN BALANCE. The account sends its own papers, so its
   * figure is theirs: $3,000.00. Our three tickets come to $3,500.00 and that is a DIFFERENT
   * question (what was bought and not squared up), which is why it is a different number.
   */
  it("the Bills page and Nort say what the supplier's own papers say", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(read!.failed).toEqual([]);
    expect(read!.owed.total).toBe(3000);
    expect(read!.owed.lines).toEqual([
      { accountId: ACCOUNT, name: "Northside Wholesale Supply", owed: 3000, how: "their-own-papers", papers: 3, onAccount: true },
    ]);
    // Every ticket landed on the account, including the one only the alias reaches.
    expect(read!.owed.notOnAnAccount.papers).toBe(0);
    expect(read!.bought.total).toBe(3500);
  });

  /**
   * THE ACCOUNTANT'S DELIVERABLE IS THE SAME NUMBER AS HIS CARD. Before the aliases were read it was
   * $3,500.00 here against $3,000.00 there, with an extra row called "NWS Counter … and not on a
   * supplier account yet" - his original complaint, recreated between the card and the file he hands
   * to his accountant.
   */
  it("the accountant's download agrees with the Bills page to the cent", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(workbookOwed(inputs())).toBe(read!.owed.total);
    expect(workbookRows(inputs())).toEqual([{ name: "Northside Wholesale Supply", owed: 3000 }]);
  });

  /**
   * AND THE FILED SPELLINGS ARE WHAT MAKE THEM AGREE. With the aliases withheld the workbook cannot
   * place t3, so it lands in the off-account pile and the download says $3,500.00 for the book the
   * card calls $3,000.00. This assertion is the one that fails if anybody stops reading the table.
   */
  it("fails apart the moment the filed spellings are withheld", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    const blind = inputs({ supplierAliases: [] });
    expect(workbookOwed(blind)).toBe(3500);
    expect(workbookOwed(blind)).not.toBe(read!.owed.total);
    expect(workbookRows(blind).map((r) => r.name)).toContain("NWS Counter");
  });
});

describe("the P&L card names each dollar once, and says nothing untrue about the supplier", () => {
  /**
   * $3,000.00 OF MATERIALS, NAMED ONCE. The model-B arm's `covering` filter read the raw column while
   * the walk above it and the loop below it read the resolver, so t2 ($2,000.00, on no account, the
   * invoice number on its own line) fell out of `covered` and was named as money the supplier had
   * never billed. The card said $5,000.00 and called the supplier's own invoice imaginary.
   */
  it("counts the supplier's open invoice once and does not call a covered ticket un-invoiced", () => {
    const m = computeOwnerMoney(inputs(), WINDOW, TZ, TODAY);
    const owed = m.caveats.find((c) => c.kind === "supplier_owed");
    const noDoc = m.caveats.find((c) => c.kind === "supplier_no_document");
    expect(owed).toMatchObject({ total: 3000 });
    // ONLY t3 has no paper of the supplier's behind it. t2 does, and it is the same one t1 covers.
    expect(noDoc).toMatchObject({ total: 500, count: 1 });
    // The two slices together are the three tickets' worth of money, never $5,500.00.
    expect((owed as any).total + (noDoc as any).total).toBe(3500);
  });

  it("says it in a sentence that does not assert something false about the supplier", () => {
    const line = countedNotPaidLine(computeOwnerMoney(inputs(), WINDOW, TZ, TODAY))!;
    expect(line).toBe(
      "Counted, though not paid yet: $3,000.00 owed to Northside Wholesale Supply by its own invoices and $500.00 in 1 bill Northside Wholesale Supply has sent no invoice for yet.",
    );
    // The $2,000.00 ticket is nowhere named as one they never billed, and the total named is not $5,000.
    expect(line).not.toContain("$2,000.00");
    expect(line).not.toContain("$2,500.00");
  });

  /**
   * AND THE OTHER HALF OF THE SAME FAULT: where EVERY covering ticket is on no account, the raw-column
   * filter emptied `covering` altogether, so the supplier's open invoice left "owed" completely and
   * the card said they had sent no invoice for the money - also false, in the other direction.
   */
  it("still counts the supplier's invoice when no covering ticket was ever filed", () => {
    const unfiled = inputs({ bills: BILLS.filter((b) => b.id !== "t1") });
    const m = computeOwnerMoney(unfiled, WINDOW, TZ, TODAY);
    expect(m.caveats.find((c) => c.kind === "supplier_owed")).toMatchObject({ total: 3000 });
    expect(m.caveats.find((c) => c.kind === "supplier_no_document")).toMatchObject({ total: 500, count: 1 });
    expect(countedNotPaidLine(m)).toContain("$3,000.00 owed to Northside Wholesale Supply by its own invoices");
  });
});
