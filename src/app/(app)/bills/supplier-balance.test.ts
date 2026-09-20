import { describe, it, expect } from "vitest";
import {
  copyPlace,
  daysBetweenYmd,
  isOnAccountBill,
  openBalanceOf,
  proposalTotals,
  reversedPurchaseIds,
  sayAge,
  supplierBalance,
  supplierNetIfPaidBy,
  supplierSaysBalance,
  type SupplierAccountRow,
  type SupplierBillRow,
  type SupplierInvoiceRow,
  type SupplierPaymentRow,
} from "./supplier-balance";

const bill = (over: Partial<SupplierBillRow> = {}): SupplierBillRow => ({
  id: Math.random().toString(36).slice(2),
  supplier: "Consolidated Electrical Dist.",
  billDate: "2026-08-01",
  amount: 100,
  status: "unpaid",
  jobId: null,
  jobName: null,
  invoiceNumber: null,
  isStatement: false,
  ...over,
});

const payment = (over: Partial<SupplierPaymentRow> = {}): SupplierPaymentRow => ({
  id: Math.random().toString(36).slice(2),
  amount: 100,
  paidOn: "2026-09-01",
  method: "check",
  reference: null,
  note: null,
  voided: false,
  ...over,
});

const account = (over: Partial<SupplierAccountRow> = {}): SupplierAccountRow => ({
  id: "acct-ced",
  name: "CED Truckee",
  accountNumber: "TR-34426",
  branchCode: "8802",
  onAccount: true,
  note: null,
  aliases: [],
  bills: [],
  payments: [],
  ...over,
});

describe("owed is unpaid bills minus live payments", () => {
  it("is the difference, not a count of ticked boxes", () => {
    const b = supplierBalance(
      account({
        bills: [bill({ amount: 5570.56 }), bill({ amount: 4366.24 }), bill({ amount: 2179.38 }), bill({ amount: 456.02 })],
        payments: [payment({ amount: 4000 })],
      }),
      "2026-09-18",
    );
    expect(b.charged).toBe(12572.2);
    expect(b.paid).toBe(4000);
    expect(b.owed).toBe(8572.2);
  });

  // "i pay them in chunks that never match the ticckets" - the whole reason this shape exists.
  // Three odd chunks against three odd tickets must land on the cent, not near it.
  it("takes chunks that match no ticket", () => {
    const b = supplierBalance(
      account({
        bills: [bill({ amount: 1513.71 }), bill({ amount: 162.32 }), bill({ amount: 3034.54 })],
        payments: [payment({ amount: 1000 }), payment({ amount: 2500.5 }), payment({ amount: 333.33 })],
      }),
      "2026-09-18",
    );
    expect(b.charged).toBe(4710.57);
    expect(b.paid).toBe(3833.83);
    expect(b.owed).toBe(876.74);
  });

  it("leaves a voided payment out of the money but keeps it on the record", () => {
    const acct = account({
      bills: [bill({ amount: 500 })],
      payments: [payment({ amount: 200 }), payment({ amount: 300, voided: true })],
    });
    const b = supplierBalance(acct, "2026-09-18");
    expect(b.paid).toBe(200);
    expect(b.livePayments).toBe(1);
    expect(b.owed).toBe(300);
    // The voided row is still in the account's own list - a void is crossed out, never erased.
    expect(acct.payments).toHaveLength(2);
  });

  it("can go negative when he has paid ahead of what is scanned", () => {
    const b = supplierBalance(account({ bills: [bill({ amount: 100 })], payments: [payment({ amount: 400 })] }), "2026-09-18");
    expect(b.owed).toBe(-300);
  });
});

describe("a register receipt is money spent, not money owed", () => {
  it("keeps paid-at-the-register bills out of the balance and still reports them", () => {
    const b = supplierBalance(
      account({ bills: [bill({ amount: 456.02 }), bill({ amount: 95.27, status: "paid" })] }),
      "2026-09-18",
    );
    expect(b.charged).toBe(456.02);
    expect(b.chargedBills).toBe(1);
    expect(b.settledAtRegister).toBe(95.27);
    expect(b.settledBills).toBe(1);
    expect(b.owed).toBe(456.02);
  });

  it("counts anything that is not 'paid' as still on account", () => {
    expect(isOnAccountBill({ status: "unpaid" })).toBe(true);
    expect(isOnAccountBill({ status: "" })).toBe(true);
    expect(isOnAccountBill({ status: "paid" })).toBe(false);
    expect(isOnAccountBill({ status: "PAID" })).toBe(false);
  });
});

