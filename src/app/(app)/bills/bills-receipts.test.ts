import { describe, it, expect } from "vitest";
import { formatCurrency } from "@/lib/utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenBill } from "@/lib/open-counts";
import { shortSupplierName } from "@/lib/supplier-name";
import { billSettledLabel } from "@/lib/supplier-owed";

/**
 * THE ONE WORD ON THIS SCREEN THAT INVITES A DOUBLE-COUNT.
 *
 * `bills.status` has never meant "a payment exists". It means how the bill was bought: on the
 * account, or settled at the counter. The supplier balance reads it that way - owed is the bills
 * NOT marked paid, less the payments recorded against the account - so ticking a $456.02 CED bill
 * "paid" here and recording the cheque that covered it on the Suppliers card takes $912.04 off
 * one payment.
 *
 * cn-v966 rewrote the toast and the tooltip and left the badge printing the raw column. A tooltip
 * does not exist on the 375px phone he reads this on and the toast lands after the tap, so the
 * badge was the whole invitation. These assertions pin the words, because the words are the fix.
 */
const SRC = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-receipts.tsx"), "utf8");

describe("All Bills lists receipt files, and is never a second upload door (Wave 0)", () => {
  it("never files a picture as a receipt without reading it", () => {
    expect(SRC).not.toContain("addDocument(");
    expect(SRC).not.toContain("<DropTarget");
    // The one paper door (W1-30): the sentence names the door that is at the top of the page.
    expect(SRC).toContain("Add one with Snap Or Note at the top of this page.");
    expect(SRC).not.toContain("Drop Paperwork at the top");
  });

  it("one list, no tabs and no chips (W1-32): bills, purchase orders and files, each kind named on its row", () => {
    expect(SRC).not.toContain("<Tabs");
    expect(SRC).not.toMatch(/Job Bills \(|Business Costs \(/);
    expect(SRC).toContain("<Kind>PO</Kind>");
    expect(SRC).toContain("<Kind>File</Kind>");
    // A file's Delete is behind its row's ⋯ (the app's one row ⋯), asked first.
    expect(SRC).toMatch(/<RowMoreSheet title=\{d\.name\}[\s\S]{0,400}confirm\(`Delete "\$\{d\.name\}"\?`\)/);
  });
});

describe("a bill's row says what is open on it, by the number (0383)", () => {
  it("never prints the raw database word on the badge, and makes the words in one place", () => {
    // ONE EXPRESSION FOR THE ROW'S WORDS (8a982483, 0383): this file and bill-row-doors.tsx each
    // wrote the badge out by hand once; now both read what is open on the bill through
    // billSettledLabel, so the same bill cannot read two ways on two screens.
    expect(SRC).toContain("billSettledLabel({ status: b.status, amount: b.amount, amountPaid: b.amount_paid ?? null, superseded: b.superseded }, formatCurrency)");
    expect(SRC).not.toContain("<Badge tone={statusTone(b.status)}>{b.status}</Badge>");
    expect(billSettledLabel({ status: "paid", amount: 100, amountPaid: 100 }, formatCurrency)).toBe("Paid");
    expect(billSettledLabel({ status: "unpaid", amount: 523.47, amountPaid: 200 }, formatCurrency)).toBe("Part-Paid $200.00 Of $523.47");
    expect(billSettledLabel({ status: "unpaid", amount: 100, amountPaid: 0 }, formatCurrency)).toBe("On Account");
    // The row carries the number, so the badge and the Unpaid filter read the same column.
    expect(SRC).toContain("amount_paid?: number | null;");
  });

  /**
   * "$10k UNPAID" OVER "$5k OWED" (8a982483, settled by 0383): the Unpaid count and the Suppliers
   * card's figure read the same number on each bill, so a bill a payment paid, or a person marked
   * paid, leaves the count the moment the number says so - and a part-paid one stays, at its balance.
   */
  it("the Unpaid count reads what is open on each bill", () => {
    expect(SRC).toContain("const unpaid = bills.filter((b) => isOpenBill({ status: b.status, amount: b.amount, amountPaid: b.amount_paid ?? null, superseded: b.superseded }));");
    const paidByNumber = { id: "b1", supplier: "CED", status: "unpaid", amount: 100, amountPaid: 100, superseded: false };
    const partPaid = { id: "b2", supplier: "CED", status: "unpaid", amount: 100, amountPaid: 40, superseded: false };
    const asBefore = { id: "b3", supplier: "CED", status: "unpaid", superseded: false };
    expect([paidByNumber, partPaid, asBefore].filter((b) => isOpenBill(b)).map((b) => b.id)).toEqual(["b2", "b3"]);
  });

  it("gives the Edit Bill Status picker two Title Case choices (the add form went: Add By Hand asks Paid?)", () => {
    // The ledger's Add A Bill By Hand fold is gone (W1-32); a new cost goes in through Add By Hand,
    // the one typed sheet, whose Paid? is Already Paid or On Account (Still Owed).
    expect(SRC.match(/<option value="unpaid">On Account<\/option>/g)).toHaveLength(1);
    // "Settled At The Counter" retired with 0383: a bill paid by a cheque against the account was
    // never settled at any counter. Paid is his word that the whole purchase is paid in full.
    expect(SRC.match(/<option value="paid">Paid<\/option>/g)).toHaveLength(1);
    expect(SRC).not.toContain("Settled At The Counter");
    expect(SRC).not.toContain('<option value="unpaid">Unpaid</option>');
    expect(SRC).not.toContain("Add A Bill By Hand");
    expect(SRC).not.toMatch(/\bcreateBill\b/);
    const SHEET = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    expect(SHEET).toContain("Already Paid");
    expect(SHEET).toContain("On Account (Still Owed)");
  });

  /**
   * The toggle still exists, and must: a counter receipt on an on-account supplier is real. It lives
   * in BillRowDoors now, ONE copy the job's Costs tab draws too (audit v1018, class 13).
   */
  it("keeps the control, and says only what the tap actually did", () => {
    const DOORS = readFileSync(join(process.cwd(), "src/components/bill-row-doors.tsx"), "utf8");
    expect(SRC).toContain("<BillRowDoors bill={b}");
    expect(DOORS).toContain("const next = flipBoughtHow(bill);");
    // THE TOAST STOPPED PROMISING SOMETHING FALSE (8a982483). Where a supplier sends its own papers,
    // the balance IS those papers: flipping bills.status moves it not one cent. The app said "it
    // comes out of the supplier balance" out loud, right after he pressed something, and the next
    // screen contradicted it. bills.status says HOW it was bought, so that is what the toast says.
    expect(DOORS).not.toContain("comes out of the supplier balance");
    expect(DOORS).not.toContain("goes back into the supplier balance");
    expect(DOORS).toContain("Marked paid in full - it is no longer on account");
    expect(DOORS).toContain("Marked on account - it is money you still owe them");
    // And the badge is the one expression, so this row and the job's Costs tab cannot disagree.
    expect(DOORS).toContain("billSettledLabel(paper, formatCurrency)");
    expect(DOORS).toContain("if (!confirm(`Delete bill from");
  });
});
