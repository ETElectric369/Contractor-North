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

import { addOpenList } from "./open-list-actions";
import { applyBankDownload, setBankAccount, swapBankDownload, undoBankDownload } from "./bank-actions";
import { applyBankCore, bankViews, BANK_NEEDS_UPDATE } from "./bank-core";
import { undoPaperwork } from "@/app/(app)/organize/actions";

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let seq = 0;
let missingBank = false;

const UNIQUE: Record<string, string[]> = { bank_lines: ["org_id", "line_key"], bank_rules: ["org_id", "direction", "merchant_key"] };

function fakeDb() {
  return {
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
        return out;
      };
      const run = () => {
        if (missingBank && touchesBank) return { data: null, error: { code: "42P01", message: 'relation "bank_lines" does not exist' } };
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
          if (/bank_line_id|cost_kind/.test(cols)) touchesBank ||= false;
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
const CHECKING_CSV = `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance
XXXXX1234,09/24/2026,,DENTAL CARE LLC,150.00,,Posted,9012.00
XXXXX1234,09/18/2026,,STRIPE TRANSFER ST-AB12,,485.40,Posted,9907.10
XXXXX1234,09/16/2026,,1111-SHELL 123 ANYTOWN ST,100.00,,Posted,9421.70
XXXXX1234,09/12/2026,,1111-ACME INSURANCE CO,31.90,,Posted,9721.70
XXXXX1234,09/10/2026,,ONLINE TRANSFER TO CHK XXXXXX9876 REF #IB0123456789,2000.00,,Posted,9746.07
XXXXX1234,09/09/2026,,1111-SHELL 456 OTHERTOWN,100.00,,Posted,11746.07
XXXXX1234,09/05/2026,1043,CHECK,640.00,,Posted,11846.07
XXXXX1234,09/04/2026,,DEPOSIT,,1275.00,Posted,12441.07
XXXXX1234,09/02/2026,,1111-SHELL 123 ANYTOWN ST,88.45,,Posted,11091.07
`;
// The next month's download overlaps it by a week and adds two new SHELL fills.
const NEXT_CSV = `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance
XXXXX1234,10/02/2026,,1111-SHELL 789 ANYTOWN,88.10,,Posted,8000.00
XXXXX1234,09/28/2026,,1111-SHELL 123 ANYTOWN ST,60.00,,Posted,8088.10
XXXXX1234,09/24/2026,,DENTAL CARE LLC,150.00,,Posted,9012.00
XXXXX1234,09/18/2026,,STRIPE TRANSFER ST-AB12,,485.40,Posted,9907.10
XXXXX1234,09/16/2026,,1111-SHELL 123 ANYTOWN ST,100.00,,Posted,9421.70
`;

function seed() {
  seq = 0;
  missingBank = false;
  db = {
    organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }],
    supplier_accounts: [
      { id: "acct-cs", org_id: "org-1", name: "Contractor Supply", account_number: "CS-12345", branch_code: null, on_account: true },
      { id: "acct-x", org_id: "org-2", name: "Someone Else's Supplier", account_number: "CS-12345", on_account: true },
    ],
    supplier_aliases: [],
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
    expect(v.headline).toBe("Bank ••1234 · Sep 2–Sep 24 · 1 sorted · 6 need you");
    const shell = rowBy(v, "SHELL");
    expect(shell.money).toBe("3× $288.45");
    expect(shell.buttons.map((b) => b.label)).toEqual(["Fuel", "Truck", "Personal"]);
    expect(rowBy(v, "Deposit").buttons.map((b) => b.label)).toEqual(["On INV-1001", "Other Income", "Not Income"]);
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
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Gas & Truck:fuel" } });
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
      SHELL: "cost:Gas & Truck:fuel",
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

    const lines = db.bank_lines;
    expect(lines).toHaveLength(8);
    expect(lines.every((l) => l.org_id === "org-1" && l.import_id === id && !/\d{6,}/.test(l.description))).toBe(true);
    expect(lines.find((l) => l.description.includes("TRANSFER TO CHK"))).toMatchObject({ choice: "draw", sorted_by: "person", amount: -2000 });
    expect(lines.find((l) => l.description.includes("DENTAL"))).toMatchObject({ choice: "personal" });
    expect(lines.find((l) => l.description.includes("STRIPE"))).toMatchObject({ choice: "matched", sorted_by: "match" });

    // FUEL: three paid business costs in Add Business Cost's shape, tagged fuel, each marked.
    expect(db.bills).toHaveLength(3);
    for (const b of db.bills) {
      expect(b).toMatchObject({ org_id: "org-1", job_id: null, status: "paid", category: "Gas & Truck", cost_kind: "fuel" });
      expect(lines.some((l) => l.id === b.bank_line_id && l.choice === "cost")).toBe(true);
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

    // The check to Pat, as crew pay with its number.
    expect(db.pay_payments).toEqual([expect.objectContaining({ org_id: "org-1", profile_id: "pat", amount: 640, reference: "1043", method: "check" })]);

    // The payout MARKED the two card payments; nothing new was written for them.
    const payout = lines.find((l) => l.description.includes("STRIPE"))!;
    expect(db.payments.filter((p) => p.bank_line_id === payout.id).map((p) => p.id).sort()).toEqual(["pay-c1", "pay-c2"]);
    expect(db.payments).toHaveLength(4);

    // RULES from the taps, one per merchant; never from the deposit's invoice or the check.
    expect(db.bank_rules.map((r) => [r.direction, r.merchant_key, r.choice, r.cost_kind]).sort()).toEqual([
      ["out", "dental", "personal", null],
      ["out", "shell", "cost", "fuel"],
      ["out", "transfer 9876", "draw", null],
    ]);
    expect(db.bank_rules.every((r) => r.learned_import_id === id && r.org_id === "org-1")).toBe(true);

    // ANOTHER COMPANY'S ROWS: untouched.
    expect(db.payments.find((p) => p.id === "pay-x")!.bank_line_id).toBeNull();
    expect(db.invoices.find((i) => i.id === "inv-x")!.amount_paid).toBe(0);

    // The row left for later keeps the card in Sort These, named as not counted.
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
    expect(db.bills.find((b) => b.category === "Insurance & Licenses")).toMatchObject({ amount: 31.90, cost_kind: null });
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
      applyBankDownload(id, { fingerprint: fresh.fingerprint, picks: { [shell]: "cost:Gas & Truck:fuel" } }),
      applyBankDownload(id, { fingerprint: fresh.fingerprint, picks: { [shell]: "cost:Gas & Truck:fuel" } }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)!.error).toMatch(/applied from another screen|already applied/);
    expect(db.bills).toHaveLength(3);
    expect(new Set(db.bank_lines.map((l) => l.line_key)).size).toBe(db.bank_lines.length);
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

describe("the next download", () => {
  it("counts what the first wrote as already in North, and sorts by the answers the first taught", async () => {
    const first = await drop();
    const v = await view(first);
    const shell = rowBy(v, "SHELL").id;
    const dental = rowBy(v, "DENTAL").id;
    await applyBankDownload(first, { fingerprint: v.fingerprint, picks: { [shell]: "cost:Gas & Truck:fuel", [dental]: "personal" } });
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

  it("the same file dropped twice is Already In", async () => {
    const sha = "a".repeat(64);
    await drop(CHECKING_CSV, "Checking.csv", sha);
    const again = await addOpenList({ name: "Checking.csv", sha256: sha, table: parseCSV(CHECKING_CSV), listDate: "2026-09-26" });
    expect(again.ok).toBe(false);
    expect(again.already).toMatch(/^Already In/);
    expect(db.organized_items).toHaveLength(1);
  });
});

describe("Undo", () => {
  it("takes back only what the download wrote, and the card waits again with every line", async () => {
    const id = await drop();
    const v = await view(id);
    const picks = {
      [rowBy(v, "SHELL").id]: "cost:Gas & Truck:fuel",
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

  it("an Apply still writing holds Undo back; a claim nobody finished (a lost request) does not trap the card", async () => {
    const id = await drop();
    const v = await view(id);
    await applyBankDownload(id, { fingerprint: v.fingerprint, picks: { [rowBy(v, "SHELL").id]: "cost:Gas & Truck:fuel" } });
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