describe("a pay-at-the-register supplier has no running balance", () => {
  // Erik's law for this card: an account marked on_account=false must not PRETEND to have a
  // balance. Zero would read as "paid up", which is a different sentence and not a true one.
  it("gives no owed figure at all", () => {
    const b = supplierBalance(account({ onAccount: false, bills: [bill({ amount: 40, status: "paid" })] }), "2026-09-18");
    expect(b.owed).toBeNull();
    expect(b.settledAtRegister).toBe(40);
    expect(b.unpaidOnRegisterAccount).toBe(false);
  });

  it("says so out loud when a register account is carrying unpaid bills", () => {
    const b = supplierBalance(account({ onAccount: false, bills: [bill({ amount: 40 })] }), "2026-09-18");
    expect(b.owed).toBeNull();
    expect(b.unpaidOnRegisterAccount).toBe(true);
    expect(b.charged).toBe(40);
  });
});

describe("how old the oldest unpaid bill is", () => {
  it("finds the oldest unpaid one and ages it against the org's today", () => {
    const b = supplierBalance(
      account({
        bills: [bill({ billDate: "2026-08-28" }), bill({ billDate: "2026-07-16" }), bill({ billDate: "2026-06-01", status: "paid" })],
      }),
      "2026-09-18",
    );
    expect(b.oldestUnpaid).toBe("2026-07-16");
    expect(b.oldestUnpaidDays).toBe(64);
  });

  it("ignores a bill with no date without losing its money", () => {
    const b = supplierBalance(account({ bills: [bill({ billDate: null, amount: 25 }), bill({ billDate: "2026-09-10", amount: 75 })] }), "2026-09-18");
    expect(b.oldestUnpaid).toBe("2026-09-10");
    expect(b.charged).toBe(100);
  });

  // The off-by-one that has bitten every date in this app: a date-only string parsed as midnight
  // lands a day early in Pacific. Both ends anchor at noon UTC instead.
  it("counts whole days without a timezone shift", () => {
    expect(daysBetweenYmd("2026-09-17", "2026-09-18")).toBe(1);
    expect(daysBetweenYmd("2026-09-18", "2026-09-18")).toBe(0);
    expect(daysBetweenYmd(null, "2026-09-18")).toBeNull();
  });

  it("says an age the way he would say it", () => {
    expect(sayAge(0)).toBe("from today");
    expect(sayAge(1)).toBe("1 day old");
    expect(sayAge(64)).toBe("64 days old");
    expect(sayAge(-3)).toBe("dated ahead");
    expect(sayAge(null)).toBe("no date on it");
  });
});

describe("the statement flag rides with the balance", () => {
  // Three of his imported CED documents are statements carrying two invoices each. A payment sheet
  // that offered to pin a cheque to one invoice number there would be offering a thing it cannot do.
  it("is set when any open bill is a statement", () => {
    expect(supplierBalance(account({ bills: [bill({ isStatement: true })] }), "2026-09-18").hasStatements).toBe(true);
    expect(supplierBalance(account({ bills: [bill()] }), "2026-09-18").hasStatements).toBe(false);
    // A statement already settled at the register says nothing about what is still open.
    expect(
      supplierBalance(account({ bills: [bill({ isStatement: true, status: "paid" })] }), "2026-09-18").hasStatements,
    ).toBe(false);
  });
});

describe("the last payment is the latest one he made", () => {
  it("goes by the day it was paid, not the order the rows arrived", () => {
    const b = supplierBalance(
      account({
        payments: [payment({ id: "older", paidOn: "2026-09-12", amount: 1000 }), payment({ id: "newer", paidOn: "2026-09-15", amount: 50 })],
      }),
      "2026-09-18",
    );
    expect(b.lastPayment?.id).toBe("newer");
  });

  it("is null when nothing has been paid", () => {
    expect(supplierBalance(account(), "2026-09-18").lastPayment).toBeNull();
  });
});

