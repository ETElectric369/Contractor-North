import { describe, it, expect } from "vitest";
import {
  NO_SUPPLIER_NAME_GROUP,
  NO_SUPPLIER_NAME_LABEL,
  indexSupplierIdentity,
  isStillOwed,
  notOnAnAccountSentence,
  resolveSupplierPapers,
  supplierAccountForPaper,
  supplierCoverage,
  whatIBoughtNotSettled,
  whatISupplierOwed,
  type SupplierAccountFigure,
} from "@/lib/supplier-owed";
import { supplierBalance, type SupplierAccountRow, type SupplierInvoiceRow } from "@/app/(app)/bills/supplier-balance";

/**
 * A WHOLE BOOK OF PAPER, MADE UP, with one of every awkward thing in it: a ticket filed on an
 * account, a ticket that only resolves by the account's own name, a ticket that only resolves by
 * an alias, a superseded duplicate, a ticket the supplier's own CLOSED paper covers, a ticket an
 * OPEN paper covers, a register account, a spelling on no account, a paper with no supplier name
 * at all, and payments both live and voided.
 *
 * SYNTHETIC, DELIBERATELY. No real supplier, account number or figure is in this repository.
 */

const ACCOUNT = "acct-northgate";
const REGISTER = "acct-cutter";
const TODAY = "2026-10-01";

const accounts = [
  { id: ACCOUNT, name: "Northgate Electrical Distributors" },
  { id: REGISTER, name: "Cutter Rentals" },
];
const aliases = [{ alias: "Northgate Elec.", supplier_account_id: ACCOUNT }];

/** The supplier's own papers. One still open, one they have closed. */
const doc = (over: Partial<SupplierInvoiceRow> & { id: string }): SupplierInvoiceRow => ({
  invoiceNumber: over.id,
  kind: "invoice",
  invoiceDate: "2026-09-01",
  dueDate: null,
  jobNameRaw: null,
  jobId: null,
  total: 0,
  openBalance: 0,
  closed: false,
  discountAmount: null,
  discountBy: null,
  ...over,
});

const D_OPEN = doc({ id: "d-open", invoiceNumber: "1001", total: 1200, openBalance: 1200, closed: false });
const D_CLOSED = doc({ id: "d-closed", invoiceNumber: "1002", total: 3034.54, openBalance: 0, closed: true });

const documents = [
  { id: D_OPEN.id, supplierAccountId: ACCOUNT, closed: false },
  { id: D_CLOSED.id, supplierAccountId: ACCOUNT, closed: true },
];

const papers = [
  // Filed straight onto the account.
  { id: "t1", supplierAccountId: ACCOUNT, supplier: "Northgate Electrical Distributors", amount: 500, status: "unpaid" },
  // ON NO ACCOUNT AT ALL, and it is the biggest ticket in the book. It resolves by the account's
  // own NAME, and the supplier's closed paper covers it: this is Erik's live double count.
  { id: "t2", supplierAccountId: null, supplier: "Northgate Electrical Distributors, Inc.", amount: 3034.54, status: "unpaid" },
  // A duplicate somebody set aside. Never counted anywhere, by anybody.
  { id: "t3", supplierAccountId: ACCOUNT, supplier: "Northgate Elec.", amount: 500, status: "unpaid", supersededByBillId: "t1" },
  // A register supplier, which keeps no running balance.
  { id: "t4", supplierAccountId: REGISTER, supplier: "Cutter Rentals", amount: 120, status: "unpaid" },
  // A spelling nobody has filed yet.
  { id: "t5", supplierAccountId: null, supplier: "Ridgeline Lumber", amount: 250, status: "unpaid" },
  // Same spelling, settled at the register on the spot.
  { id: "t6", supplierAccountId: null, supplier: "Ridgeline Lumber", amount: 75, status: "paid" },
  // NO SUPPLIER NAME ON IT AT ALL. The row `/bills` used to drop with `if (!alias) continue;`.
  { id: "t7", supplierAccountId: null, supplier: "", amount: 40, status: "unpaid" },
  // Resolves by an ALIAS, and an OPEN supplier paper covers it - so it is still owed.
  { id: "t8", supplierAccountId: null, supplier: "Northgate Elec.", amount: 800, status: "unpaid" },
];

const linked = new Map<string, readonly string[]>([[D_CLOSED.id, ["t2"]]]);
const carrying = new Map<string, readonly string[]>([[D_OPEN.id, ["t8"]]]);

const index = indexSupplierIdentity({ accounts, aliases });
const identity = resolveSupplierPapers(papers, index);
const coverage = supplierCoverage({ documents, identity, linked, carrying, papers });

