import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCSV } from "@/lib/csv";

/**
 * A BANK DOWNLOAD, DROPPED, APPLIED AND UNDONE, against an in-memory database that answers the way
 * PostgREST does (a filter that matches nothing is zero rows, never an error; a UNIQUE key refuses
 * a second row). Everything here is a MADE-UP statement and a made-up company.
 *
 * Pinned: the door recognises a bank's columns; nothing is written before Apply; Apply writes
 * exactly what the card showed and nothing of another company's; a row left for later writes
 * nothing and stays on the card; two presses write once; a stale card writes nothing; the second,
 * overlapping download counts what the first wrote as already in North and sorts by the answers
 * the first taught; Undo takes back only what the download wrote; before 0363 nothing crashes.
 */

const state = vi.hoisted(() => ({ client: null as any, orgId: "org-1" }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: state.orgId })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));

// The cost guard's own sentence: a refusal here must BE it, never a second wording of the same rule.
import { RETURN_ON_JOB_WHY } from "@/lib/job-cost-guard";
import { addOpenList } from "./open-list-actions";
import { applyBankDownload, forgetBankRule, setBankAccount, swapBankDownload, undoBankDownload } from "./bank-actions";
import { applyBankCore, bankLinesStayHere, bankViews, BANK_NEEDS_UPDATE } from "./bank-core";
import { describePaper, readinessOf } from "@/lib/paperwork";
import { fileItem, undoPaperwork } from "@/app/(app)/organize/actions";

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let seq = 0;
let missingBank = false;
/** 0375 not applied yet: bank_lines has no job_id, so asking for it or writing it fails the way
 *  PostgREST fails (an unknown column, an unknown key in the schema cache). */
let noJobColumn = false;

// bank_rules: one per merchant AND answer (0363's generated `answer` column, spelled out here).
const UNIQUE: Record<string, string[]> = {
  bank_lines: ["org_id", "line_key"],
  bank_rules: ["org_id", "direction", "merchant_key", "choice", "bucket", "supplier_account_id", "profile_id"],
};

function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const rows = (db[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let verb: "select" | "insert" | "update" | "delete" | "upsert" = "select";
      let payload: any = null;
      let one: "single" | "maybe" | null = null;
      let cap = Infinity;
      let range: [number, number] | null = null;
      let cols = "";
      let touchesBank = table === "bank_lines" || table === "bank_rules";
      const embed = (r: Row) => {
        const out = structuredClone(r);
        if (cols.includes("invoices(")) {
          const inv = (db.invoices ?? []).find((i) => i.id === r.invoice_id);
          out.invoices = inv ? { invoice_number: inv.invoice_number, status: inv.status } : null;
        }
        if (cols.includes("customers(")) {
          const c = (db.customers ?? []).find((x) => x.id === r.customer_id);
          out.customers = c ? { name: c.name ?? null, company_name: c.company_name ?? null } : null;
        }
        // The job a row names, for the readers that say which job in words (the same-purchase check).
        if (cols.includes("jobs(")) {
          const j = (db.jobs ?? []).find((x) => x.id === r.job_id);
          out.jobs = j ? { job_number: j.job_number ?? null, name: j.name ?? null } : null;
        }
        return out;
      };
      const run = () => {
        if (missingBank && touchesBank) return { data: null, error: { code: "42P01", message: 'relation "bank_lines" does not exist' } };
        // BEFORE 0375: the column isn't there. A read of it is an unknown column, and a write carrying
        // it is a key the schema cache has never heard of — which would fail the WHOLE insert.
        if (noJobColumn && table === "bank_lines") {
          if (verb === "select" && /job_id/.test(cols)) return { data: null, error: { code: "42703", message: 'column bank_lines.job_id does not exist' } };
          if ((verb === "insert" || verb === "upsert") && (Array.isArray(payload) ? payload : [payload]).some((r: Row) => r && "job_id" in r))
            return { data: null, error: { code: "PGRST204", message: "Could not find the 'job_id' column of 'bank_lines' in the schema cache" } };
        }
        if (verb === "insert" || verb === "upsert") {
          const list = (Array.isArray(payload) ? payload : [payload]).map((r: Row): Row => ({
            id: `${table}-${++seq}`,
            ...(table === "organized_items" && !r.org_id ? { org_id: state.orgId } : {}),
            ...structuredClone(r),
          }));
          const key = UNIQUE[table];
          const added: Row[] = [];
          for (const r of list) {
            if (table === "organized_items" && r.content_sha256 && rows.some((x) => x.org_id === r.org_id && x.content_sha256 === r.content_sha256))
              return { data: null, error: { code: "23505", message: "duplicate key value" } };
            if (key && rows.some((x) => key.every((k) => x[k] === r[k]))) {
              if (verb === "upsert") continue; // ON CONFLICT DO NOTHING
              return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${table}_key"` } };
            }
            rows.push(r);
            added.push(r);
          }
          return { data: one ? added[0] : added.map((r) => ({ ...r })), error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, cap);
        if (range) hit = hit.slice(range[0], range[1] + 1);
        if (verb === "update") {
          for (const r of hit) Object.assign(r, structuredClone(payload));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (verb === "delete") {
          db[table] = rows.filter((r) => !hit.includes(r));
          // ON DELETE SET NULL: a deleted bank line's marks come off the money rows (0363).
          if (table === "bank_lines") {
            const gone = new Set(hit.map((r) => r.id));
            for (const t of ["payments", "bills", "supplier_payments", "pay_payments", "petty_cash"]) for (const r of db[t] ?? []) if (gone.has(r.bank_line_id)) r.bank_line_id = null;
          }
          return { data: hit, error: null };
        }
        const out = hit.slice(0, 1000).map(embed);
        if (one) return { data: out[0] ?? null, error: null };
        return { data: out, error: null };
      };
      const chain: any = {
        select: (c?: string) => {
          cols = c ?? "";
          if (/bank_line_id/.test(cols)) touchesBank ||= false;
          return chain;
        },
        insert: (p: any) => {
          verb = "insert";
          payload = p;
          if (Array.isArray(p) ? p.some((r) => "bank_line_id" in r) : p && "bank_line_id" in p) touchesBank = true;
          return chain;
        },
        upsert: (p: any) => ((verb = "upsert"), (payload = p), chain),
        update: (p: any) => {
          verb = "update";
          payload = p;
          if (p && "bank_line_id" in p) touchesBank = true;
          return chain;
        },
        delete: () => ((verb = "delete"), chain),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), chain),
        not: (c: string, op: string, v: unknown) => (filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)), chain),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), chain),
        is: (c: string, v: unknown) => {
          if (c === "bank_line_id") touchesBank = true;
          filters.push((r) => (r[c] ?? null) === v);
          return chain;
        },
        gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), chain),
        lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), chain),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), chain),
        order: () => chain,
        limit: (n: number) => ((cap = n), chain),
        range: (a: number, b: number) => ((range = [a, b]), chain),
        single: () => ((one = "single"), chain),
        maybeSingle: () => ((one = "maybe"), chain),
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      };
      return chain;
    },
  };
}

// A MADE-UP checking download (Sep 2 - Sep 25, 2026).
// NEWEST FIRST, AND ITS RUNNING BALANCE WALKS, the way a bank's own month does: every balance is the
// one above it less that line's money. The figures were invented before anything checked them and did
// not add up; the one verification walks this column now, and a fixture that doesn't walk teaches
// whoever reads it next the wrong shape.
const CHECKING_CSV = `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance
XXXXX1234,09/24/2026,,DENTAL CARE LLC,150.00,,Posted,9829.57
XXXXX1234,09/18/2026,,STRIPE TRANSFER ST-AB12,,485.40,Posted,9979.57
XXXXX1234,09/16/2026,,1111-SHELL 123 ANYTOWN ST,100.00,,Posted,9494.17
XXXXX1234,09/12/2026,,1111-ACME INSURANCE CO,31.90,,Posted,9594.17
XXXXX1234,09/10/2026,,ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB0123456789,2000.00,,Posted,9626.07
XXXXX1234,09/09/2026,,1111-SHELL 456 OTHERTOWN,100.00,,Posted,11626.07
XXXXX1234,09/05/2026,1043,CHECK,640.00,,Posted,11726.07
XXXXX1234,09/04/2026,,DEPOSIT,,1275.00,Posted,12366.07
XXXXX1234,09/02/2026,,1111-SHELL 123 ANYTOWN ST,88.45,,Posted,11091.07
`;
// The next month's download overlaps it by a week and adds two new SHELL fills. Its balances carry on
// from the shared lines, because it is the same account.
const NEXT_CSV = `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance
XXXXX1234,10/02/2026,,1111-SHELL 789 ANYTOWN,88.10,,Posted,9681.47
XXXXX1234,09/28/2026,,1111-SHELL 123 ANYTOWN ST,60.00,,Posted,9769.57
XXXXX1234,09/24/2026,,DENTAL CARE LLC,150.00,,Posted,9829.57
XXXXX1234,09/18/2026,,STRIPE TRANSFER ST-AB12,,485.40,Posted,9979.57
XXXXX1234,09/16/2026,,1111-SHELL 123 ANYTOWN ST,100.00,,Posted,9494.17
`;