describe("what a merge proposal is holding", () => {
  // The sentence he decides on - "These 5 spellings look like one account, holding $12,572.20
  // between them" - is only true if the figure is summed from exactly the spellings listed beside
  // it. This is his real book on the night this shipped.
  it("adds up the spellings so the sentence is the sum of the list under it", () => {
    const totals = proposalTotals({
      id: "ced",
      suggestedName: "CED Truckee",
      spellings: [
        { alias: "Consolidated Electrical Distributors, Inc. (CED)", bills: 4, total: 5570.56, unpaid: 5570.56 },
        { alias: "Consolidated Electrical Dist.", bills: 8, total: 4366.24, unpaid: 4366.24 },
        { alias: "Consolidated Electrical Distributors, Inc.", bills: 6, total: 2179.38, unpaid: 2179.38 },
        { alias: "Consolidated Electrical Distributors", bills: 1, total: 456.02, unpaid: 456.02 },
        { alias: "CED", bills: 2, total: 120, unpaid: 0 },
      ],
    });
    expect(totals.bills).toBe(21);
    expect(totals.total).toBe(12692.2);
    expect(totals.unpaid).toBe(12572.2);
  });

  it("holds nothing when it holds nothing", () => {
    expect(proposalTotals({ id: "x", suggestedName: "x", spellings: [] })).toEqual({ bills: 0, total: 0, unpaid: 0 });
  });
});

describe("naming the two jobs a duplicated ticket sits on", () => {
  it("uses the job name, and says overhead when there is no job", () => {
    expect(copyPlace({ billId: "a", jobId: "j1", jobName: "13631 Northwoods", billDate: "2026-07-29", supplier: "CED" })).toBe(
      "13631 Northwoods",
    );
    expect(copyPlace({ billId: "b", jobId: null, jobName: null, billDate: "2026-08-28", supplier: "CED" })).toBe(
      "Overhead (no job)",
    );
  });
});

// ── THE NIGHT THE SUPPLIER SPOKE (2026-09-19, migration 0273) ───────────────────────────────────
//
// Erik got into his CED payment portal and downloaded every document. What is below is his real
// book on that night, to the cent: 20 open documents holding $3,845.14, CED's own headline of
// $3,819.66 for a cheque dated the 10th of October, $25.48 of discount still claimable today,
// $25.99 already lost, and $6,000 of payments that must never be subtracted from any of it.

const invoice = (over: Partial<SupplierInvoiceRow> = {}): SupplierInvoiceRow => ({
  id: Math.random().toString(36).slice(2),
  invoiceNumber: "8802-0000000",
  kind: "invoice",
  invoiceDate: "2026-09-02",
  dueDate: "2026-10-10",
  jobNameRaw: null,
  jobId: null,
  total: 100,
  openBalance: 100,
  closed: false,
  discountAmount: null,
  discountBy: null,
  sourceFile: null,
  ...over,
});

/** One open document: number, what is open on it, and the discount riding on it. */
const open = (
  number: string,
  openBalance: number,
  over: Partial<SupplierInvoiceRow> = {},
): SupplierInvoiceRow =>
  invoice({ invoiceNumber: `8802-${number}`, total: openBalance, openBalance, closed: false, ...over });

/**
 * HIS TWENTY OPEN CED DOCUMENTS, COPIED OUT OF THE DATABASE (2026-09-19).
 *
 * Every invoice number, date, open balance and discount below is the real row as loaded from the
 * 47 PDFs he downloaded from the CED portal. The fixture this replaced was invented - made-up
 * numbers like "1106310" chosen so the total came to $3,845.14 - which proves the arithmetic can
 * hit a target, not that it agrees with his supplier. A review caught it, and it mattered: the
 * fabricated rows spread the discount dates across four months, while in reality all seven live
 * discounts fall on the same day, 10 October.
 *
 * The one to look at is 8802-1107230: $225.47 with a $4.14 discount, reversed to the cent by open
 * credit memo 8802-1107337. CED does not offer a discount on money it has taken back, and the
 * $4.14 is exactly the gap between what this app used to say a cheque would be and what the portal
 * says. Gross $3,845.14, less $25.48 of live discount, is their own headline: $3,819.66.
 */
