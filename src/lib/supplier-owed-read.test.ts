import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSupplierOwed } from "@/lib/supplier-owed-read";

/**
 * NORT'S WORDS MATCH THE CARD TO THE CENT (8a982483, Part 4).
 *
 * He was asked "how much do I owe suppliers" and answered off `list_bills`: at most twenty rows of
 * the newest tickets, under whatever name the scanner typed, added up by him. Erik asks him and then
 * ACTS on the answer, so this is the one reader where being merely plausible is worst - there is no
 * card beside the sentence to argue with.
 *
 * The book below is the same synthetic book supplier-owed.test.ts builds, handed to Nort's read
 * through a fake database in the shapes PostgREST returns. SYNTHETIC: no real supplier, account
 * number or figure is in this repository.
 */

const ORG = "org-synthetic";
const ACCOUNT = "acct-northgate";
const REGISTER = "acct-cutter";

const TABLES: Record<string, any[]> = {
  organizations: [{ id: ORG, settings: { timezone: "America/Los_Angeles" } }],
  supplier_accounts: [
    { id: ACCOUNT, org_id: ORG, name: "Northgate Electrical Distributors", account_number: "SYN-0001", branch_code: "01", on_account: true },
    { id: REGISTER, org_id: ORG, name: "Cutter Rentals", account_number: null, branch_code: null, on_account: false },
  ],
  supplier_aliases: [{ org_id: ORG, alias: "Northgate Elec.", supplier_account_id: ACCOUNT }],
  supplier_invoices: [
    {
      id: "d-open",
      org_id: ORG,
      supplier_account_id: ACCOUNT,
      invoice_number: "1001",
      kind: "invoice",
      invoice_date: "2026-09-01",
      total: 1200,
      open_balance: 1200,
      closed: false,
      discount_amount: null,
      discount_by: null,
    },
    {
      id: "d-closed",
      org_id: ORG,
      supplier_account_id: ACCOUNT,
      invoice_number: "1002",
      kind: "invoice",
      invoice_date: "2026-09-02",
      total: 3034.54,
      open_balance: 0,
      closed: true,
      discount_amount: null,
      discount_by: null,
    },
  ],
  bills: [
    bill("t1", { supplier: "Northgate Electrical Distributors", supplier_account_id: ACCOUNT, amount: 500 }),
    // On NO account, resolves by the account's own NAME, and a CLOSED paper of theirs covers it by
    // the number printed on its line. The double count, reached the hard way.
    bill("t2", {
      supplier: "Northgate Electrical Distributors, Inc.",
      amount: 3034.54,
      bill_line_items: [{ description: "Statement (Invoice 1002)" }],
    }),
    bill("t4", { supplier: "Cutter Rentals", supplier_account_id: REGISTER, amount: 120 }),
    bill("t5", { supplier: "Ridgeline Lumber", amount: 250 }),
    bill("t6", { supplier: "Ridgeline Lumber", amount: 75, status: "paid" }),
    bill("t7", { supplier: "", amount: 40 }),
    // Resolves by ALIAS, and the paper covering it by number is still OPEN: still owed.
    bill("t8", { supplier: "Northgate Elec.", amount: 800, bill_line_items: [{ description: "Materials (Invoice 1001)" }] }),
  ],
  bill_supplier_invoices: [],
  supplier_payments: [
    { id: "p1", org_id: ORG, supplier_account_id: ACCOUNT, amount: 6000, paid_on: "2026-09-15", method: "check", voided_at: null },
    { id: "p2", org_id: ORG, supplier_account_id: ACCOUNT, amount: 300, paid_on: "2026-09-16", method: "check", voided_at: "2026-09-17T00:00:00Z" },
  ],
};

function bill(id: string, over: Record<string, unknown>) {
  return {
    id,
    org_id: ORG,
    supplier: "",
    supplier_account_id: null,
    bill_number: null,
    supplier_invoice_number: null,
    amount: 0,
    status: "unpaid",
    bill_date: "2026-09-10",
    job_id: null,
    is_statement: false,
    superseded_by_bill_id: null,
    notes: null,
    bill_line_items: [],
    ...over,
  };
}