function seed() {
  seq = 0;
  missingBank = false;
  noJobColumn = false;
  db = {
    organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }],
    customers: [
      { id: "cust-1", org_id: "org-1", name: "Marla Finch", company_name: null },
      { id: "cust-2", org_id: "org-1", name: "Tess Zane", company_name: null },
    ],
    // The jobs a line may be put on: open, and finished (a line from June can belong to a job that is
    // complete now). Never a cancelled one, and never another company's.
    jobs: [
      { id: "job-kitchen", org_id: "org-1", job_number: "J-054", name: "41 Larkspur", status: "in_progress", customer_id: "cust-1", created_at: "2026-09-01T00:00:00Z" },
      { id: "job-done", org_id: "org-1", job_number: "J-040", name: "12 Thistle Wood", status: "complete", customer_id: "cust-2", created_at: "2026-06-01T00:00:00Z" },
      { id: "job-off", org_id: "org-1", job_number: "J-051", name: "9 Clover", status: "cancelled", customer_id: "cust-1", created_at: "2026-08-01T00:00:00Z" },
      { id: "job-theirs", org_id: "org-2", job_number: "J-900", name: "Another Company's Job", status: "in_progress", customer_id: null, created_at: "2026-09-01T00:00:00Z" },
    ],
    supplier_accounts: [
      { id: "acct-cs", org_id: "org-1", name: "Contractor Supply", account_number: "CS-12345", branch_code: null, on_account: true },
      { id: "acct-x", org_id: "org-2", name: "Someone Else's Supplier", account_number: "CS-12345", on_account: true },
    ],
    supplier_aliases: [],
    supplier_invoices: [],
    invoices: [
      { id: "inv-1", org_id: "org-1", invoice_number: "INV-1001", total: 1275, amount_paid: 0, status: "sent", tax_rate: 0 },
      { id: "inv-card1", org_id: "org-1", invoice_number: "INV-1002", total: 250, amount_paid: 250, status: "paid", tax_rate: 0 },
      { id: "inv-card2", org_id: "org-1", invoice_number: "INV-1003", total: 250, amount_paid: 250, status: "paid", tax_rate: 0 },
      // ANOTHER COMPANY, the same balance: never offered, never written.
      { id: "inv-x", org_id: "org-2", invoice_number: "INV-9", total: 1275, amount_paid: 0, status: "sent", tax_rate: 0 },
    ],
    invoice_items: [{ invoice_id: "inv-1", line_total: 1275 }],
    customer_credits: [],
    payments: [
      // One card payout (09/18) is these two, less Stripe's fees.
      { id: "pay-c1", org_id: "org-1", invoice_id: "inv-card1", amount: 250, paid_at: "2026-09-16T19:00:00Z", method: "card", processor_fee: 7.55, stripe_payment_intent: "pi_1", bank_line_id: null },
      { id: "pay-c2", org_id: "org-1", invoice_id: "inv-card2", amount: 250, paid_at: "2026-09-16T20:00:00Z", method: "card", processor_fee: 7.05, stripe_payment_intent: "pi_2", bank_line_id: null },
      { id: "pay-x", org_id: "org-2", invoice_id: "inv-x", amount: 1275, paid_at: "2026-09-03T19:00:00Z", method: "check", processor_fee: null, stripe_payment_intent: null, bank_line_id: null },
    ],
    profiles: [
      // The signed-in viewer (requireStaff's user-1): an owner.
      { id: "user-1", org_id: "org-1", full_name: "Owner Two", role: "owner", active: true },
      { id: "pat", org_id: "org-1", full_name: "Pat Crew", role: "tech", active: true },
      { id: "owner-1", org_id: "org-1", full_name: "Owner One", role: "owner", active: true },
      { id: "other-crew", org_id: "org-2", full_name: "Other Crew", role: "tech", active: true },
    ],
    pay_payments: [],
    supplier_payments: [],
    bills: [],
    petty_cash: [],
    bank_lines: [],
    bank_rules: [],
    organized_items: [],
  };
  state.client = fakeDb();
  state.orgId = "org-1";
}

async function drop(csv = CHECKING_CSV, name = "Checking.csv", sha: string | null = null) {
  const res = await addOpenList({ name, sha256: sha, table: parseCSV(csv), listDate: "2026-09-26", source: "bills_drop" });
  expect(res.ok).toBe(true);
  return res.id!;
}

async function view(id: string) {
  const views = await bankViews(state.client, "org-1", db.organized_items as any[]);
  return views[id];
}

const rowBy = (v: Awaited<ReturnType<typeof view>>, words: string) => v.rows.find((r) => r.title.includes(words))!;

beforeEach(seed);