const CED_OPEN: SupplierInvoiceRow[] = [
  open("1103832", 10.29, { invoiceDate: "2026-07-22", jobNameRaw: "13631 NORTHWOODS", discountAmount: 11.87, discountBy: "2026-08-10" }),
  invoice({ invoiceNumber: "9019682437", kind: "service_charge", total: 31.26, openBalance: 31.26, closed: false, invoiceDate: "2026-07-25" }),
  open("1104147", 101.96, { invoiceDate: "2026-07-28", jobNameRaw: "13631 NORTHWOODS", discountAmount: 0.93, discountBy: "2026-08-10" }),
  open("1104268", 859.99, { invoiceDate: "2026-07-28", jobNameRaw: "13631 NORTHWOODS", discountAmount: 6.25, discountBy: "2026-08-10" }),
  open("1104644", 95.27, { invoiceDate: "2026-07-29", jobNameRaw: "85 WHITNEY PLACE", discountAmount: 1.48, discountBy: "2026-08-10" }),
  open("1104646", 36.54, { invoiceDate: "2026-07-29", jobNameRaw: "13631 NORTHWOODS", discountAmount: 0.34, discountBy: "2026-08-10" }),
  open("1104645", -31.86, { invoiceDate: "2026-08-06", jobNameRaw: "13631 NORTHWOODS", kind: "credit_memo" }),
  open("1105963", 84.37, { invoiceDate: "2026-08-19", jobNameRaw: "85 WHITNEY PL", discountAmount: 0.26, discountBy: "2026-09-10" }),
  open("1105997", 2.30, { invoiceDate: "2026-08-19", jobNameRaw: "10429 BADGER", discountAmount: 0.04, discountBy: "2026-09-10" }),
  open("1106188", 199.48, { invoiceDate: "2026-08-21", jobNameRaw: "13897 HARRINGBONE", discountAmount: 3.67, discountBy: "2026-09-10" }),
  open("1106249", 150.27, { invoiceDate: "2026-08-21", jobNameRaw: "13897 HERRING BONE", discountAmount: 1.15, discountBy: "2026-09-10" }),
  invoice({ invoiceNumber: "9019994306", kind: "service_charge", total: 15.16, openBalance: 15.16, closed: false, invoiceDate: "2026-08-25" }),
  open("1107088", 456.02, { invoiceDate: "2026-09-01", jobNameRaw: "13683 HILLSIDE", discountAmount: 4.70, discountBy: "2026-10-10" }),
  open("1107139", 59.17, { invoiceDate: "2026-09-01", jobNameRaw: "13683 HILLSIDE", discountAmount: 0.90, discountBy: "2026-10-10" }),
  // Billed, then reversed to the cent by the credit memo below it, then rebilled as 1107338.
  open("1107230", 225.47, { invoiceDate: "2026-09-03", jobNameRaw: "TTP 106", discountAmount: 4.14, discountBy: "2026-10-10" }),
  open("1107337", -225.47, { invoiceDate: "2026-09-03", jobNameRaw: "TTP 106", kind: "credit_memo" }),
  open("1107338", 223.29, { invoiceDate: "2026-09-03", jobNameRaw: "TTP106", discountAmount: 4.10, discountBy: "2026-10-10" }),
  open("1106969", 301.81, { invoiceDate: "2026-09-04", jobNameRaw: "13897 HERRINGBONE", discountAmount: 5.54, discountBy: "2026-10-10" }),
  open("1107695", 1062.18, { invoiceDate: "2026-09-16", jobNameRaw: "85 WHITNEY", discountAmount: 8.47, discountBy: "2026-10-10" }),
  open("1107820", 187.64, { invoiceDate: "2026-09-16", jobNameRaw: "85 WHITNEY", discountAmount: 1.77, discountBy: "2026-10-10" }),
];

/**
 * The shapes his own book does not happen to contain tonight, kept apart from it on purpose. A
 * fixture that mixes real rows with invented ones to reach a total is how the last one stopped
 * meaning anything.
 */
const EDGE_CASES: SupplierInvoiceRow[] = [
  // A discount printed with no day to claim it by: neither claimable nor lost, and said so.
  open("9900001", 97.6, { discountAmount: 1.95, discountBy: null }),
  // Open, and no open balance printed on it. Falls back to its own total rather than to zero.
  invoice({ invoiceNumber: "8802-9900002", total: 41.09, openBalance: null, closed: false }),
];

