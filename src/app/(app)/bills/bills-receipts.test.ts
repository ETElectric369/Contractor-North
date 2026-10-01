import { describe, it, expect } from "vitest";
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

describe("a bill's status says how it was bought, in words", () => {
  it("never prints the raw database word on the badge, and makes the words in one place", () => {
    // ONE EXPRESSION FOR THE ROW'S WORDS (8a982483). This file and bill-row-doors.tsx each wrote the
    // badge out by hand, and only this one had been told about the supplier's closed paper - so the
    // SAME bill read "On Account" on a job's Costs tab and "Settled · CED Says" here.
    expect(SRC).toContain("billSettledLabel(b, shortSupplierName)");
    expect(SRC).not.toContain("<Badge tone={statusTone(b.status)}>{b.status}</Badge>");
    expect(billSettledLabel({ status: "paid", supplier: "CED" }, shortSupplierName)).toBe("Settled");
    expect(billSettledLabel({ status: "unpaid", supplier: "CED", settledBySupplier: true }, shortSupplierName)).toBe("Settled · CED Says");
    expect(billSettledLabel({ status: "unpaid", supplier: "CED" }, shortSupplierName)).toBe("On Account");
  });

  /**
   * "SETTLED · CED SAYS", NEVER THE 63-CHARACTER SPELLING. bills.supplier keeps whatever the receipt
   * reader found (19 of CED's 21 bills are "Consolidated Electrical Distributors, Inc. (CED)" or a
   * cousin; the two spelled "CED" are paid and print plain "Settled"). The right-hand column is
   * shrink-0, so a label that long took the whole 390px row on the phone and truncated the bill's
   * name, number, date and job to nothing, while repeating the name the first line already prints.
   */
  it("says who settled it by the account's short name, in a label that can't widen the column", () => {
    const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(SRC).toContain("settledBySupplierName?: string | null;");
    expect(PAGE).toContain("shortSupplierName(accountNameOf.get(String(b.supplier_account_id ?? \"\")) || b.supplier)");
    // The label itself is bounded, whatever name reaches it.
    expect(SRC).toContain('<span className="block max-w-[9rem] truncate text-xs text-slate-400">');
    // The one rule, run on the spellings CED's bills actually carry.
    // THE ONE EXPRESSION, not a copy of it in the test (8a982483): a test that re-writes the rule
    // it is checking passes happily while the app does something else.
    const label = (b: { status: string; supplier: string; settledBySupplier?: boolean; settledBySupplierName?: string | null }) =>
      billSettledLabel(b, shortSupplierName);
    const account = shortSupplierName("Consolidated Electrical Distributors, Inc. (CED)");
    expect(account).toBe("CED");
    for (const spelling of ["Consolidated Electrical Distributors, Inc. (CED)", "Consolidated Electrical Dist.", "Consolidated Electrical Distributors, Inc.", "CED"]) {
      expect(label({ status: "unpaid", supplier: spelling, settledBySupplier: true, settledBySupplierName: account })).toBe("Settled · CED Says");
    }
    // A bill on no account (the page stamps null) still never prints the long spelling.
    expect(label({ status: "unpaid", supplier: "Consolidated Electrical Distributors, Inc.", settledBySupplier: true, settledBySupplierName: null })).toBe("Settled · CED Says");
    expect(label({ status: "unpaid", supplier: "Swigard's Hardware", settledBySupplier: true, settledBySupplierName: null })).toBe("Settled · Swigard's Hardware Says");
  });

  /**
   * "$10k UNPAID" OVER "$5k OWED" (8a982483). Applying a CED open list closes CED's documents and
   * never a bill, so every ticket ever bought on account stayed Unpaid under All Bills. The page
   * now works out which on-account bills the supplier's own closed papers cover, and the ledger's
   * one open test (isOpenBill) leaves them out, so the fold's count and the card's balance stop
   * disagreeing by the same tickets.
   */
  it("a bill the supplier's closed papers cover leaves the Unpaid count and says who says so", () => {
    expect(SRC).toContain("const unpaid = bills.filter((b) => isOpenBill(b));");
    expect(SRC).toContain("settledBySupplier?: boolean;");
    const settled = { id: "b1", supplier: "CED", status: "unpaid", superseded: false, settledBySupplier: true };
    const stillOpen = { id: "b2", supplier: "CED", status: "unpaid", superseded: false, settledBySupplier: false };
    const asBefore = { id: "b3", supplier: "CED", status: "unpaid", superseded: false };
    expect([settled, stillOpen, asBefore].filter((b) => isOpenBill(b)).map((b) => b.id)).toEqual(["b2", "b3"]);
    // The label the row prints for each.
    // THE ONE EXPRESSION, not a copy of it in the test (8a982483): a test that re-writes the rule
    // it is checking passes happily while the app does something else.
    const label = (b: { status: string; supplier: string; settledBySupplier?: boolean; settledBySupplierName?: string | null }) =>
      billSettledLabel(b, shortSupplierName);
    expect(label(settled)).toBe("Settled · CED Says");
    expect(label(stillOpen)).toBe("On Account");
    expect(label({ status: "paid", supplier: "CED", settledBySupplier: true })).toBe("Settled");
  });

  it("gives the Edit Bill Status picker two Title Case choices (the add form went: Add By Hand asks Paid?)", () => {
    // The ledger's Add A Bill By Hand fold is gone (W1-32); a new cost goes in through Add By Hand,
    // the one typed sheet, whose Paid? is Already Paid or On Account (Still Owed).
    expect(SRC.match(/<option value="unpaid">On Account<\/option>/g)).toHaveLength(1);
    expect(SRC.match(/<option value="paid">Settled At The Counter<\/option>/g)).toHaveLength(1);
    expect(SRC).not.toContain('<option value="paid">Paid</option>');
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
    expect(DOORS).toContain("Marked settled at the register - it is no longer on account");
    expect(DOORS).toContain("Marked on account - it is money you still owe them");
    // And the badge is the one expression, so this row and the job's Costs tab cannot disagree.
    expect(DOORS).toContain("billSettledLabel(bill, shortSupplierName)");
    expect(DOORS).toContain("if (!confirm(`Delete bill from");
  });
});