describe("the door", () => {
  it("a bank's download dropped where paper goes becomes ONE card, and nothing else is written", async () => {
    const res = await addOpenList({ name: "Checking.csv", sha256: null, table: parseCSV(CHECKING_CSV), listDate: "2026-09-26", source: "bills_drop" });
    expect(res).toMatchObject({ ok: true, line: expect.stringMatching(/^Read as a bank download: 9 lines\./) });
    expect(db.organized_items).toHaveLength(1);
    const item = db.organized_items[0];
    expect(item).toMatchObject({ status: "needs_review", category: "Bank Download", doc_type: "statement", vendor: "Bank ••1234", file_url: null });
    // PRIVACY: what is kept holds no run of 6+ digits (the account, a reference number).
    const kept = item.proposal.bankImport.download;
    for (const l of kept.lines) expect(l.description).not.toMatch(/\d{6,}/);
    expect(JSON.stringify(item.proposal)).not.toContain("0123456789");
    expect(JSON.stringify(item.proposal)).not.toContain("XXXXX1234");
    // Nor does its name: a file named after the full account number keeps its last 4.
    const named = await addOpenList({ name: "Export_000123456789.csv", sha256: null, table: parseCSV(CHECKING_CSV.replace("DENTAL CARE LLC", "DENTAL CARE CO")), listDate: "2026-09-26", source: "bills_drop" });
    expect(named.ok).toBe(true);
    const row = db.organized_items.find((i) => i.id === named.id)!;
    expect(row.title).toBe("Export_••6789.csv");
    expect(JSON.stringify(row)).not.toContain("123456789");
    // Nothing is written until Apply: no line, no bill, no rule, no payment marked.
    expect(db.bank_lines).toHaveLength(0);
    expect(db.bills).toHaveLength(0);
    expect(db.bank_rules).toHaveLength(0);
    expect(db.payments.every((p) => p.bank_line_id === null)).toBe(true);
  });

  it("Money's bank door refuses a file that isn't a bank download; no door keeps a long number from one", async () => {
    const odd = `Account: 000123456789\nWhen,What,Out,In\n09/01/2026,ONLINE TRANSFER FROM SAVINGS 000123456789,,500.00\n`;
    const refused = await addOpenList({ name: "odd.csv", sha256: null, table: parseCSV(odd), listDate: "2026-09-26", source: "bills_drop", expect: "bank" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/^odd\.csv doesn't read as a bank download/) });
    expect(db.organized_items).toHaveLength(0);
    // The same file through Drop Paperwork waits for its columns, with every long number cut.
    const kept = await addOpenList({ name: "odd.csv", sha256: null, table: parseCSV(odd), listDate: "2026-09-26", source: "bills_drop" });
    expect(kept.ok).toBe(true);
    const stored = JSON.stringify(db.organized_items[0].proposal);
    expect(stored).not.toContain("123456789");
    expect(stored).toContain("••6789");
  });

  /**
   * A BANK'S TABLE THE READER COULD NOT MAKE A DOWNLOAD OF IS REFUSED AT EVERY DOOR (2026-10-02).
   *
   * Reconcile's statement line dropped `expect: "bank"` so it could take a supplier's list too, and
   * that took away the only refusal this file had: a headerless download with no minus sign in it is
   * not read as a bank's, so it fell through and was kept as a SUPPLIER'S list waiting for its
   * columns. The database holds that class to is_org_staff() — every office hand, including one the
   * owner switched off — while it holds a bank download to viewer_sorts_bank(), and the card samples
   * four of its lines. His dentist and his transfer to savings are not the office's business.
   *
   * So the refusal is in addOpenList now, where EVERY door gets it, and this is drawn from both: the
   * statement line on Reconcile ("bills_drop") and Snap Or Note ("organize"). All amounts positive
   * and no heading row: that is the file that walked through.
   */
  it("a bank's own lines with no headings over them are refused at every door, never kept as a supplier's card", async () => {
    const headerless = [
      "09/24/2026,DENTAL CARE LLC OFFICE VISIT,150.00",
      "09/18/2026,HARBOUR POINT HARDWARE #221,86.40",
      "09/12/2026,STREAMING SERVICE MONTHLY,15.99",
      "09/05/2026,ONLINE TRANSFER TO SAVINGS 000123456789,2000.00",
    ].join("\n");
    for (const source of ["bills_drop", "organize"] as const) {
      const res = await addOpenList({ name: "Stmt2.csv", sha256: null, table: parseCSV(headerless), listDate: "2026-09-26", source });
      expect(res.ok, source).toBe(false);
      expect(res.error, source).toMatch(/^Stmt2\.csv doesn't read as a bank download/);
      // AND NOTHING WAS STORED: no card, so no sample of his own spending under Needs You, and
      // nothing in the database for an office hand to read past the gate.
      expect(db.organized_items, source).toHaveLength(0);
    }
    // A supplier's own headerless list — paper numbers and amounts, no bank's description — is NOT
    // caught by this: it still waits for a person to point at its columns. The refusal is narrow.
    const supplierList = ["INV-4410,09/01/2026,250.00", "INV-4411,09/08/2026,118.75", "INV-4412,09/15/2026,64.20"].join("\n");
    const waits = await addOpenList({ name: "Portal.csv", sha256: null, table: parseCSV(supplierList), listDate: "2026-09-26", source: "bills_drop" });
    expect(waits.ok).toBe(true);
    expect(db.organized_items).toHaveLength(1);
    expect(db.organized_items[0].proposal.openList.needs).toBeTruthy();
  });

  it("a counter payment printed with only the branch is the supplier's, by the branch its papers carry", async () => {
    db.supplier_invoices.push(
      { id: "si-1", org_id: "org-1", supplier_account_id: "acct-cs", invoice_number: "4410-1100001", invoice_date: "2026-09-01" },
      { id: "si-2", org_id: "org-1", supplier_account_id: "acct-cs", invoice_number: "4410-1100002", invoice_date: "2026-09-03" },
    );
    const id = await drop(`Date,Description,Amount\n09/10/2026,1111-(PC) 4410 T  ANYTOWN CA,-500.00\n`, "Card1234.csv");
    const v = await view(id);
    expect(v.rows[0].buttons[0]).toEqual({ id: "supplier:acct-cs", label: "Pay Contractor Supply" });
  });

  it("a download longer than 5,000 rows is refused whole, never cut", async () => {
    const rows = [["Date", "Description", "Amount"], ...Array.from({ length: 5001 }, (_, i) => ["09/01/2026", `COFFEE CART ${i}`, "-4.50"])];
    const res = await addOpenList({ name: "Long.csv", sha256: null, table: rows, listDate: "2026-09-26", source: "bills_drop" });
    expect(res).toMatchObject({ ok: false, error: "Long.csv has more than 5,000 rows. Download a shorter date range and drop that." });
    expect(db.organized_items).toHaveLength(0);
  });

  it("the card sorts it against the books: the payout matched, the rest one row per merchant", async () => {
    const id = await drop();
    const v = await view(id);
    expect(v.problem).toBeNull();
    // Lines everywhere: 8 lines need a person, in 6 rows (the three SHELL fills are one row).
    expect(v.headline).toBe("Bank ••1234 · Sep 2–Sep 24 · 1 sorted · 8 need you, in 6 rows");
    const shell = rowBy(v, "SHELL");
    // The total of three different fills, said as a total (never "3×", which reads as each).
    expect(shell.money).toBe("3 charges · $288.45");
    expect(shell.buttons.map((b) => b.label)).toEqual(["Fuel", "Auto", "Personal"]);
    expect(rowBy(v, "Deposit").buttons.map((b) => b.label)).toEqual(["On INV-1001", "Other Income", "Already Counted Or Not Income"]);
    expect(rowBy(v, "Check 1043").buttons.map((b) => b.label)).toEqual(["Pay Pat Crew", "Personal"]);
    // Another company's supplier, invoice and crew are never offered.
    expect(JSON.stringify(v)).not.toMatch(/Someone Else|INV-9|Other Crew/);
    expect(v.otherOut.map((b) => b.label)).toContain("Pay Contractor Supply");
  });
});

describe("Swap Money In And Out", () => {
  it("flips a download nothing was applied from, and refuses once some of it is counted", async () => {
    const id = await drop(`Date,Description,Amount\n09/01/2026,SHELL OIL 9 ANYTOWN,62.10\n09/02/2026,COFFEE CART,4.50\n`, "card.csv");
    expect((await view(id)).rows.every((r) => r.direction === "in")).toBe(true);
    expect((await view(id)).canSwap).toBe(true);
    const res = await swapBankDownload(id);
    expect(res).toMatchObject({ ok: true, message: "Swapped: charges are money out now." });
    const v = await view(id);
    expect(v.swapped).toBe(true);
    expect(v.rows.every((r) => r.direction === "out")).toBe(true);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    expect(db.bills).toHaveLength(1);
    expect((await swapBankDownload(id)).error).toMatch(/Undo it first/);
  });

  it("a download with no account is told its last 4, four digits and no more", async () => {
    const id = await drop(`Date,Description,Amount\n09/30/2026,MONTHLY SERVICE FEE,-15.00\n`, "stmt.csv");
    expect((await view(id)).askAccount).toBe(true);
    expect((await setBankAccount(id, "123456")).ok).toBe(false);
    expect(await setBankAccount(id, "2222")).toMatchObject({ ok: true, message: "Saved: this download is the account ending 2222." });
    const v = await view(id);
    expect(v.askAccount).toBe(false);
    expect(v.headline).toMatch(/^Bank ••2222/);
    expect(db.organized_items[0].proposal.bankImport.download.lines[0].last4).toBe("2222");
  });
});

describe("Apply", () => {
  async function applyWithAnswers(id: string, leave: string[] = ["ACME INSURANCE"]) {
    const v = await view(id);
    const answer: Record<string, string> = {
      SHELL: "cost:Fuel",
      DENTAL: "personal",
      "ONLINE TRANSFER": "draw",
      Deposit: "invoice:inv-1",
      "Check 1043": "crew:pat",
      "ACME INSURANCE": "cost:Insurance & Licenses",
    };
    const picks: Record<string, string> = {};
    for (const [words, choice] of Object.entries(answer)) if (!leave.includes(words)) picks[rowBy(v, words).id] = choice;
    return { res: await applyBankDownload(id, { fingerprint: v.fingerprint, picks }), v };
  }

  it("writes what the card showed: fuel bills, the payment, crew pay, the payout's marks, the rules; a row left alone waits", async () => {
    const id = await drop();
    const { res } = await applyWithAnswers(id);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^Applied: 8 lines counted, 1 matched to what was already here, 7 you answered\. 1 left for later is not counted yet/);
    // It says what it remembered, and for which amounts.
    expect(res.message).toContain("Remembered for next time: DENTAL CARE LLC → Personal ($150.00); SHELL 123 ANYTOWN ST → Fuel ($88.45 to $100.00)");

    const lines = db.bank_lines;
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l.org_id === "org-1" && l.import_id === id && !/\d{6,}/.test(l.description))).toBe(true);
    expect(lines.find((l) => l.description.includes("TRANSFER TO CHK"))).toMatchObject({ choice: "draw", sorted_by: "person", amount: -2000 });
    expect(lines.find((l) => l.description.includes("DENTAL"))).toMatchObject({ choice: "personal" });
    expect(lines.find((l) => l.description.includes("STRIPE"))).toMatchObject({ choice: "matched", sorted_by: "match" });

    // FUEL: three paid business costs in Add Business Cost's shape, in the Fuel bucket, each marked.
    expect(db.bills).toHaveLength(3);
    for (const b of db.bills) {
      expect(b).toMatchObject({ org_id: "org-1", job_id: null, status: "paid", category: "Fuel" });
      expect(b).not.toHaveProperty("cost_kind");
      expect(lines.some((l) => l.id === b.bank_line_id && l.choice === "cost" && l.bucket === "Fuel")).toBe(true);
    }
    for (const l of lines) {
      expect(l).not.toHaveProperty("cost_kind");
      expect(l).not.toHaveProperty("matched_kind");
    }
    expect(db.bills.map((b) => b.amount).sort()).toEqual([100, 100, 88.45]);

    // OWNER'S DRAW AND PERSONAL: the bank line only. Never a bill, never crew pay.
    expect(db.bills.some((b) => /TRANSFER|DENTAL/.test(b.supplier))).toBe(false);

    // The deposit on INV-1001, dated the bank's day, marked; the invoice recomputed to paid.
    const pay = db.payments.find((p) => p.invoice_id === "inv-1")!;
    expect(pay).toMatchObject({ org_id: "org-1", amount: 1275, method: "check" });
    expect(pay.paid_at.slice(0, 10)).toBe("2026-09-04");
    expect(db.invoices.find((i) => i.id === "inv-1")).toMatchObject({ amount_paid: 1275, status: "paid" });

    // No money row carries the file's name.
    for (const t of ["bills", "payments", "pay_payments"]) for (const r of db[t]) expect(String(r.note ?? r.notes ?? "")).not.toContain("Checking.csv");
    expect(db.bills[0].notes).toBe("From the bank download (••1234) of Sep 2–Sep 24.");

    // The check to Pat, as crew pay with its number. Pat can read this row: its note says where it
    // came from and nothing of the company's account.
    expect(db.pay_payments).toEqual([expect.objectContaining({ org_id: "org-1", profile_id: "pat", amount: 640, reference: "1043", method: "check", note: "Recorded from a bank download." })]);

    // The payout MARKED the two card payments; nothing new was written for them.
    const payout = lines.find((l) => l.description.includes("STRIPE"))!;
    expect(db.payments.filter((p) => p.bank_line_id === payout.id).map((p) => p.id).sort()).toEqual(["pay-c1", "pay-c2"]);
    expect(db.payments).toHaveLength(4);

    // RULES from the taps, one per merchant; never from the deposit's invoice or the check.
    expect(db.bank_rules.map((r) => [r.direction, r.merchant_key, r.choice, r.bucket]).sort()).toEqual([
      ["out", "dental", "personal", null],
      ["out", "shell", "cost", "Fuel"],
      ["out", "transfer 9876", "draw", null],
    ]);
    expect(db.bank_rules.some((r) => "cost_kind" in r)).toBe(false);
    expect(db.bank_rules.every((r) => r.learned_import_id === id && r.org_id === "org-1")).toBe(true);
    expect(db.bank_rules.find((r) => r.merchant_key === "shell")).toMatchObject({ min_cents: 8845, max_cents: 10000 });

    // ANOTHER COMPANY'S ROWS: untouched.
    expect(db.payments.find((p) => p.id === "pay-x")!.bank_line_id).toBeNull();
    expect(db.invoices.find((i) => i.id === "inv-x")!.amount_paid).toBe(0);

    // The row left for later keeps the card under Needs You, named as not counted.
    expect(db.organized_items[0].status).toBe("needs_review");
    const after = await view(id);
    expect(after.rows.map((r) => r.title)).toEqual(["ACME INSURANCE CO"]);
    expect(after.headline).toBe("Bank ••1234 · Sep 2–Sep 24 · 8 already in North · 1 need you");
    expect(after.appliedSaid).toMatch(/1 line left for later is not counted yet/);
    expect(after.canUndo).toBe(true);
  });

  it("answering the last row files the card", async () => {
    const id = await drop();
    await applyWithAnswers(id, []);
    expect(db.organized_items[0].status).toBe("filed");
    expect(db.organized_items[0].proposal.filed).toEqual({ how: "bank_download" });
    expect(db.bills.find((b) => b.category === "Insurance & Licenses")).toMatchObject({ amount: 31.90 });
  });

  it("a stale card writes nothing; two presses write once", async () => {
    const id = await drop();
    const v = await view(id);
    // The books move under the card: someone records the deposit's payment by hand.
    db.payments.push({ id: "pay-hand", org_id: "org-1", invoice_id: "inv-1", amount: 1275, paid_at: "2026-09-03T19:00:00Z", method: "check", processor_fee: null, stripe_payment_intent: null, bank_line_id: null });
    const stale = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: {} });
    expect(stale).toMatchObject({ ok: false, stale: true });
    expect(db.bank_lines).toHaveLength(0);

    const fresh = await view(id);
    const shell = rowBy(fresh, "SHELL").id;
    const [a, b] = await Promise.all([
      applyBankDownload(id, { fingerprint: fresh.fingerprint, picks: { [shell]: "cost:Fuel" } }),
      applyBankDownload(id, { fingerprint: fresh.fingerprint, picks: { [shell]: "cost:Fuel" } }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)!.error).toMatch(/applied from another screen|already applied/);
    expect(db.bills).toHaveLength(3);
    expect(new Set(db.bank_lines.map((l) => l.line_key)).size).toBe(db.bank_lines.length);
  });

  it("a person's Pay Pat on a line whose payment to Pat is already recorded marks it, never writes a second", async () => {
    db.pay_payments.push({ id: "pp-rec", org_id: "org-1", profile_id: "pat", amount: 150, paid_on: "2026-09-26", reference: null, voided_at: null, bank_line_id: null });
    const id = await drop();
    const v = await view(id);
    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "DENTAL").id]: "crew:pat" } });
    expect(res.message).toMatch(/1 crew payment was already recorded, so it was marked, never written twice\./);
    expect(db.pay_payments).toHaveLength(1);
    const line = db.bank_lines.find((l) => l.description.includes("DENTAL"))!;
    expect(line).toMatchObject({ choice: "matched", sorted_by: "person" });
    expect(db.pay_payments[0].bank_line_id).toBe(line.id);
    // Undo takes the mark off and leaves the payment as it was.
    await undoBankDownload(id);
    expect(db.pay_payments[0]).toMatchObject({ bank_line_id: null, voided_at: null });
  });

  it("a person's On INV-1001 on a deposit already recorded as a payment on INV-1001 marks that payment, never writes a second", async () => {
    // INV-1001 was billed at $2,550 and half paid by check, written down 4 days AFTER the bank posted
    // it: the $1,275 still open is the deposit's money, and no sure match reaches that far.
    Object.assign(db.invoices.find((i) => i.id === "inv-1")!, { total: 2550, amount_paid: 1275, status: "partial" });
    db.invoice_items = [{ invoice_id: "inv-1", line_total: 2550 }];
    db.payments.push({ id: "pay-rec", org_id: "org-1", invoice_id: "inv-1", amount: 1275, paid_at: "2026-09-08T19:00:00Z", method: "check", processor_fee: null, stripe_payment_intent: null, bank_line_id: null });
    const id = await drop();
    const v = await view(id);
    const dep = rowBy(v, "Deposit");
    // Already Counted is the guess, and the invoice a tap away.
    expect(dep.buttons.map((b) => b.id)).toEqual(["not_income", "invoice:inv-1", "other_income"]);
    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [dep.id]: "invoice:inv-1" } });
    expect(res.message).toMatch(/1 deposit was already a payment on its invoice, so that payment was marked, never written twice\./);
    expect(db.payments.filter((p) => p.invoice_id === "inv-1").map((p) => p.id)).toEqual(["pay-rec"]);
    const line = db.bank_lines.find((l) => l.description === "DEPOSIT")!;
    expect(line).toMatchObject({ choice: "matched", sorted_by: "person", invoice_id: null });
    expect(db.payments.find((p) => p.id === "pay-rec")!.bank_line_id).toBe(line.id);
    expect(db.invoices.find((i) => i.id === "inv-1")).toMatchObject({ amount_paid: 1275, status: "partial" });
    // Undo takes the mark off and leaves the payment as it was.
    await undoBankDownload(id);
    expect(db.payments.find((p) => p.id === "pay-rec")).toMatchObject({ bank_line_id: null, amount: 1275 });
  });

  it("a refund put back on its bucket is a negative business cost, and Undo takes it off", async () => {
    const id = await drop(`Date,Description,Amount\n09/13/2026,ACME TOOLS RETURN,30.00\n`, "Refund1234.csv");
    const v = await view(id);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "ACME TOOLS").id]: "cost:Tools & Supplies" } });
    expect(db.bills).toEqual([expect.objectContaining({ job_id: null, amount: -30, category: "Tools & Supplies" })]);
    expect(db.bank_rules).toHaveLength(0);
    await undoBankDownload(id);
    expect(db.bills).toHaveLength(0);
  });

  it("refuses an answer that doesn't fit, and writes nothing", async () => {
    const id = await drop();
    const v = await view(id);
    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "other_income", [rowBy(v, "Deposit").id]: "invoice:inv-x" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Nothing was written\./);
    expect(db.bank_lines).toHaveLength(0);
    expect(db.organized_items[0].status).toBe("needs_review");
  });
});

