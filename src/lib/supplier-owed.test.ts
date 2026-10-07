import { describe, it, expect } from "vitest";
import {
  NO_SUPPLIER_NAME_GROUP,
  NO_SUPPLIER_NAME_LABEL,
  billSettledLabel,
  billSettledTone,
  isPaidBill,
  openOwed,
  boughtHowFace,
  flipBoughtHow,
  indexSupplierIdentity,
  isStillOwed,
  notOnAnAccountSentence,
  papersOnNoAccountAside,
  resolveSupplierPapers,
  supplierAccountForPaper,
  supplierBalancesUnread,
  supplierCoverage,
  supplierFigureUnread,
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
  it("answers by the number when it has it, and by the status word when it has not; never a duplicate", () => {
    expect(isStillOwed({ status: "unpaid" })).toBe(true);
    expect(isStillOwed({ status: null })).toBe(true);
    expect(isStillOwed({ status: "PAID" })).toBe(false);
    expect(isStillOwed({ status: "unpaid", superseded: true })).toBe(false);
    expect(isStillOwed({ status: "unpaid", supersededByBillId: "x" })).toBe(false);
    // ONE NUMBER PER BILL (0383): what is open decides, whatever the word says.
    expect(isStillOwed({ status: "unpaid", amount: 523.47, amountPaid: 523.47 })).toBe(false);
    expect(isStillOwed({ status: "paid", amount: 523.47, amountPaid: 200 })).toBe(true);
    expect(isStillOwed({ status: "unpaid", amount: -51.58, amountPaid: 0 })).toBe(true);
    expect(isStillOwed({ status: "unpaid", amount: -51.58, amountPaid: -51.58 })).toBe(false);
    expect(isStillOwed({ status: "unpaid", amount: 10, amountPaid: 9.996 })).toBe(false);
    expect(openOwed({ status: "unpaid", amount: 523.47, amountPaid: 200 })).toBe(323.47);
    expect(openOwed({ status: "unpaid", amount: 523.47 })).toBe(523.47);
    expect(openOwed({ status: "paid", amount: 523.47 })).toBe(0);
    expect(openOwed({ status: "unpaid", amount: 523.47, amountPaid: 100, superseded: true })).toBe(0);
  });
});

describe("what bills.status says, and what a row says about itself", () => {
  it("the status word is the number's, and the control flips it", () => {
    expect(isPaidBill({ status: "paid" })).toBe(true);
    expect(isPaidBill({ status: "unpaid" })).toBe(false);
    expect(isPaidBill({ status: null })).toBe(false);
    expect(flipBoughtHow({ status: "paid" })).toBe("unpaid");
    expect(flipBoughtHow({ status: "unpaid" })).toBe("paid");
  });

  it("gives a row the same words wherever it is drawn: Paid, Part-Paid with its figures, On Account", () => {
    const fmt = (v: number) => `$${v.toFixed(2)}`;
    expect(billSettledLabel({ status: "paid", amount: 100, amountPaid: 100 }, fmt)).toBe("Paid");
    expect(billSettledLabel({ status: "unpaid", amount: 100, amountPaid: 0 }, fmt)).toBe("On Account");
    expect(billSettledLabel({ status: "unpaid", amount: 523.47, amountPaid: 200 }, fmt)).toBe("Part-Paid $200.00 Of $523.47");
    expect(billSettledLabel({ status: "unpaid", amount: 100, amountPaid: 50, superseded: true }, fmt)).toBe("Set Aside");
    // Without the number, the word decides, as before 0383.
    expect(billSettledLabel({ status: "paid" }, fmt)).toBe("Paid");
    expect(billSettledLabel({ status: "unpaid" }, fmt)).toBe("On Account");
    // "Settled · X Says" is gone: the supplier's closed paper over an open bill is a Reconcile row.
    expect(billSettledLabel({ status: "unpaid", amount: 100, amountPaid: 0 }, fmt)).not.toContain("Says");
  });

  it("colours the badge by the same number that chooses its words", () => {
    expect(billSettledTone({ status: "paid" })).toBe("green");
    expect(billSettledTone({ status: "unpaid" })).toBe("amber");
    expect(billSettledTone({ status: "unpaid", amount: 100, amountPaid: 100 })).toBe("green");
    expect(billSettledTone({ status: "paid", amount: 100, amountPaid: 40 })).toBe("amber");
  });

  it("the control's face says the deed: Mark Paid on an open bill, Mark On Account on a paid one", () => {
    expect(boughtHowFace({ status: "unpaid" })).toBe("Mark Paid");
    expect(boughtHowFace({ status: "paid" })).toBe("Mark On Account");
  });
});