describe("a paper finds its supplier by identity, never by spelling", () => {
  it("places a ticket three ways and says which one it used", () => {
    expect(identity.get("t1")).toMatchObject({ accountId: ACCOUNT, how: "filed" });
    expect(identity.get("t8")).toMatchObject({ accountId: ACCOUNT, how: "alias" });
    // The one the old readers could never reach: no stored account, no alias row, and the account's
    // own name does not appear in the spelling word for word - "Inc." and the comma are set aside.
    expect(identity.get("t2")).toMatchObject({ accountId: ACCOUNT, how: "name" });
  });

  it("leaves a paper it cannot place on no account, under its own typed-in name", () => {
    expect(identity.get("t5")).toMatchObject({ accountId: null, how: null, spelling: "Ridgeline Lumber", group: "ridgeline lumber" });
  });

  it("gives a paper with no supplier name a group of its own instead of dropping it", () => {
    expect(identity.get("t7")).toMatchObject({ accountId: null, group: NO_SUPPLIER_NAME_GROUP });
  });

  it("will not guess between two accounts that normalise to one name", () => {
    const two = indexSupplierIdentity({
      accounts: [
        { id: "a", name: "Summit Supply Co." },
        { id: "b", name: "Summit Supply Company" },
      ],
      aliases: [],
    });
    expect(two.ambiguousNames.size).toBe(1);
    expect(supplierAccountForPaper({ supplier: "Summit Supply" }, two).accountId).toBeNull();
  });

  it("never matches by initials, however tempting: a merge is a button, not a reading", () => {
    expect(supplierAccountForPaper({ supplier: "NED" }, index).accountId).toBeNull();
  });

  it("a filed account id beats everything, even a spelling that names another account", () => {
    expect(supplierAccountForPaper({ supplierAccountId: REGISTER, supplier: "Northgate Elec." }, index)).toMatchObject({
      accountId: REGISTER,
      how: "filed",
    });
  });
});

describe("the one covering walk", () => {
  it("finds a ticket the supplier's closed paper covers even when the ticket is on no account", () => {
    expect([...coverage.settledBySupplier]).toEqual(["t2"]);
  });

  it("leaves a ticket an OPEN paper covers still owed", () => {
    expect(coverage.covered.has("t8")).toBe(true);
    expect(coverage.settledBySupplier.has("t8")).toBe(false);
  });

  it("never lets one supplier's document settle another supplier's ticket", () => {
    const crossed = supplierCoverage({
      documents: [{ id: "d", supplierAccountId: REGISTER, closed: true }],
      identity,
      linked: new Map([["d", ["t1"]]]),
      carrying: new Map(),
      papers,
    });
    expect(crossed.settledBySupplier.size).toBe(0);
  });
});

describe("the one still-owed test", () => {
  it("counts anything not explicitly paid, and never a duplicate or a supplier-settled ticket", () => {
    expect(isStillOwed({ status: "unpaid" })).toBe(true);
    expect(isStillOwed({ status: null })).toBe(true);
    expect(isStillOwed({ status: "PAID" })).toBe(false);
    expect(isStillOwed({ status: "unpaid", superseded: true })).toBe(false);
    expect(isStillOwed({ status: "unpaid", supersededByBillId: "x" })).toBe(false);
    expect(isStillOwed({ status: "unpaid", settledBySupplier: true })).toBe(false);
  });
});

describe("(b) what did I buy and not settle yet", () => {
  const bought = whatIBoughtNotSettled({ papers, settledBySupplier: coverage.settledBySupplier });

  it("is every one of our own open tickets, to the cent", () => {
    // t1 500 + t4 120 + t5 250 + t7 40 + t8 800
    expect(bought.total).toBe(1710);
    expect(bought.papers).toBe(5);
    expect(bought.ids).toEqual(["t1", "t4", "t5", "t7", "t8"]);
  });

  it("drops the ticket the supplier's own closed paper covers - the double count, gone", () => {
    expect(bought.ids).not.toContain("t2");
    const uncorrected = whatIBoughtNotSettled({ papers });
    expect(uncorrected.total).toBe(4744.54);
    expect(r(uncorrected.total - bought.total)).toBe(3034.54);
  });
});

