import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSettledBySupplier, readSupplierOwed } from "@/lib/supplier-owed-read";

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
      in: (col: string, vs: unknown[]) => {
        filters.push((r) => (vs ?? []).map(String).includes(String(r?.[col] ?? "")));
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
    // Our open bills on the account (500 + 3034.54 + 800) + 120 (register supplier) + 250 (unfiled) + 40 (no name on it)
    expect(read!.owed.total).toBe(4744.54);
    expect(read!.failed).toEqual([]);
  });

  it("names the ticket their own closed paper covers while it is still open here, found by the number on its line", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    // t2 is $3,034.54 on NO account: reachable only because identity placed it by the account's own
    // name AND the number parse found the closed paper. Since 0383 that is a DISAGREEMENT Reconcile
    // names (they call it paid, the bill is open), never a figure's exclusion: the bill counts until
    // its own number says paid.
    expect([...read!.settledBySupplier]).toEqual(["t2"]);
    expect(read!.bought.ids).toContain("t2");
    expect(read!.bought.total).toBe(4744.54);
    expect(read!.bought.papers).toBe(6);
  });

  it("answers the two questions with ONE number now: both count what is open on each bill (0383)", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(read!.owed.total).toBe(read!.bought.total);
    // Their own open paper ($1,200.00) stands beside the account's figure, never inside it.
    expect(read!.accounts.find((a) => a.accountId === ACCOUNT)).toMatchObject({ owed: 4334.54, theirs: 1200, model: "supplier-invoices" });
  });

  it("never subtracts payments again ($1,360.93): a matched payment already came off the bills it paid", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    const line = read!.owed.lines.find((l) => l.name === "Northgate Electrical Distributors");
    expect(line).toMatchObject({ owed: 4334.54, how: "my-open-bills" });
  });

  it("says how many papers are not on a supplier account yet", async () => {
    const read = await readSupplierOwed(fakeSupabase(), ORG);
    expect(read!.owed.notOnAnAccount).toEqual({ papers: 2, total: 290, spellings: 1, unnamed: 1, credits: 0, creditPapers: 0 });
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

  /**
   * THE READ THAT FAILS SILENTLY (finding 4). Lose the SUPPLIERS' OWN PAPERS and nothing looks
   * missing: the account simply holds no documents, so its figure drops from model B to model A -
   * our tickets less what we sent them - which subtracts $6,000 of payments that are already inside
   * what the supplier closed. That is the arithmetic supplier-balance.ts has a test named after.
   *
   * /bills refuses to total in that state ("Couldn't Total Just Now"). Nort quoted the number,
   * because his copy of the rule checked only bills and payments. Erik acts on Nort's answers.
   */
  it("will not total an account whose own papers could not be read, and names it", async () => {
    const read = await readSupplierOwed(fakeSupabase(new Set(["supplier_invoices"])), ORG);
    expect(read!.failed).toContain("the suppliers' own papers");
    // The account is NAMED as one that could not be totalled, which is what /bills shows.
    expect(read!.owed.couldNotTotal.map((a) => a.name)).toEqual(["Northgate Electrical Distributors"]);
    // And its money is in no figure and no line: not quoted, not zeroed, not turned into a credit.
    expect(read!.owed.lines.some((l) => l.accountId === ACCOUNT)).toBe(false);
    expect(read!.owed.ahead.some((a) => a.accountId === ACCOUNT)).toBe(false);
    // Before this it answered $1,665.46 AHEAD at that account - 500 + 800 + 3034.54 - 6000.
    expect(read!.owed.total).not.toBe(4744.54);
  });

  it("refuses to answer for no company at all", async () => {
    expect(await readSupplierOwed(fakeSupabase(), "")).toBeNull();
  });
});

/**
 * THE FACT A JOB'S COSTS TAB HAD NEVER BEEN HANDED (findings 3/8).
 *
 * `billSettledLabel` is one expression both screens draw, but only /bills had been told whether the
 * supplier's own papers covered a ticket - so the SAME ticket read "Settled · CED Says" there and
 * "On Account" on the job, and nothing on the job said the money had already left the balance.
 *
 * It is the SAME covering walk, through `supplierDocumentRows`, scoped to the tickets asked about:
 * a document reaches a paper through a link on that paper or a number printed on that paper's own
 * lines, so leaving other jobs' tickets out cannot change the answer for these.
 */
describe("what the supplier's own books say about a handful of tickets", () => {
  const ticketsOn = (ids: string[]) => TABLES.bills.filter((b) => ids.includes(b.id));

  it("names the ticket their closed paper covers, by the account's own name", async () => {
    const read = await readSettledBySupplier(fakeSupabase(), ORG, ticketsOn(["t1", "t2", "t8"]));
    expect(read.unread).toBe(false);
    // t2: on NO account, placed by the account's own name, covered by a CLOSED paper of theirs.
    expect(read.settled.get("t2")).toBe("Northgate Electrical Distributors");
    // t8: placed by an alias, and the paper covering it is still OPEN - so still owed, not settled.
    expect(read.settled.has("t8")).toBe(false);
    // t1: nothing of theirs reaches it at all.
    expect(read.settled.has("t1")).toBe(false);
  });

  it("claims nothing either way when a read behind it failed, and says which", async () => {
    const read = await readSettledBySupplier(fakeSupabase(new Set(["supplier_invoices"])), ORG, ticketsOn(["t2"]));
    expect(read.unread).toBe(true);
    expect(read.failed).toContain("the suppliers' own papers");
    expect(read.settled.size).toBe(0);
  });

  it("answers for no company and no tickets without reading anything", async () => {
    expect((await readSettledBySupplier(fakeSupabase(), "", ticketsOn(["t2"]))).settled.size).toBe(0);
    expect((await readSettledBySupplier(fakeSupabase(), ORG, [])).unread).toBe(false);
  });

  /** A duplicate somebody set aside is in nobody's books, so it is never called settled either. */
  it("leaves a superseded copy out", async () => {
    const read = await readSettledBySupplier(fakeSupabase(), ORG, [
      { id: "t2", supplier: "Northgate Electrical Distributors, Inc.", superseded_by_bill_id: "t1", bill_line_items: [{ description: "Statement (Invoice 1002)" }] },
    ]);
    expect(read.settled.size).toBe(0);
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