/**
 * COULD THIS FIGURE BE TOTALLED AT ALL - ONE PLACE (8a982483, finding 4).
 *
 * It was spelled out at four doors: /bills' page, that page's per-account `unread`, the Suppliers
 * card's `cantTotal`, and Nort's read. Nort's copy left out THE SUPPLIER'S OWN PAPERS, and losing
 * that read does not read as a gap: an account with no documents drops from model B to model A,
 * which subtracts payments already inside what the supplier closed. So /bills showed "Couldn't
 * Total Just Now" while Nort answered the same question with that number, and Erik acts on Nort's
 * answers.
 */
describe("a figure built on a read that failed is named, not guessed", () => {
  it("counts the supplier's own papers as one of the reads a balance stands on", () => {
    expect(supplierBalancesUnread({ bills: false, payments: false, theirOwnPapers: false })).toBe(false);
    expect(supplierBalancesUnread({ bills: true, payments: false, theirOwnPapers: false })).toBe(true);
    expect(supplierBalancesUnread({ bills: false, payments: true, theirOwnPapers: false })).toBe(true);
    // THE ONE THAT WAS MISSING.
    expect(supplierBalancesUnread({ bills: false, payments: false, theirOwnPapers: true })).toBe(true);
  });

  it("names an on-account figure it cannot total, whether or not the supplier's own papers stand beside it", () => {
    const unread = (over: { onAccount?: boolean; model?: "supplier-invoices" | "my-open-bills"; balancesUnread?: boolean }) =>
      supplierFigureUnread({ onAccount: true, model: "my-open-bills", balancesUnread: true, ...over });
    expect(unread({})).toBe(true);
    // Since 0383 every account's figure is our own open bills, so their papers do not save it.
    expect(unread({ model: "supplier-invoices" })).toBe(true);
    // A register supplier keeps no running balance to fail to total.
    expect(unread({ onAccount: false })).toBe(false);
    expect(unread({ balancesUnread: false })).toBe(false);
  });
});

describe("(b) what did I buy and not settle yet", () => {
  const bought = whatIBoughtNotSettled({ papers });

  it("is every one of our own open tickets, by the number, to the cent", () => {
    // t1 500 + t2 3034.54 + t4 120 + t5 250 + t7 40 + t8 800
    expect(bought.total).toBe(4744.54);
    expect(bought.papers).toBe(6);
    expect(bought.ids).toEqual(["t1", "t2", "t4", "t5", "t7", "t8"]);
  });

  it("counts what is OPEN on a paper, so a part-paid bill counts its balance and a paid one nothing (0383)", () => {
    const byNumber = whatIBoughtNotSettled({
      papers: [
        { id: "a", supplierAccountId: ACCOUNT, supplier: "x", amount: 523.47, amountPaid: 200, status: "unpaid" },
        { id: "b", supplierAccountId: ACCOUNT, supplier: "x", amount: 100, amountPaid: 100, status: "unpaid" },
        { id: "c", supplierAccountId: ACCOUNT, supplier: "x", amount: -20, amountPaid: 0, status: "unpaid" },
      ],
    });
    expect(byNumber.total).toBe(303.47);
    expect(byNumber.ids).toEqual(["a", "c"]);
  });

  it("the ticket their closed paper covers is still counted: that disagreement is Reconcile's row, not a figure's exclusion", () => {
    expect([...coverage.settledBySupplier]).toEqual(["t2"]);
    expect(bought.ids).toContain("t2");
  });
});