/**
 * A BANK LINE CAN GO ON THE JOB IT WAS FOR (0375, Erik 2026-10-02). The $340 of wire bought at the
 * counter for one kitchen used to have no answer but a business bucket, so it became OVERHEAD, the job
 * never saw the cost, and Gross Profit read high by exactly that much. A job line writes the same
 * bills row a receipt filed on that job writes — job_id set, no bucket beside it — which owner-money
 * splits with `if (b.job_id)` into Materials & Bills inside Cost Of Goods Sold.
 */
describe("a line put on the job it was for", () => {
  const SUPPLY = `Date,Description,Amount\n09/12/2026,ANYTOWN WIRE HOUSE #4,-340.55\n`;
  const CREDIT = `Date,Description,Amount\n09/19/2026,ANYTOWN WIRE HOUSE #4 CREDIT,22.80\n`;

  it("offers only this company's jobs, each said in full, and writes the money onto the job with no bucket", async () => {
    const id = await drop(SUPPLY, "Card1234.csv");
    const v = await view(id);
    // THE LIST: open and finished jobs, said as the place, the number AND who. Never a cancelled job,
    // never another company's, and never a quick button (there is no way to guess WHICH job).
    expect(v.otherOutSingle.find((b) => b.id === "job:job-kitchen")!.label).toBe("On 41 Larkspur · J-054 — Marla Finch");
    expect(v.otherOutSingle.map((b) => b.id)).toContain("job:job-done");
    expect(JSON.stringify(v)).not.toContain("job-off");
    expect(JSON.stringify(v)).not.toContain("job-theirs");
    expect(v.rows[0].buttons.some((b) => b.id.startsWith("job:"))).toBe(false);

    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [v.rows[0].id]: "job:job-kitchen" } });
    expect(res.ok).toBe(true);
    const line = db.bank_lines[0];
    expect(line).toMatchObject({ choice: "job", job_id: "job-kitchen", bucket: null, sorted_by: "person", amount: -340.55 });
    // THE MONEY ROW: on the job, category NULL (the job already decides), the bank's day, marked.
    expect(db.bills).toEqual([
      expect.objectContaining({ org_id: "org-1", job_id: "job-kitchen", category: null, amount: 340.55, status: "paid", bill_date: "2026-09-12", bank_line_id: line.id }),
    ]);
    // NEVER A RULE: "the wire house is always this job" is never true (0375 leaves bank_rules alone).
    expect(db.bank_rules).toHaveLength(0);
    // AND WHERE THE MONEY WENT draws it as the job cost it is, in the profit and loss's own words:
    // the next download of the same week counts this line as already in North, and says so.
    const again = await drop(SUPPLY, "Card1234-again.csv");
    expect((await view(again)).flow).toEqual([{ key: "materials", label: "Materials & Bills", cents: 34055 }]);

    // UNDO takes a job bill off exactly as it takes a business cost off.
    expect((await undoBankDownload(id)).ok).toBe(true);
    expect(db.bills).toHaveLength(0);
    expect(db.bank_lines).toHaveLength(0);
  });

  /**
   * A CREDIT BACK FROM THE SUPPLY HOUSE IS NEVER PUT ON A JOB FROM HERE (lib/job-cost-guard, audit
   * v994's DB4). A bank line carries no lines, so bills{job_id, amount: -22.80} with none under it is a
   * supplier return the importer credits to the customer IN FULL and at markup — $22.80 off her bill,
   * plus markup, for parts nothing says she was ever charged for. The guard refuses that row at the
   * typing and paper doors; this door asks it too, at the card AND at the write.
   */
  it("a credit back from the supply house is never put on a job, and nothing is written", async () => {
    const id = await drop(CREDIT, "Card1234.csv");
    const v = await view(id);
    const row = v.rows[0];
    expect(row.direction).toBe("in");
    // NO DEAD DOOR: no job is drawn on a money-in row at all — a bucket refund is, and reads plainly.
    expect(JSON.stringify(row.others)).not.toContain("job:");
    expect(JSON.stringify(v.otherInSingle)).not.toContain("job:");
    expect(JSON.stringify(v.otherIn)).not.toContain("job:");
    expect(row.others!.some((b) => b.label === "Refund: Tools & Supplies")).toBe(true);
    // AND A PICK THAT NEVER CAME FROM A BUTTON IS REFUSED, in the guard's own words. Nothing lands:
    // no bill, no bank line, and the card is still waiting.
    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [row.id]: "job:job-kitchen" } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(RETURN_ON_JOB_WHY);
    expect(db.bills).toHaveLength(0);
    expect(db.bank_lines).toHaveLength(0);
    expect(db.organized_items[0].status).toBe("needs_review");
    // THE CREDIT STILL HAS A HOME: off the bucket it was bought on, as a negative business cost.
    expect((await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [row.id]: "cost:Tools & Supplies" } })).ok).toBe(true);
    expect(db.bills).toEqual([expect.objectContaining({ job_id: null, category: "Tools & Supplies", amount: -22.8 })]);
  });

  /**
   * AND THE SAME RULE AT THE WRITE, behind the card (lib/bills-write-guard.test.ts holds bank-core to
   * it). validPicks refuses the answer, so today nothing gets past it to writeBills — which is exactly
   * why the write asks the guard too: the day somebody adds a way for a stored answer to reach the
   * write without going through validPicks, the money still cannot land on the job. A job cost going
   * OUT is never touched by it, and the test above pins that it is still written.
   */
  it("asks the cost guard at the write as well, not only at the card", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(app)/bills/bank-core.ts", "utf8");
    expect(src).toContain("jobCostRefusal({ jobId: all[i].job_id, amount: all[i].amount, lines: [] }, JOB_REFUND_NEXT)");
  });

  it("a job bill somebody moved to another job since stays, and says so", async () => {
    const id = await drop(SUPPLY, "Card1234.csv");
    const v = await view(id);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [v.rows[0].id]: "job:job-kitchen" } });
    db.bills[0].job_id = "job-done";
    const res = await undoBankDownload(id);
    expect(res.message).toMatch(/its bill was changed since, so it stays/);
    expect(db.bills).toHaveLength(1);
    expect(db.bank_lines).toHaveLength(1);
  });

  it("refuses another company's job, and writes nothing", async () => {
    const id = await drop(SUPPLY, "Card1234.csv");
    const v = await view(id);
    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [v.rows[0].id]: "job:job-theirs" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/that job isn't one of yours/);
    expect(db.bills).toHaveLength(0);
    expect(db.bank_lines).toHaveLength(0);
    expect(db.organized_items[0].status).toBe("needs_review");
  });

  /**
   * BEFORE 0375 LANDS (the migration is additive and may land after this code): bank_lines has no
   * job_id, so no job is offered anywhere, no write mentions the column — a key the schema cache has
   * never heard of fails the WHOLE insert, every line of it — and the card says not one word about a
   * feature that isn't there yet.
   */
  it("before the database can hold a job, no job is offered, nothing throws, and every other answer still works", async () => {
    noJobColumn = true;
    const id = await drop(SUPPLY, "Card1234.csv");
    const v = await view(id);
    expect(v.problem).toBeNull();
    expect(JSON.stringify(v)).not.toContain("job:");
    expect(JSON.stringify(v)).not.toContain("J-054");
    // A hand-made job pick is refused, not attempted.
    expect(await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [v.rows[0].id]: "job:job-kitchen" } })).toMatchObject({ ok: false });
    expect(db.bank_lines).toHaveLength(0);
    // And the everyday answer writes as always: the line's row never carries the column.
    const ok = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [v.rows[0].id]: "cost:Tools & Supplies" } });
    expect(ok.ok).toBe(true);
    expect(ok.message).not.toMatch(/database update/);
    expect(db.bills).toEqual([expect.objectContaining({ job_id: null, category: "Tools & Supplies", amount: 340.55 })]);
    expect("job_id" in db.bank_lines[0]).toBe(false);
    // Undo runs too: it never asks for a column that isn't there.
    expect((await undoBankDownload(id)).ok).toBe(true);
    expect(db.bills).toHaveLength(0);
    expect(db.bank_lines).toHaveLength(0);
  });
});