/** Documents CED has already settled. They are the other 27 of the 47, in miniature. */
const CED_CLOSED: SupplierInvoiceRow[] = [
  invoice({ invoiceNumber: "8802-1105868", total: 2950.17, openBalance: 0, closed: true }),
  invoice({ invoiceNumber: "8802-1103059", total: 47.92, openBalance: 0, closed: true, jobNameRaw: "5659 RHODESIA" }),
  invoice({ invoiceNumber: "8802-1103061", total: 114.4, openBalance: 0, closed: true, jobNameRaw: "STOCK" }),
  // A settled document with a discount date still in the future. It is DONE, and a closed
  // document must never put money into "still claimable" - that would be offering him a saving
  // on a bill he has already paid, which is a number with nothing behind it.
  invoice({
    invoiceNumber: "8802-1104200",
    total: 1200,
    openBalance: 0,
    closed: true,
    discountAmount: 12,
    discountBy: "2026-12-10",
  }),
];

const CED = [...CED_OPEN, ...CED_CLOSED];

/** His account exactly as it stood after the nine already-settled bills were flipped paid. */
const cedAccount = (over: Partial<SupplierAccountRow> = {}): SupplierAccountRow =>
  account({
    bills: [
      bill({ amount: 3034.54, isStatement: true, billDate: "2026-07-16" }),
      bill({ amount: 1513.71, billDate: "2026-08-20" }),
      bill({ amount: 162.32, isStatement: true, billDate: "2026-06-30" }),
      bill({ amount: 2650.36, billDate: "2026-09-02" }),
    ],
    payments: [
      payment({ id: "pay-aug", amount: 4000, paidOn: "2026-08-05" }),
      payment({ id: "pay-sep-1", amount: 1500, paidOn: "2026-09-02" }),
      payment({ id: "pay-sep-2", amount: 500, paidOn: "2026-09-12" }),
    ],
    supplierInvoices: CED,
    ...over,
  });

const TODAY = "2026-09-19";

/** Every number the balance hands back, flattened, so a forbidden figure cannot hide in a nested
 *  field the assertions did not happen to name. */