describe("(a) what do I owe this supplier", () => {
  const figures: SupplierAccountFigure[] = [
    { accountId: ACCOUNT, name: "Northgate Electrical Distributors", onAccount: true, owed: 1200, model: "supplier-invoices" },
    { accountId: REGISTER, name: "Cutter Rentals", onAccount: false, owed: null, model: "bills-minus-payments" },
  ];
  const owed = whatISupplierOwed({ accounts: figures, papers, identity, settledBySupplier: coverage.settledBySupplier });

  it("leads with one number", () => {
    // 1200 their own papers + 120 on a register supplier + 250 unfiled + 40 unnamed
    expect(owed.total).toBe(1610);
  });

  it("takes the supplier's own word where there is one, and says so per row", () => {
    const line = owed.lines.find((l) => l.accountId === ACCOUNT);
    expect(line).toMatchObject({ owed: 1200, how: "their-own-papers" });
  });

  it("falls back to our own open tickets where there is no account", () => {
    expect(owed.lines.find((l) => l.name === "Ridgeline Lumber")).toMatchObject({ owed: 250, how: "my-tickets-no-account", papers: 1 });
  });

  it("counts the paper with no supplier name under a name of its own, never silently", () => {
    expect(owed.lines.find((l) => l.name === NO_SUPPLIER_NAME_LABEL)).toMatchObject({ owed: 40, papers: 1 });
    expect(owed.notOnAnAccount).toEqual({ papers: 2, total: 290, spellings: 1, unnamed: 1 });
  });

  it("says how many papers are not on an account yet, and says nothing when none are", () => {
    expect(notOnAnAccountSentence(owed.notOnAnAccount, (v) => `$${v.toFixed(2)}`)).toBe(
      "$290.00 of this is on 2 papers that are not on a supplier account yet, counted under the name on the paper. 1 of them has no supplier name on it at all.",
    );
    expect(notOnAnAccountSentence({ papers: 0, total: 0, spellings: 0, unnamed: 0 }, (v) => `$${v}`)).toBeNull();
  });

  it("keeps a credit at one supplier out of the total: being ahead there does not pay here", () => {
    const ahead = whatISupplierOwed({
      accounts: [...figures, { accountId: "acct-ahead", name: "Bay Fasteners", onAccount: true, owed: -75.5, model: "bills-minus-payments" }],
      papers,
      identity,
      settledBySupplier: coverage.settledBySupplier,
    });
    expect(ahead.total).toBe(1610);
    expect(ahead.ahead).toEqual([{ accountId: "acct-ahead", name: "Bay Fasteners", credit: 75.5 }]);
  });

  it("names an account it could not total instead of zeroing it", () => {
    const unread = whatISupplierOwed({
      accounts: [{ ...figures[0], unread: true }, figures[1]],
      papers,
      identity,
      settledBySupplier: coverage.settledBySupplier,
    });
    expect(unread.couldNotTotal).toEqual([{ accountId: ACCOUNT, name: "Northgate Electrical Distributors" }]);
    expect(unread.total).toBe(410);
  });

  it("is a DIFFERENT number from (b), and the gap is one supplier's own word against our tickets", () => {
    const bought = whatIBoughtNotSettled({ papers, settledBySupplier: coverage.settledBySupplier });
    expect(owed.total).not.toBe(bought.total);
    // Our tickets on that account say $1,300.00; the supplier's own open papers say $1,200.00.
    expect(r(bought.total - owed.total)).toBe(100);
  });
});

describe("the figure a supplier gives us, end to end through supplierBalance", () => {
  const account: SupplierAccountRow = {
    id: ACCOUNT,
    name: "Northgate Electrical Distributors",
    accountNumber: "SYN-0001",
    branchCode: null,
    onAccount: true,
    note: null,
    aliases: [{ alias: "Northgate Elec.", branchLabel: null }],
    bills: papers
      .filter((p) => p.supplierAccountId === ACCOUNT)
      .map((p) => ({
        id: p.id,
        supplier: p.supplier,
        billDate: "2026-09-01",
        amount: p.amount,
        status: p.status,
        jobId: null,
        jobName: null,
        invoiceNumber: null,
        isStatement: false,
      })),
    payments: [
      { id: "p1", amount: 6000, paidOn: "2026-09-15", method: "check", reference: null, note: null, voided: false },
      { id: "p2", amount: 300, paidOn: "2026-09-16", method: "check", reference: null, note: null, voided: true },
    ],
    supplierInvoices: [D_OPEN, D_CLOSED],
  };

  it("$1,360.93 never comes back: model B does not subtract payments already inside what they closed", () => {
    const balance = supplierBalance(account, TODAY);
    expect(balance.model).toBe("supplier-invoices");
    expect(balance.owed).toBe(1200);
    // What he actually SENT them is still a fact on the screen, it is just not an input here.
    expect(balance.paid).toBe(6000);
  });

  it("feeds (a) to the cent, so the card and the workbook cannot disagree", () => {
    const balance = supplierBalance(account, TODAY);
    const owed = whatISupplierOwed({
      accounts: [{ accountId: account.id, name: account.name, onAccount: true, owed: balance.owed, model: balance.model }],
      papers: papers.filter((p) => identity.get(p.id)?.accountId === ACCOUNT),
      identity,
      settledBySupplier: coverage.settledBySupplier,
    });
    expect(owed.total).toBe(1200);
  });
});

const r = (n: number) => Math.round(n * 100) / 100;
