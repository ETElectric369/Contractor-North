import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenBill } from "@/lib/open-counts";

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
  it("never prints the raw database word on the badge", () => {
    expect(SRC).toContain('{b.status === "paid" ? "Settled" : b.settledBySupplier ? `Settled · ${b.supplier} Says` : "On Account"}');
    expect(SRC).not.toContain("<Badge tone={statusTone(b.status)}>{b.status}</Badge>");
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
    const label = (b: { status: string; supplier: string; settledBySupplier?: boolean }) =>
      b.status === "paid" ? "Settled" : b.settledBySupplier ? `Settled · ${b.supplier} Says` : "On Account";
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
  it("keeps the control and keeps saying out loud what it moves", () => {
    const DOORS = readFileSync(join(process.cwd(), "src/components/bill-row-doors.tsx"), "utf8");
    expect(SRC).toContain("<BillRowDoors bill={b}");
    expect(DOORS).toContain("const next = bill.status === \"paid\" ? \"unpaid\" : \"paid\";");
    expect(DOORS).toContain("Marked settled - it comes out of the supplier balance");
    expect(DOORS).toContain("Marked on account - it goes back into the supplier balance");
    expect(DOORS).toContain('{bill.status === "paid" ? "Settled" : "On Account"}');
    expect(DOORS).toContain("if (!confirm(`Delete bill from");
  });
});