const everyNumberIn = (value: unknown): number[] => {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(everyNumberIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(everyNumberIn);
  return [];
};

describe("when the supplier has spoken, the balance is the supplier's", () => {
  it("reads CED's $3,845.14 and says which model said so", () => {
    const b = supplierBalance(cedAccount(), TODAY);
    expect(b.model).toBe("supplier-invoices");
    expect(b.owed).toBe(3845.14);
    expect(b.supplierSays?.gross).toBe(3845.14);
    expect(b.supplierSays?.openDocuments).toBe(20);
  });

  // THE BUG THIS WAVE EXISTS TO KILL. His $6,000 is already inside what CED closed. Subtracting it
  // from their open balances counts the same money twice, in the other direction, and produced
  // $1,360.93 against a portal reading $3,845.14 - a cheque $2,484.21 short.
  it("never produces $1,360.93", () => {
    const b = supplierBalance(cedAccount(), TODAY);
    expect(b.charged).toBe(7360.93);
    expect(b.paid).toBe(6000);
    expect(b.owed).not.toBe(1360.93);
    expect(everyNumberIn(b)).not.toContain(1360.93);
  });

  // "you have sent them $6,000.00 since 5 August" beside "CED says you owe $3,845.14". Two true
  // facts. The ledger is what he ticks off against his bank statement; it is not an input any more.
  it("keeps the payment ledger whole and out of the arithmetic", () => {
    const b = supplierBalance(cedAccount(), TODAY);
    expect(b.paid).toBe(6000);
    expect(b.livePayments).toBe(3);
    expect(b.firstPayment?.paidOn).toBe("2026-08-05");
    expect(b.lastPayment?.paidOn).toBe("2026-09-12");
    expect(b.owed).toBe(3845.14);
  });

  it("does not let a voided payment change a supplier balance either way", () => {
    const withVoid = cedAccount();
    withVoid.payments = [...withVoid.payments, payment({ amount: 750, paidOn: "2026-09-15", voided: true })];
    const b = supplierBalance(withVoid, TODAY);
    expect(b.paid).toBe(6000);
    expect(b.owed).toBe(3845.14);
  });

  it("ages the oldest open document against the org's today", () => {
    const b = supplierBalance(cedAccount(), TODAY);
    expect(b.supplierSays?.oldestOpen).toBe("2026-07-22");
    // 22 July to 19 September. Two months past due on an account charging 1.5% a month, which is
    // where his $60.42 of service charges came from.
    expect(b.supplierSays?.oldestOpenDays).toBe(59);
  });
});

describe("gross is not a cheque", () => {
  // The portal prints both and they are $25.48 apart. A man writing a cheque has to know which
  // number he is writing, so both are named rather than one of them being picked for him.
  it("reproduces CED's own headline for a cheque dated 10 October", () => {
    const figure = supplierNetIfPaidBy(CED, "2026-10-10", TODAY);
    expect(figure.gross).toBe(3845.14);
    expect(figure.discount).toBe(25.48);
    expect(figure.net).toBe(3819.66);
  });

  it("costs him nothing to wait until the 10th, because every live discount falls on it", () => {
    // His real book has all seven live discounts dated 2026-10-10. The invented fixture this
    // replaced spread them over four months, which made "what waiting costs" look like a routine
    // number instead of the zero it actually is tonight. The machinery still works - the next test
    // writes a cheque past the last deadline and forfeits the lot.
    const figure = supplierNetIfPaidBy(CED, "2026-10-10", TODAY);
    expect(figure.forfeited).toBe(0);
    expect(figure.forfeitedInvoices).toEqual([]);
  });

  it("is a bigger saving if he writes it this week", () => {
    // Same $25.48 today as on the 10th: nothing expires in between. Writing it now and writing it
    // on the deadline cost him exactly the same, which is a fact worth being able to state.
    const figure = supplierNetIfPaidBy(CED, TODAY, TODAY);
    expect(figure.discount).toBe(25.48);
    expect(figure.net).toBe(3819.66);
    expect(figure.forfeited).toBe(0);
    expect(supplierBalance(cedAccount(), TODAY).supplierSays?.netIfPaidToday).toBe(3819.66);
  });

  it("gives up every discount on a cheque written after the last deadline", () => {
    const figure = supplierNetIfPaidBy(CED, "2026-12-01", TODAY);
    expect(figure.discount).toBe(0);
    expect(figure.net).toBe(3845.14);
    expect(figure.forfeited).toBe(25.48);
  });

  it("never invents a discount on a date it cannot read", () => {
    const figure = supplierNetIfPaidBy(CED, "sometime", TODAY);
    expect(figure.gross).toBe(3845.14);
    expect(figure.discount).toBe(0);
    expect(figure.net).toBe(3845.14);
  });
});

describe("the discount he is still owed, and the discount he has already lost", () => {
  it("splits it into claimable, expired and undated", () => {
    const says = supplierSaysBalance(CED, TODAY);
    // $25.48, not the $29.62 the raw column sums to: the $4.14 on 8802-1107230 is not claimable
    // because credit memo 8802-1107337 reversed that invoice to the cent, and CED does not
    // discount money it has taken back. This is the figure their own portal prints.
    expect(says?.discountStillClaimable).toBe(25.48);
    // Gone while $60.42 of late interest was being charged at 1.5% a month.
    expect(says?.discountExpiredUnclaimed).toBe(25.99);
    // His real book has no undated discount. The shape is covered by EDGE_CASES below.
    expect(says?.discountUndated).toBe(0);
    expect(supplierSaysBalance([...CED, ...EDGE_CASES], TODAY)?.discountUndated).toBe(1.95);
  });

  it("names the soonest deadline still ahead and what is riding on it", () => {
    const says = supplierSaysBalance(CED, TODAY);
    expect(says?.nextDiscountBy).toBe("2026-10-10");
    // Every live discount shares that day, so the soonest deadline carries all of it - and the
    // reversed $4.14 is not in the sum.
    expect(says?.nextDiscountAmount).toBe(25.48);
  });

  it("adds up two deadlines that fall on the same day instead of naming half of one", () => {
    const says = supplierSaysBalance(CED, "2026-09-26");
    expect(says?.nextDiscountBy).toBe("2026-10-10");
    // Six invoices share 10 October and they are summed, never half-named.
    expect(says?.nextDiscountAmount).toBe(25.48);
    expect(says?.discountStillClaimable).toBe(25.48);
  });

  it("takes no discount off a document the supplier has already settled", () => {
    // 8802-1104200 is closed and carries $12.00 claimable until December. Counting it would be
    // offering him a saving on a bill he has already paid.
    const says = supplierSaysBalance(CED, TODAY);
    expect(says?.discountStillClaimable).toBe(25.48);
    expect(supplierNetIfPaidBy(CED, "2026-12-10", TODAY).discount).toBe(0);
  });
});

describe("what one open document holds", () => {
  it("uses the supplier's open balance when they printed one", () => {
    expect(openBalanceOf(invoice({ total: 523.47, openBalance: 84.37 }))).toBe(84.37);
  });

  // The lean matches isOnAccountBill: a missing figure shows up as money he may still owe and gets
  // argued with on screen, rather than quietly making the number he is trusting too small.
  it("falls back to the total when they did not", () => {
    expect(openBalanceOf(invoice({ total: 41.09, openBalance: null }))).toBe(41.09);
    // CED printed an open balance on every one of his twenty, so his own book assumes nothing.
    expect(supplierSaysBalance(CED, TODAY)?.assumedFromTotal).toBe(0);
    // The shape still has to work, so it is proven on the edge-case row instead of on a real one.
    expect(supplierSaysBalance([...CED, ...EDGE_CASES], TODAY)?.assumedFromTotal).toBe(1);
  });

  it("keeps a credit memo's negative sign, because it is money they owe him", () => {
    expect(openBalanceOf(invoice({ kind: "credit_memo", total: -42.18, openBalance: -42.18 }))).toBe(-42.18);
    expect(supplierSaysBalance(CED, TODAY)?.creditMemos).toBe(2);
  });

  it("never lets a negative discount amount ADD to a cheque", () => {
    const odd = [open("1106999", 100, { discountAmount: -5, discountBy: "2026-10-10" })];
    expect(supplierNetIfPaidBy(odd, "2026-10-10", TODAY).net).toBe(100);
    expect(supplierSaysBalance(odd, TODAY)?.discountStillClaimable).toBe(0);
  });
});

describe("the two models are never mixed", () => {
  // Every account in his book except CED. Nothing about this shape has changed.
  it("leaves an account with no supplier documents exactly where it was", () => {
    const b = supplierBalance(
      account({ bills: [bill({ amount: 5570.56 }), bill({ amount: 456.02 })], payments: [payment({ amount: 2000 })] }),
      TODAY,
    );
    expect(b.model).toBe("bills-minus-payments");
    expect(b.supplierSays).toBeNull();
    expect(b.owed).toBe(4026.58);
  });

  it("treats an empty supplier list as no supplier data at all", () => {
    const b = supplierBalance(account({ bills: [bill({ amount: 500 })], payments: [payment({ amount: 100 })], supplierInvoices: [] }), TODAY);
    expect(b.model).toBe("bills-minus-payments");
    expect(b.owed).toBe(400);
  });

  // Not the same sentence as "no data". The supplier has answered, and the answer is nothing owed.
  it("says paid up when every document the supplier issued is closed", () => {
    const b = supplierBalance(
      account({ bills: [bill({ amount: 500 })], payments: [payment({ amount: 100 })], supplierInvoices: CED_CLOSED }),
      TODAY,
    );
    expect(b.model).toBe("supplier-invoices");
    expect(b.owed).toBe(0);
    expect(b.supplierSays?.openDocuments).toBe(0);
    expect(b.supplierSays?.discountStillClaimable).toBe(0);
    // Model A would have said $400 here, and the supplier says otherwise.
    expect(b.charged).toBe(500);
    expect(b.paid).toBe(100);
  });

  it("shows a register account the supplier's own figure and says the contradiction out loud", () => {
    // on_account = false means no RUNNING balance of ours. A document the supplier issued and
    // still calls open is not us pretending - it is a fact with a file behind it - so it is shown,
    // and the flag goes up beside it rather than the number being swallowed.
    const b = supplierBalance(account({ onAccount: false, supplierInvoices: [open("1106500", 212.5)] }), TODAY);
    expect(b.owed).toBe(212.5);
    expect(b.openDocumentsOnRegisterAccount).toBe(true);
    // The OLD flag counts unpaid bills and the card quotes a bill count and `charged` off it.
    // There are no unpaid bills here, so it stays down and that sentence never gets to say
    // "0 bills ... holding $0.00".
    expect(b.unpaidOnRegisterAccount).toBe(false);
    expect(b.chargedBills).toBe(0);
    // Still no invented balance for a register account nobody has said anything about.
    expect(supplierBalance(account({ onAccount: false }), TODAY).owed).toBeNull();
    expect(supplierBalance(account({ onAccount: false }), TODAY).openDocumentsOnRegisterAccount).toBe(false);
  });

  it("still raises the old bills flag on a register account carrying unpaid bills", () => {
    const b = supplierBalance(account({ onAccount: false, bills: [bill({ amount: 40 })] }), TODAY);
    expect(b.unpaidOnRegisterAccount).toBe(true);
    expect(b.openDocumentsOnRegisterAccount).toBe(false);
  });
});


// ── WHICH PURCHASE CAME BACK ────────────────────────────────────────────────────────────────────
//
// `reversedPurchaseIds` is the rule standing between "Record It As A Bill" and a customer being
// charged for merchandise Erik sent back. It answers a question that never expires, so it is the
// one reading in this file that keeps working after CED closes the pair - and the one whose wrong
// answer is silent in both directions: the purchase he KEPT becomes unbillable, and the one he
// returned keeps a live button on it.

describe("reversedPurchaseIds - which purchase a credit memo took back", () => {
  it("pairs his real return to the cent, and still does after CED closes the pair", () => {
    // 8802-1107230 ($225.47, five light almond USB receptacles) taken straight back off the
    // account by 8802-1107337 (-$225.47). Both documents are open tonight.
    const book = [
      open("1107230", 225.47),
      open("1107337", -225.47, { kind: "credit_memo" }),
    ];
    expect([...reversedPurchaseIds(book)]).toEqual([book[0].id]);

    // The day he pays the September statement CED marks both closed. "Did he keep what was on
    // this invoice?" is not a question a settled balance answers differently.
    const settled = book.map((i) => ({ ...i, closed: true, openBalance: 0 }));
    expect([...reversedPurchaseIds(settled)]).toEqual([settled[0].id]);
  });

  it("refuses to guess between two purchases at one total with a single credit memo", () => {
    // Two $150.00 orders, one $150.00 return. Nothing in these rows says which one came back, and
    // the old rule took whichever the caller's ORDER BY happened to put first - so the answer
    // depended on the query, and the two callers do not sort the same way.
    const a = open("1150001", 150);
    const b = open("1150002", 150);
    const memo = open("1150003", -150, { kind: "credit_memo" });
    expect([...reversedPurchaseIds([a, b, memo])]).toEqual([]);
    // The same rows the other way round give the same answer, which is the whole point.
    expect([...reversedPurchaseIds([b, a, memo])]).toEqual([]);
  });

  it("pairs both twins when each one has its own credit memo", () => {
    // Nothing is being guessed at here: two returns, two purchases, same cent. The guard has to
    // keep firing or two real returns walk back onto the Record button.
    const a = open("1150001", 150);
    const b = open("1150002", 150);
    const memos = [open("1150003", -150, { kind: "credit_memo" }), open("1150004", -150, { kind: "credit_memo" })];
    expect([...reversedPurchaseIds([a, b, ...memos])].sort()).toEqual([a.id, b.id].sort());
  });

  it("never lets a statement or a late-payment charge spend a credit memo", () => {
    // A statement carries the same money as the invoices inside it. If it could spend the memo,
    // the memo would be gone and the real $225.47 return would read as merchandise he kept.
    const statement = open("1150010", 225.47, { kind: "statement" });
    const invoiceRow = open("1107230", 225.47);
    const memo = open("1107337", -225.47, { kind: "credit_memo" });
    expect([...reversedPurchaseIds([statement, invoiceRow, memo])]).toEqual([invoiceRow.id]);

    const interest = open("1150011", 60.42, { kind: "service_charge" });
    expect([...reversedPurchaseIds([interest, open("1150012", -60.42, { kind: "credit_memo" })])]).toEqual([]);
  });

  it("keeps an open credit memo away from a settled purchase", () => {
    const settledPurchase = invoice({ invoiceNumber: "8802-1150020", total: 95.27, openBalance: 0, closed: true });
    const liveMemo = open("1150021", -95.27, { kind: "credit_memo" });
    expect([...reversedPurchaseIds([settledPurchase, liveMemo])]).toEqual([]);
  });

  it("judges a row with no kind on it by its amount alone, the way it always has", () => {
    // `InvoiceBalanceShape` has no `kind`, and a caller holding only the four balance fields must
    // still get an answer rather than a silent empty set.
    const bare = [
      { id: "p-1", total: 225.47, openBalance: 225.47, closed: false },
      { id: "c-1", total: -225.47, openBalance: -225.47, closed: false },
    ];
    expect([...reversedPurchaseIds(bare)]).toEqual(["p-1"]);
  });
});
