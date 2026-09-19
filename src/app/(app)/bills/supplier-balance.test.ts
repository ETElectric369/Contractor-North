import { describe, it, expect } from "vitest";
import {
  copyPlace,
  daysBetweenYmd,
  isOnAccountBill,
  proposalTotals,
  sayAge,
  supplierBalance,
  type SupplierAccountRow,
  type SupplierBillRow,
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