describe("the next download", () => {
  it("counts what the first wrote as already in North, and sorts by the answers the first taught", async () => {
    const first = await drop();
    const v = await view(first);
    const shell = rowBy(v, "SHELL").id;
    const dental = rowBy(v, "DENTAL").id;
    await applyBankDownload(first, { fingerprint: v.fingerprint, picks: { [shell]: "cost:Fuel", [dental]: "personal" } });
    const next = await drop(NEXT_CSV, "Next.csv");
    const nv = await view(next);
    // 3 overlap (DENTAL, STRIPE, SHELL 9/16); the two new SHELL fills go by the rule; nothing asks.
    expect(nv.headline).toBe("Bank ••1234 · Sep 16–Oct 2 · 2 sorted · 3 already in North · nothing needs you");
    expect(nv.sorted).toEqual([{ label: "Fuel (Your Rule)", n: 2, cents: -14810 }]);
    const res = await applyBankDownload(next, { fingerprint: nv.fingerprint, picks: {} });
    expect(res.ok).toBe(true);
    expect(db.bills).toHaveLength(5);
    expect(db.bank_rules.find((r) => r.merchant_key === "shell")!.uses).toBe(2);
    expect(db.organized_items.find((i) => i.id === next)!.status).toBe("filed");
  });

  it("the same weeks downloaded again in another format count once: no second fuel bill", async () => {
    const first = await drop();
    const v = await view(first);
    await applyBankDownload(first, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    expect(db.bills).toHaveLength(3);
    // The bank's QFX of the same days: its own ids, its own words for the same fill-ups.
    const qfx = [
      ["Account", "Date", "Description", "Amount", "Check", "Id"],
      ["000099991234", "2026-09-16", "SHELL 123 ANYTOWN ST", "-100.00", "", "F-0916"],
      ["000099991234", "2026-09-28", "SHELL 789 ANYTOWN", "-70.00", "", "F-0928"],
    ];
    const res = await addOpenList({ name: "Checking.qfx", sha256: null, table: qfx, listDate: "2026-09-29", source: "bills_drop" });
    const nv = await view(res.id!);
    expect(nv.headline).toMatch(/1 sorted · 1 already in North/);
    await applyBankDownload(res.id!, { fingerprint: nv.fingerprint, picks: {} });
    expect(db.bills).toHaveLength(4);
  });

  it("the same file dropped twice is Already In", async () => {
    const sha = "a".repeat(64);
    await drop(CHECKING_CSV, "Checking.csv", sha);
    const again = await addOpenList({ name: "Checking.csv", sha256: sha, table: parseCSV(CHECKING_CSV), listDate: "2026-09-26" });
    expect(again.ok).toBe(false);
    expect(again.already).toMatch(/^Already In/);
    expect(db.organized_items).toHaveLength(1);
  });
});

describe("a fill-up already on the books", () => {
  it("is matched, keeps the bucket a person filed it in, and Undo takes only the mark off", async () => {
    const first = await drop();
    const v = await view(first);
    await applyBankDownload(first, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    // A pump receipt filed from Organize as Fuel before the next download, and one a person filed
    // as Auto: the company's Fuel answer for SHELL never re-files the second.
    db.bills.push({ id: "b-receipt", org_id: "org-1", job_id: null, supplier: "Shell", amount: 60, bill_date: "2026-09-28", category: "Fuel", bank_line_id: null, superseded_by_bill_id: null });
    const next = await drop(NEXT_CSV, "Next.csv");
    const nv = await view(next);
    await applyBankDownload(next, { fingerprint: nv.fingerprint, picks: {} });
    const receipt = db.bills.find((b) => b.id === "b-receipt")!;
    expect(receipt.category).toBe("Fuel");
    expect(db.bank_lines.find((l) => l.id === receipt.bank_line_id)).toMatchObject({ choice: "matched", bucket: null });
    await undoBankDownload(next);
    expect(db.bills.find((b) => b.id === "b-receipt")).toMatchObject({ category: "Fuel", bank_line_id: null });
  });

  it("a receipt filed as Auto stays Auto when its line matches, whatever the merchant's answer says", async () => {
    const first = await drop();
    const v = await view(first);
    await applyBankDownload(first, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    db.bills.push({ id: "b-oil", org_id: "org-1", job_id: null, supplier: "Shell", amount: 60, bill_date: "2026-09-28", category: "Auto", bank_line_id: null, superseded_by_bill_id: null });
    const next = await drop(NEXT_CSV, "Next.csv");
    const nv = await view(next);
    await applyBankDownload(next, { fingerprint: nv.fingerprint, picks: {} });
    expect(db.bills.find((b) => b.id === "b-oil")).toMatchObject({ category: "Auto" });
    expect(db.bills.find((b) => b.id === "b-oil")!.bank_line_id).not.toBeNull();
  });
});

describe("a receipt snapped after the download", () => {
  it("is found on the books by its money and day, and File It asks instead of writing a second cost", async () => {
    const id = await drop();
    const v = await view(id);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    expect(db.bills).toHaveLength(3);
    db.organized_items.push({
      id: "pump",
      org_id: "org-1",
      kind: "receipt",
      status: "needs_review",
      doc_type: "receipt",
      title: "Shell receipt",
      vendor: "Shell",
      amount: 100,
      item_date: "2026-09-17",
      payment: "paid_at_purchase",
      proposal: {},
    });
    const res = await fileItem("pump", { type: "overhead", category: "Fuel" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Already on the books: 1111-SHELL 123 ANYTOWN ST, \$100\.00, 2026-09-16, from the bank download/);
    expect(res.error).toMatch(/Different Purchase: File It Anyway/);
    expect(db.bills).toHaveLength(3);
  });

  /**
   * THE COUNTER RECEIPT FOR A LINE PUT ON A JOB (0375). The wire was bought at the counter for one
   * kitchen and the bank line was put on that job. Two days later the receipt for the SAME purchase is
   * snapped and filed on the same job. Nothing printed on either carries a number the other has, so
   * only money and day can find it — and the same-purchase check used to skip every bill with a job,
   * because a bank line could never have one. It wrote a second $340.55 bill on J-054: the job cost
   * doubled, and on a time-and-material job the customer was billed for it twice.
   */
  it("the receipt for a line already put on a job is refused, names that job, and writes no second cost", async () => {
    const id = await drop(`Date,Description,Amount\n09/12/2026,ANYTOWN WIRE HOUSE #4,-340.55\n`, "Card1234.csv");
    const v = await view(id);
    expect((await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [v.rows[0].id]: "job:job-kitchen" } })).ok).toBe(true);
    expect(db.bills).toHaveLength(1);
    db.organized_items.push({
      id: "counter",
      org_id: "org-1",
      kind: "receipt",
      status: "needs_review",
      doc_type: "receipt",
      title: "Wire house counter receipt",
      vendor: "Anytown Wire House",
      amount: 340.55,
      item_date: "2026-09-14",
      payment: "paid_at_purchase",
      proposal: {},
    });
    const res = await fileItem("counter", { type: "job", jobId: "job-kitchen" });
    expect(res.ok).toBe(false);
    // SAID AS THE JOB IT IS ON, never a bare number (Erik: "i cant tell by job numbers alone").
    expect(res.error).toMatch(/^Already on the books: ANYTOWN WIRE HOUSE #4, \$340\.55, 2026-09-12, from the bank download, on J-054 41 Larkspur\./);
    expect(res.error).toMatch(/Same Purchase: Tie Them/);
    expect(db.bills).toHaveLength(1);
  });

  // Review of release/v1026: a company's fill-ups loaded by hand from a bank export before the bank
  // door carry no bank_line_id, so the check never saw them and the pump receipt filed a second cost.
  it("a fill-up already on the books by hand (no bank line, no number) is found the same way; a job's bill or a numbered one is not", async () => {
    db.bills.push(
      { id: "hand-fuel", org_id: "org-1", job_id: null, supplier: "SHELL OIL ANYTOWN", bill_number: null, supplier_invoice_number: null, amount: 54.2, bill_date: "2026-09-20", category: "Fuel", status: "paid", superseded_by_bill_id: null, bank_line_id: null },
      { id: "job-bill", org_id: "org-1", job_id: "job-1", supplier: "SHELL OIL ANYTOWN", bill_number: null, supplier_invoice_number: null, amount: 77.7, bill_date: "2026-09-20", category: "Fuel", status: "paid", superseded_by_bill_id: null, bank_line_id: null },
      { id: "other-co", org_id: "org-2", job_id: null, supplier: "SHELL OIL ANYTOWN", bill_number: null, supplier_invoice_number: null, amount: 33.3, bill_date: "2026-09-20", category: "Fuel", status: "paid", superseded_by_bill_id: null, bank_line_id: null },
    );
    const pump = (id: string, amount: number) =>
      db.organized_items.push({ id, org_id: "org-1", kind: "receipt", status: "needs_review", doc_type: "receipt", title: "Shell receipt", vendor: "Shell", amount, item_date: "2026-09-21", payment: "paid_at_purchase", proposal: {} });
    pump("pump-1", 54.2);
    const res = await fileItem("pump-1", { type: "overhead", category: "Fuel" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Already on the books: SHELL OIL ANYTOWN, \$54\.20, 2026-09-20, a business cost with no number\./);
    expect(db.bills).toHaveLength(3);
    // A job's bill of the same money, or another company's, is not this purchase.
    pump("pump-2", 77.7);
    pump("pump-3", 33.3);
    expect(await fileItem("pump-2", { type: "overhead", category: "Fuel" })).toMatchObject({ ok: true });
    expect(await fileItem("pump-3", { type: "overhead", category: "Fuel" })).toMatchObject({ ok: true });
  });
});

describe("a merchant with two answers", () => {
  const STORE = (rows: string) => `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance\n${rows}`;

  it("a fill-up and a coffee at one store are two rows, two answers, and each is placed only near its own amounts", async () => {
    const id = await drop(
      STORE(`XXXXX1234,09/02/2026,,1111-CORNER STORE ANYTOWN,138.62,,Posted,1000.00
XXXXX1234,09/05/2026,,1111-CORNER STORE ANYTOWN,13.31,,Posted,986.69
XXXXX1234,09/12/2026,,1111-CORNER STORE ANYTOWN,120.00,,Posted,866.69
`),
      "Store1234.csv",
    );
    const v = await view(id);
    const rows = v.rows.filter((r) => r.title.includes("CORNER STORE"));
    expect(rows.map((r) => r.money)).toEqual(["2 charges · $258.62", "$13.31"]);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rows[0].id]: "cost:Fuel", [rows[1].id]: "cost:Other" } });
    expect(db.bank_rules.map((r) => [r.choice, r.bucket, r.min_cents, r.max_cents]).sort()).toEqual([
      ["cost", "Fuel", 12000, 13862],
      ["cost", "Other", 1331, 1331],
    ]);
    // Next month: a fill-up and a coffee go by their own answers; a $40 purchase, far from both, asks
    // with the nearest answer as the guess.
    const next = await drop(
      STORE(`XXXXX1234,10/02/2026,,1111-CORNER STORE ANYTOWN,110.00,,Posted,700.00
XXXXX1234,10/03/2026,,1111-CORNER STORE ANYTOWN,9.80,,Posted,690.20
XXXXX1234,10/04/2026,,1111-CORNER STORE ANYTOWN,40.00,,Posted,650.20
`),
      "Store1234-oct.csv",
    );
    const nv = await view(next);
    expect(nv.sorted.map((s) => [s.label, s.n])).toEqual([
      ["Fuel (Your Rule)", 1],
      ["Other (Your Rule)", 1],
    ]);
    expect(nv.rows).toHaveLength(1);
    expect(nv.rows[0].guess).toBe("cost:Fuel");
    expect(nv.rules.map((r) => r.label)).toEqual(["CORNER → Fuel ($120.00 to $138.62)", "CORNER → Other ($13.31)"]);
  });

  it("Forget takes an answer off, and its lines are asked again", async () => {
    const id = await drop();
    const v = await view(id);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    const next = await drop(NEXT_CSV, "Next.csv");
    const before = await view(next);
    expect(before.rules).toHaveLength(1);
    const res = await forgetBankRule(before.rules[0].id);
    expect(res).toMatchObject({ ok: true, message: "Forgotten: SHELL is asked again from now on." });
    const after = await view(next);
    expect(after.rules).toHaveLength(0);
    expect(after.rows.some((r) => r.title.includes("SHELL"))).toBe(true);
  });
});