describe("(a) what do I owe this supplier", () => {
  const figures: SupplierAccountFigure[] = [
    { accountId: ACCOUNT, name: "Northgate Electrical Distributors", onAccount: true, owed: 1200, model: "supplier-invoices", theirs: 1200 },
    { accountId: REGISTER, name: "Cutter Rentals", onAccount: false, owed: null, model: "my-open-bills" },
  ];
  const owed = whatISupplierOwed({ accounts: figures, papers, identity });

  it("leads with one number", () => {
    // 1200 their own papers + 120 on a register supplier + 250 unfiled + 40 unnamed
    expect(owed.total).toBe(1610);
  });

  it("takes the account's figure as handed in, and says it is our open bills", () => {
    const line = owed.lines.find((l) => l.accountId === ACCOUNT);
    expect(line).toMatchObject({ owed: 1200, how: "my-open-bills" });
  });

  it("falls back to our own open tickets where there is no account", () => {
    expect(owed.lines.find((l) => l.name === "Ridgeline Lumber")).toMatchObject({ owed: 250, how: "my-tickets-no-account", papers: 1 });
  });

  it("counts the paper with no supplier name under a name of its own, never silently", () => {
    expect(owed.lines.find((l) => l.name === NO_SUPPLIER_NAME_LABEL)).toMatchObject({ owed: 40, papers: 1 });
    expect(owed.notOnAnAccount).toEqual({ papers: 2, total: 290, spellings: 1, unnamed: 1, credits: 0, creditPapers: 0 });
  });

  it("says how many papers are not on an account yet, and says nothing when none are", () => {
    expect(notOnAnAccountSentence(owed.notOnAnAccount, (v) => `$${v.toFixed(2)}`)).toBe(
      "$290.00 of this is on 2 papers that are not on a supplier account yet, counted under the name on the paper. 1 of them has no supplier name on it at all.",
    );
    expect(notOnAnAccountSentence({ papers: 0, total: 0, spellings: 0, unnamed: 0, credits: 0, creditPapers: 0 }, (v) => `$${v}`)).toBeNull();
  });

  /** ONE PAPER IS "that is". Three screens and Nort all say this sentence out loud; "1 paper that
   *  are" reads as a machine talking, and he stops reading what a machine wrote. */
  it("gets the verb right for a single paper", () => {
    expect(
      notOnAnAccountSentence({ papers: 1, total: 475.5, spellings: 1, unnamed: 0, credits: 0, creditPapers: 0 }, (v) => `$${v.toFixed(2)}`),
    ).toBe("$475.50 of this is on 1 paper that is not on a supplier account yet, counted under the name on the paper.");
  });

  /**
   * ── "OF THIS" IS TRUE ON THE SUPPLIERS CARD AND FALSE ON /reconcile ────────────────────────────
   *
   * The sentence above opens "$X OF THIS is on...", and on the Suppliers card that is exactly right:
   * the figure over it is what he owes and these papers are inside it. Reconcile's lead is a different
   * figure — how far his own tickets and his suppliers' own papers are APART — and a paper on no
   * supplier account is in NEITHER side of it, so it contributes nothing at all to the gap. Reusing
   * the card's sentence there told him that $475.50 of the $1,087.00 he was about to ring the counter
   * about was sitting on an unfiled paper, which was false, and it broke the rule that nothing leaves
   * a figure without the screen saying so — by saying the opposite.
   *
   * Both sentences are over ONE `NotOnAnAccount` and neither adds anything up. This test is what keeps
   * the wrong one from being reached for again.
   */
  it("has a second sentence for a screen where that money is in NO figure, and it never says of this", () => {
    const pile = { papers: 1, total: 475.5, spellings: 1, unnamed: 0, credits: 0, creditPapers: 0 };
    const aside = papersOnNoAccountAside(pile, (v) => `$${v.toFixed(2)}`)!;
    expect(aside).toBe(
      "$475.50 is on 1 paper that is not on a supplier account yet, counted under the name on the paper. A paper on no account has no supplier balance to disagree with, so none of it is in a gap figure on this page.",
    );
    expect(aside).not.toContain("of this");
    // Same grammar, same credit clause, same zero rule: nothing to say means no sentence.
    expect(papersOnNoAccountAside({ ...pile, papers: 2, unnamed: 1, credits: 51.58, creditPapers: 1 }, (v) => `$${v.toFixed(2)}`)).toContain(
      "2 papers that are not on a supplier account yet, counted under the name on the paper.",
    );
    expect(papersOnNoAccountAside({ ...pile, credits: 51.58, creditPapers: 1 }, (v) => `$${v.toFixed(2)}`)).toContain(
      "A credit of $51.58 on 1 of them is money back, so it is not in that figure either.",
    );
    expect(papersOnNoAccountAside({ papers: 0, total: 0, spellings: 0, unnamed: 0, credits: 0, creditPapers: 0 }, (v) => `$${v}`)).toBeNull();
    expect(papersOnNoAccountAside(null, (v) => `$${v}`)).toBeNull();
  });

  /**
   * A RETURN ON A SPELLING NOBODY HAS FILED YET MADE THE ONE NUMBER TOO SMALL.
   *
   * This app files a return as a NEGATIVE on-account bill, and 69 of his 119 papers are on no
   * account under 43 spellings, so a credit-only spelling is an ordinary Tuesday: a register-paid
   * purchase and then an on-account return, or one real supplier spelled two ways. The account arm
   * sent a negative figure to `ahead` and the loose arm meant to - its guard read
   * `g.total <= 0.005 && g.papers === 0`, and a group only exists once a paper lands in it, so
   * `papers === 0` was unreachable and the guard was dead. The credit went into the headline, the
   * workbook printed a negative "owed" row, and Nort read a negative debt out loud.
   */
  it("reports a credit on an unfiled spelling beside the total, never inside it", () => {
    const withReturn = [
      ...papers,
      // A return, filed the way this app files returns, on a spelling that is on no account.
      { id: "t9", supplierAccountId: null, supplier: "Summit Supply", amount: -51.58, status: "unpaid" },
    ];
    const id2 = resolveSupplierPapers(withReturn, index);
    const owedBack = whatISupplierOwed({
      accounts: figures,
      papers: withReturn,
      identity: id2,
    });

    // THE ONE NUMBER DOES NOT MOVE. It was $1,558.42 before this - $51.58 less than he owes.
    expect(owedBack.total).toBe(1610);
    // No negative row reaches the workbook's Owed To Suppliers or Nort's by_supplier.
    expect(owedBack.lines.every((l) => l.owed > 0)).toBe(true);
    expect(owedBack.lines.find((l) => l.name === "Summit Supply")).toBeUndefined();
    // It is NAMED beside the total, under the spelling on the paper, with no account id to call it.
    expect(owedBack.ahead).toContainEqual({ accountId: "", name: "Summit Supply", credit: 51.58 });
    // And the papers-not-on-an-account door still counts it: it is a paper he has to go and file.
    expect(owedBack.notOnAnAccount).toEqual({ papers: 3, total: 290, spellings: 2, unnamed: 1, credits: 51.58, creditPapers: 1 });
  });

  /** And the sentence says the credit out loud, or he could divide $290 by 3 papers and be wrong. */
  it("says the credit it left out, in the same sentence as the papers", () => {
    const withReturn = [...papers, { id: "t9", supplierAccountId: null, supplier: "Summit Supply", amount: -51.58, status: "unpaid" }];
    const owedBack = whatISupplierOwed({
      accounts: figures,
      papers: withReturn,
      identity: resolveSupplierPapers(withReturn, index),
    });
    expect(notOnAnAccountSentence(owedBack.notOnAnAccount, (v) => `$${v.toFixed(2)}`)).toBe(
      "$290.00 of this is on 3 papers that are not on a supplier account yet, counted under the name on the paper. 1 of them has no supplier name on it at all. A credit of $51.58 on 1 of them is money back, so it is not in the figure.",
    );
  });

  /** A spelling whose papers cancel out: counted as papers to file, no row, no credit, no money. */
  it("puts a spelling that nets to nothing on no list of money", () => {
    const evens = [
      ...papers,
      { id: "t9", supplierAccountId: null, supplier: "Summit Supply", amount: 100, status: "unpaid" },
      { id: "t10", supplierAccountId: null, supplier: "Summit Supply", amount: -100, status: "unpaid" },
    ];
    const owedEven = whatISupplierOwed({
      accounts: figures,
      papers: evens,
      identity: resolveSupplierPapers(evens, index),
    });
    expect(owedEven.total).toBe(1610);
    expect(owedEven.lines.find((l) => l.name === "Summit Supply")).toBeUndefined();
    expect(owedEven.ahead.find((a) => a.name === "Summit Supply")).toBeUndefined();
    expect(owedEven.notOnAnAccount).toMatchObject({ papers: 4, total: 290, credits: 0, creditPapers: 0 });
  });

  it("keeps a credit at one supplier out of the total: being ahead there does not pay here", () => {
    const ahead = whatISupplierOwed({
      accounts: [...figures, { accountId: "acct-ahead", name: "Bay Fasteners", onAccount: true, owed: -75.5, model: "my-open-bills" }],
      papers,
      identity,
    });
    expect(ahead.total).toBe(1610);
    expect(ahead.ahead).toEqual([{ accountId: "acct-ahead", name: "Bay Fasteners", credit: 75.5 }]);
  });

  it("names an account it could not total instead of zeroing it", () => {
    const unread = whatISupplierOwed({
      accounts: [{ ...figures[0], unread: true }, figures[1]],
      papers,
      identity,
    });
    expect(unread.couldNotTotal).toEqual([{ accountId: ACCOUNT, name: "Northgate Electrical Distributors" }]);
    expect(unread.total).toBe(410);
  });

  it("takes an account's figure as handed in and never re-totals it; (b) is the papers by the number", () => {
    const bought = whatIBoughtNotSettled({ papers });
    // The account figure was handed in as 1200 and stands; the papers on it come to 4334.54.
    expect(owed.lines.find((l) => l.accountId === ACCOUNT)?.owed).toBe(1200);
    expect(whatIBoughtNotSettled({ papers: papers.filter((p) => identity.get(p.id)?.accountId === ACCOUNT) }).total).toBe(4334.54);
    expect(r(bought.total - owed.total)).toBe(3134.54);
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
        amountPaid: null,
        status: p.status,
        superseded: !!(p as { supersededByBillId?: string }).supersededByBillId,
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

  it("$1,360.93 never comes back: the figure is what is open on our bills, and the payments are never subtracted again", () => {
    const balance = supplierBalance(account, TODAY);
    expect(balance.model).toBe("supplier-invoices");
    // t1 open; t3 is a duplicate set aside. Their own figure stands beside it.
    expect(balance.owed).toBe(500);
    expect(balance.supplierSays?.gross).toBe(1200);
    // What he actually SENT them is still a fact on the screen, it is just not an input here.
    expect(balance.paid).toBe(6000);
  });

  it("feeds (a) to the cent, so the card and the workbook cannot disagree", () => {
    const balance = supplierBalance(account, TODAY);
    const owed = whatISupplierOwed({
      accounts: [{ accountId: account.id, name: account.name, onAccount: true, owed: balance.owed, model: balance.model }],
      papers: papers.filter((p) => identity.get(p.id)?.accountId === ACCOUNT),
      identity,
    });
    expect(owed.total).toBe(500);
  });
});

const r = (n: number) => Math.round(n * 100) / 100;
