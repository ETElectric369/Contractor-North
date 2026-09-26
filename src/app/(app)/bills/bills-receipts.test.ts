import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("a bill's status says how it was bought, in words", () => {
  it("never prints the raw database word on the badge", () => {
    expect(SRC).toContain('{b.status === "paid" ? "Settled" : "On Account"}');
    expect(SRC).not.toContain("<Badge tone={statusTone(b.status)}>{b.status}</Badge>");
  });

  it("gives both Status pickers the same two Title Case choices", () => {
    expect(SRC.match(/<option value="unpaid">On Account<\/option>/g)).toHaveLength(2);
    expect(SRC.match(/<option value="paid">Settled At The Counter<\/option>/g)).toHaveLength(2);
    expect(SRC).not.toContain('<option value="paid">Paid</option>');
    expect(SRC).not.toContain('<option value="unpaid">Unpaid</option>');
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