describe("Undo", () => {
  it("takes back only what the download wrote, and the card waits again with every line", async () => {
    const id = await drop();
    const v = await view(id);
    const picks = {
      [rowBy(v, "SHELL").id]: "cost:Fuel",
      [rowBy(v, "Deposit").id]: "invoice:inv-1",
      [rowBy(v, "Check 1043").id]: "crew:pat",
      [rowBy(v, "ONLINE TRANSFER").id]: "draw",
    };
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks });
    // A person changes one fuel bill afterwards (moves it onto a job): that one stays.
    db.bills[0].job_id = "job-1";
    const res = await undoBankDownload(id);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^Undone: 6 lines came off, and the download waits again\. Left as they are now: .*its bill was changed since/);
    expect(db.bills).toHaveLength(1); // the one a person changed
    expect(db.bank_lines).toHaveLength(1); // its line stays counted
    expect(db.payments.find((p) => p.invoice_id === "inv-1")).toBeUndefined();
    expect(db.invoices.find((i) => i.id === "inv-1")).toMatchObject({ amount_paid: 0 });
    // Crew pay is voided, never deleted.
    expect(db.pay_payments).toHaveLength(1);
    expect(db.pay_payments[0].voided_at).toBeTruthy();
    // The payout's marks came off; the payments themselves stay.
    expect(db.payments.filter((p) => p.id === "pay-c1" || p.id === "pay-c2").map((p) => p.bank_line_id)).toEqual([null, null]);
    expect(db.bank_rules).toHaveLength(0);
    expect(db.organized_items[0]).toMatchObject({ status: "needs_review" });
    expect(db.organized_items[0].proposal.bankImport.applied).toBeNull();
  });

  /**
   * CASH TAKEN OUT (NOT A COST) (Erik, 2026-09-27; W1-34): an ATM line is guessed as it, and applying
   * it writes NO petty-cash row (the cash counts when its receipts come in). Its line is kept under
   * the word 0363 allows, and Undo takes the line off.
   */
  it("an ATM line guesses Cash Taken Out, and applying it writes no petty-cash row", async () => {
    const id = await drop(`Date,Description,Amount\n09/15/2026,ATM WITHDRAWAL MAIN ST,-200.00\n09/16/2026,ATM WITHDRAWAL MAIN ST,-100.00\n`, "Atm1234.csv");
    const v = await view(id);
    expect(v.rows.map((r) => r.guess)).toEqual(v.rows.map(() => "cash_out"));
    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: Object.fromEntries(v.rows.map((r) => [r.id, "cash_out"])) });
    expect(res.ok).toBe(true);
    expect(db.petty_cash ?? []).toHaveLength(0);
    expect(db.bank_lines.map((l) => l.choice)).toEqual(["petty_cash", "petty_cash"]);
    // Not a cost either: no bill.
    expect(db.bills ?? []).toHaveLength(0);
    await undoBankDownload(id);
    expect(db.bank_lines).toHaveLength(0);
    expect(db.petty_cash ?? []).toHaveLength(0);
  });

  /**
   * MONEY IN FROM THE OWNER (0376), the mirror of Owner's Draw. It writes NO income row and NO cost row:
   * the bank line IS the record, and the profit and loss reads it back as equity below Net Profit. And
   * unlike a job or Other Income it MAY be learned as a rule, because "a transfer from my own other
   * account is money I put in" is true of that account every time - which the apply loop used to refuse
   * with a line of its own ("money in teaches only Not Income"), one line away from the list that decides.
   */
  it("a deposit answered Owner's Money In writes nothing, and IS remembered as a rule", async () => {
    const id = await drop(`Date,Description,Amount\n09/12/2026,ONLINE TRANSFER FROM CHK XXXXXX9876 REF #IB9900,3000.00\n09/19/2026,ONLINE TRANSFER FROM CHK XXXXXX9876 REF #IB9901,1500.00\n`, "Owner1234.csv");
    const v = await view(id);
    // IT IS NEVER THE GUESS: Erik's own first case looked exactly like this and was customers paying his
    // Venmo, already recorded. The answer is in the Other... list and a person picks it on purpose.
    for (const r of v.rows) expect(r.guess).not.toBe("owner_in");
    expect(v.otherIn.map((b) => b.id)).toContain("owner_in");
    expect(v.otherIn.find((b) => b.id === "owner_in")!.label).toBe("Owner's Money In");

    const res = await applyBankDownload(id, { fingerprint: v.fingerprint, picks: Object.fromEntries(v.rows.map((r) => [r.id, "owner_in"])) });
    expect(res.ok).toBe(true);
    // NO INCOME, NO COST: filing his own money as income is the overstatement 0376 exists to end.
    expect(db.payments.filter((p) => p.bank_line_id)).toHaveLength(0);
    expect(db.bills ?? []).toHaveLength(0);
    expect(db.bank_lines.map((l) => [l.choice, l.bucket, l.invoice_id])).toEqual([
      ["owner_in", null, null],
      ["owner_in", null, null],
    ]);
    // LEARNED, for the amounts it was answered for, on the account the words name.
    expect(db.bank_rules.map((r) => [r.direction, r.merchant_key, r.choice, r.min_cents, r.max_cents])).toEqual([["in", "transfer 9876", "owner_in", 150_000, 300_000]]);
    expect(res.message).toContain("Owner's Money In");

    // And Undo takes the lines off with nothing else to take back.
    await undoBankDownload(id);
    expect(db.bank_lines).toHaveLength(0);
    expect(db.bills ?? []).toHaveLength(0);
  });

  it("a petty cash top-up an ATM line wrote before W1-34 is still taken back only while it is still that top-up", async () => {
    const id = await drop(`Date,Description,Amount\n09/15/2026,ATM WITHDRAWAL MAIN ST,-200.00\n09/16/2026,ATM WITHDRAWAL MAIN ST,-100.00\n`, "Atm1234.csv");
    const v = await view(id);
    // An old card's pick, under the old word: read as Cash Taken Out, so nothing is written now.
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: Object.fromEntries(v.rows.map((r) => [r.id, "petty_cash"])) });
    expect(db.petty_cash ?? []).toHaveLength(0);
    // The top-ups the old Apply wrote for these lines (Petty Cash (ATM) wrote one per line).
    db.petty_cash = db.bank_lines.map((l) => ({ id: `pc-${l.id}`, org_id: l.org_id, kind: "replenish", amount: -Number(l.amount), tx_date: l.posted_on, bank_line_id: l.id }));
    // Someone corrects one of them since.
    db.petty_cash.find((p) => p.amount === 200)!.amount = 180;
    const res = await undoBankDownload(id);
    expect(res.message).toMatch(/its petty cash row was changed since, so it stays/);
    expect(db.petty_cash.map((p) => p.amount)).toEqual([180]);
  });

  it("an Apply still writing holds Undo back; a claim nobody finished (a lost request) does not trap the card", async () => {
    const id = await drop();
    const v = await view(id);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Fuel" } });
    const item = db.organized_items[0];
    item.proposal.bankImport.pending = new Date().toISOString();
    expect(await undoBankDownload(id)).toMatchObject({ ok: false, error: expect.stringMatching(/being applied right now/) });
    expect(db.bills).toHaveLength(3);
    item.proposal.bankImport.pending = new Date(Date.now() - 10 * 60_000).toISOString();
    expect((await undoBankDownload(id)).ok).toBe(true);
    expect(db.bills).toHaveLength(0);
  });

  it("the tray's own Undo (a filed download in Organize's Archive) runs the same", async () => {
    const id = await drop();
    const v = await view(id);
    const picks: Record<string, string> = {};
    for (const r of v.rows) picks[r.id] = r.direction === "in" ? "other_income" : "personal";
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks });
    expect(db.organized_items[0].status).toBe("filed");
    const res = await undoPaperwork(id);
    expect(res.ok).toBe(true);
    expect(db.bank_lines).toHaveLength(0);
    expect(db.organized_items[0].status).toBe("needs_review");
  });
});