/** A fake PostgREST, in the shapes the real one answers in. Filters are applied, nothing else. */
function fakeSupabase(missing: Set<string> = new Set()) {
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
      limit: () => settle(),
      maybeSingle: () => settle(true),
      then: (res: any, rej: any) => settle().then(res, rej),
    };
    const settle = (single = false) => {
      if (missing.has(table)) return Promise.resolve({ data: null, error: { message: `${table} unread` } });
      const rows = (TABLES[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
    };
    return q;
  };
  return { from: (table: string) => build(table) };
}

describe("Nort reads the same figure the card shows", () => {
  it("answers what you owe, and it is the card's number", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(read).not.toBeNull();
    // 1200 (their own open paper) + 120 (register supplier) + 250 (unfiled) + 40 (no name on it)
    expect(read!.owed.total).toBe(1610);
    expect(read!.failed).toEqual([]);
  });

  it("drops the ticket their own closed paper covers, found by the number on its line", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    // t2 is $3,034.54 on NO account: reachable only because identity placed it by the account's own
    // name AND the number parse found the closed paper. Every earlier reader missed both.
    expect(read!.bought.ids).not.toContain("t2");
    expect(read!.bought.total).toBe(1710);
    expect(read!.bought.papers).toBe(5);
  });

  it("answers the two questions with two different numbers, neither of them wrong", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(read!.owed.total).not.toBe(read!.bought.total);
    // Our tickets on that account say $1,300.00; their own open paper says $1,200.00.
    expect(Math.round((read!.bought.total - read!.owed.total) * 100) / 100).toBe(100);
  });

  it("never subtracts payments already inside what the supplier closed ($1,360.93)", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    const line = read!.owed.lines.find((l) => l.name === "Northgate Electrical Distributors");
    expect(line).toMatchObject({ owed: 1200, how: "their-own-papers" });
  });

  it("says how many papers are not on a supplier account yet", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(read!.owed.notOnAnAccount).toEqual({ papers: 2, total: 290, spellings: 1, unnamed: 1 });
  });

  /**
   * A LOST LINKS READ MARKS NOTHING SETTLED, the same gate /bills uses - and it SAYS the read
   * failed. The figure then leans toward money he may still owe, which is every figure's lean in
   * this app, instead of quietly going up with nothing on screen about it.
   */
  it("names a read that failed instead of quoting a figure built on it", async () => {
    const read = await readSupplierOwed(fakeSupabase(new Set(["bill_supplier_invoices"])), ORG);
    expect(read!.failed).toContain("which paper covers which bill");
    expect(read!.bought.ids).toContain("t2");
  });

  it("refuses to answer for no company at all", async () => {
    expect(await readSupplierOwed(fakeSupabase(), "")).toBeNull();
  });
});

describe("Nort's read and the Bills page make the same call", () => {
  /** A SECOND, CAREFUL WAY TO THE SAME FIGURE IS HOW THIS BUG WAS BUILT. Both go through
   *  supplierDocumentRows, and both hand it the accounts, or one of them resolves fewer papers. */
  it("both go through supplierDocumentRows with the accounts", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    const nort = readFileSync(join(process.cwd(), "src/lib/supplier-owed-read.ts"), "utf8");
    for (const src of [page, nort]) {
      expect(src).toContain("supplierDocumentRows({");
      expect(src).toMatch(/accountRows:/);
    }
    // And neither builds its own total.
    expect(page).toContain("whatISupplierOwed({");
    expect(nort).toContain("whatISupplierOwed({");
  });

  /** The tool Nort is told to use for the question, and the one he must not add up. */
  it("the tool registry sends the question to the one that answers it", () => {
    const tools = readFileSync(join(process.cwd(), "src/lib/assistant-tools.ts"), "utf8");
    expect(tools).toContain('name: "supplier_balances"');
    expect(tools).toContain('"supplier_balances",');
    // list_bills no longer advertises itself for the question it could not answer.
    const listBills = tools.slice(tools.indexOf('name: "list_bills"'));
    expect(listBills.slice(0, 1200)).not.toContain("how much do I owe suppliers");
    expect(listBills.slice(0, 1200)).toContain("NEVER ADD THESE UP");
  });
});