describe("the owner's money", () => {
  it("an office viewer the owner hasn't let see owner money gets no lines, and every door refuses", async () => {
    const id = await drop();
    db.organizations[0].settings = { timezone: "America/Los_Angeles", office_sees_owner_money: false };
    db.profiles.find((p) => p.id === "user-1")!.role = "office";
    const v = await view(id);
    expect(v.problem).toMatch(/^The owner sorts bank downloads/);
    expect(v.rows).toEqual([]);
    expect(v.flow).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/DENTAL|TRANSFER|SHELL/);
    expect(await applyBankDownload(id, { fingerprint: "x", picks: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/^The owner sorts/) });
    expect(await undoBankDownload(id)).toMatchObject({ ok: false });
    expect(await swapBankDownload(id)).toMatchObject({ ok: false });
    // Nor can they bring one in: the drop is refused in words, and nothing is written (0365 holds a
    // bank download in the tray to whoever sorts the bank, so the database would refuse it too).
    const before = db.organized_items.length;
    const dropped = await addOpenList({ name: "Card.csv", sha256: null, table: parseCSV(CHECKING_CSV.replace("DENTAL CARE LLC", "DENTAL CARE CO")), listDate: "2026-09-26", source: "bills_drop" });
    expect(dropped).toMatchObject({ ok: false, error: expect.stringMatching(/^Card\.csv: The owner sorts bank downloads/) });
    expect(db.organized_items).toHaveLength(before);
    // The owner sorts it as always.
    db.profiles.find((p) => p.id === "user-1")!.role = "owner";
    expect((await view(id)).problem).toBeNull();
  });

  it("no page hands the browser a download's lines: the card is the view, for the owner and the office alike", async () => {
    const id = await drop();
    const row = db.organized_items.find((i) => i.id === id)!;
    const raw = JSON.stringify(row);
    expect(raw).toMatch(/DENTAL|SHELL/); // the stored row has them; the server sorts from it
    // The owner: no line leaves, the count does (describePaper's "Bank Download, 9 lines").
    const owner = bankLinesStayHere(row, await view(id));
    expect(JSON.stringify(owner)).not.toMatch(/DENTAL|TRANSFER|SHELL/);
    expect(owner.proposal.bankImport.download.lines).toEqual([]);
    expect(describePaper(owner as any)).toBe("Bank Download, 9 lines");
    expect(row.proposal.bankImport.download.lines).toHaveLength(9); // the stored row is untouched
    // An office viewer the owner keeps it from: no line and no count.
    db.organizations[0].settings = { timezone: "America/Los_Angeles", office_sees_owner_money: false };
    db.profiles.find((p) => p.id === "user-1")!.role = "office";
    const office = bankLinesStayHere(row, await view(id));
    expect(JSON.stringify(office)).not.toMatch(/DENTAL|TRANSFER|SHELL/);
    expect(describePaper(office as any)).toBe("Bank Download");
    expect(readinessOf(office as any).state).toBe("bank_download");
    // A filed download has no card: still no line, and no count.
    const filed: Row = { ...row, status: "filed" };
    const filedOut = bankLinesStayHere(filed, undefined);
    expect(JSON.stringify(filedOut)).not.toMatch(/DENTAL|SHELL/);
    expect(describePaper(filedOut as any)).toBe("Bank Download");
    // Any other paper goes as it is.
    const plain = { id: "p", proposal: { picture: true } };
    expect(bankLinesStayHere(plain, undefined)).toBe(plain);
    // EVERY PLACE THAT HANDS A PAPER ROW TO THE BROWSER RUNS EVERY ROW THROUGH IT. The bank card moved
    // off /bills to /reconcile on 2026-10-03 (lib/paperwork answeredOnReconcile), so the list of places
    // moved with it rather than this tripwire being dropped: Reconcile's read, Organize's page, and
    // Snap Or Note's sheet, which draws the same card for a file just dropped.
    const { readFileSync } = await import("node:fs");
    for (const page of [
      "src/app/(app)/reconcile/statement-cards.ts",
      "src/app/(app)/organize/page.tsx",
      "src/app/(app)/snap-or-note-actions.ts",
    ])
      expect(readFileSync(page, "utf8"), page).toContain("...bankLinesStayHere(i, bankCards[i.id]),");
    // AND /bills HANDS NO BANK VIEW AT ALL ANY MORE, which is the stronger boundary: it does not read
    // one, so it cannot leak one. A download there would carry `bank: null` and draw no card.
    const bills = readFileSync("src/app/(app)/bills/page.tsx", "utf8");
    expect(bills).not.toContain("bankViews(");
    expect(bills).toContain("const papers = trayPapers.filter((i) => !answeredOnReconcile(i));");
  });

  /**
   * ── AND NO SENTENCE SENDS HIM TO A CARD THAT IS NOT THERE (review, 2026-10-03) ──────────────
   *
   * The Undo's failure line still sent him to the queue card on Bills, where a bank download has not been
   * drawn since the cards moved. It shows in the card's OWN status line (ok:true with a message), so he
   * would have gone looking on a page that holds only a pointer. The sweep of these sentences greps the
   * words "Needs You on Bills" — and this one never said Bills, so it slipped straight through.
   */
  it("the Undo's failure line names Reconcile, the page the card is actually on", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(app)/bills/bank-actions.ts", "utf8");
    expect(src).toContain("The card didn't reset on Reconcile");
    // THE TRIPWIRE IS THE WORDS, however they are phrased: no sentence and no comment in the files these
    // two cards are drawn from may put the answer "under Needs You" again.
    for (const f of [
      "src/app/(app)/bills/bank-actions.ts",
      "src/app/(app)/bills/bank-core.ts",
      "src/app/(app)/bills/supplier-import-actions.ts",
      "src/components/paperwork-row.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/under Needs You|to Needs You/);
    }
  });
});

/**
 * A SCANNED STATEMENT'S READ REPORT IS OWNER MONEY TOO (2026-10-02). It says what the month adds to,
 * out and in, in one sentence — so it belongs behind the same switch as the lines it describes, in the
 * card the viewer is allowed and nowhere else in the props.
 */
describe("the read report on a scanned statement's card", () => {
  const SAID = "Held against the statement's own printed figures: the money going out and the money coming in agree to the cent. $4,210.00 out and $9,900.00 in.";

  it("reaches the owner's card, and never a viewer the owner keeps owner money from", async () => {
    const id = await drop();
    const row = db.organized_items.find((i) => i.id === id)!;
    row.proposal.bankImport.download.readSaid = SAID;
    expect((await view(id)).readSaid).toContain("agree to the cent");

    db.organizations[0].settings = { timezone: "America/Los_Angeles", office_sees_owner_money: false };
    db.profiles.find((p) => p.id === "user-1")!.role = "office";
    const hidden = await view(id);
    expect(hidden.readSaid ?? null).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain("$4,210.00");
    expect(JSON.stringify(bankLinesStayHere(row, hidden))).not.toContain("$4,210.00");

    // AND THE OWNER'S OWN PROPS DROP IT AS WELL: the card renders it from the view, so a second copy
    // riding on the proposal would only be a copy nobody checked the gate for.
    db.profiles.find((p) => p.id === "user-1")!.role = "owner";
    db.organizations[0].settings = { timezone: "America/Los_Angeles" };
    const owner = bankLinesStayHere(row, await view(id));
    expect(owner.proposal.bankImport.download.readSaid).toBeUndefined();
    expect(row.proposal.bankImport.download.readSaid).toBe(SAID); // the stored row is untouched
  });

  /**
   * AND THE VERDICT ITSELF GOES WITH IT, from EVERY viewer's props. `verified.controls` holds the
   * statement's own beginning and ending balance in figures — the owner's account in two numbers, which no
   * card ever shows — so a copy riding along in the props is owner money nobody checked the gate for.
   *
   * The strip was there and nothing pinned it: the only test injected `readSaid` alone, so deleting
   * `verified: undefined` left the whole unit suite green. This asserts the figures, not the field, because
   * the figures are what would leak.
   */
  it("and the verdict's own control figures never ride in the props, for any viewer", async () => {
    const id = await drop();
    const row = db.organized_items.find((i) => i.id === id)!;
    row.proposal.bankImport.download.verified = {
      source: "picture",
      chain: { ran: true, links: 5, lines: 6, withBalance: 6, reversed: false, card: false, breaks: [], broke: 0, sameDay: 0, runs: 1, byAccount: false, unwalked: 0, unwalkedDay: null, why: null },
      totals: { pass: true, agreed: ["the money going out"], unchecked: [], failed: [], pinned: 1 },
      controls: { beginning: 128455, ending: 250556, deposits: 343742, withdrawals: 221641, account: "deposit" },
      failed: [],
      pass: true,
    };
    for (const role of ["owner", "office"] as const) {
      db.profiles.find((p) => p.id === "user-1")!.role = role;
      db.organizations[0].settings = role === "office" ? { timezone: "America/Los_Angeles", office_sees_owner_money: false } : { timezone: "America/Los_Angeles" };
      const props = JSON.stringify(bankLinesStayHere(row, await view(id)));
      // $1,284.55 to start and $2,505.56 to end, in cents, as the verdict stores them.
      expect(props, role).not.toContain("128455");
      expect(props, role).not.toContain("250556");
      expect(props, role).not.toContain("verified");
    }
    // And the stored row still has them, because that is where a Swap gets them from.
    expect(row.proposal.bankImport.download.verified.controls.beginning).toBe(128455);
  });

  /**
   * AND THE DOOR CANNOT BE HANDED ONE. `addOpenList` is a "use server" export, which is a PUBLIC POST
   * ENDPOINT (report-client-error.ts says so), so while the sentence was a field of its argument any
   * staffer who may sort the bank could post a table of their own making together with "agree to the
   * cent" and get a bank card claiming arithmetic that never ran. The card prints no totals to hold it
   * against and Apply never reads it, so nobody downstream could tell.
   *
   * NOW NOBODY HANDS A SENTENCE AT ALL. The one verification writes it from the lines that landed
   * (statement-verify.ts, called inside the reader), so a posted one is not refused — it has nowhere to
   * go. What the card says here is what the chain actually found in this file.
   */
  it("a sentence posted at the door is never stored as what checked the read", async () => {
    const forged = { pages: 3, rows: 9, checked: SAID };
    const res = await addOpenList({ name: "Checking.csv", sha256: null, table: parseCSV(CHECKING_CSV), listDate: "2026-09-26", source: "bills_drop", pdf: forged } as never);
    expect(res.ok).toBe(true);
    const row = db.organized_items.find((i) => i.id === res.id)!;
    expect(JSON.stringify(row)).not.toContain("agree to the cent");
    expect(JSON.stringify(row)).not.toContain("$9,900.00");
    // What IS stored is this file's own arithmetic: a running balance that walks, and how it was read.
    const said = row.proposal.bankImport.download.readSaid as string;
    expect(said).toContain("proves every line");
    expect(said).toContain("Read off the page itself.");
    // The pages it DID say are still facts about the paper, so the read report still has them.
    expect(res.line).toContain("3 pages");
  });
});

describe("before 0363 is applied", () => {
  it("the download still lands, the card says it needs an update, and Apply writes nothing", async () => {
    const id = await drop();
    missingBank = true;
    const v = await view(id);
    expect(v.problem).toBe(BANK_NEEDS_UPDATE);
    const res = await applyBankCore(state.client, { orgId: "org-1", userId: "user-1" }, id, { fingerprint: "x", picks: {} });
    expect(res).toEqual({ ok: false, error: BANK_NEEDS_UPDATE });
    expect(db.organized_items[0].status).toBe("needs_review");
  });
});
