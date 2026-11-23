import { describe, it, expect } from "vitest";
import { billItemisation, type BillLine } from "@/lib/bill-itemisation";
import { linesByBillId } from "@/lib/invoice-markup-read";
import { isReturnBill, returnCreditRows, returnLinesAgainstPurchases } from "@/lib/supplier-returns";

/**
 * A CORRECTION LINE SWITCHED TO NOT BILLED NEVER REACHES THE CUSTOMER (cn-v1186). A delivery ticket
 * lists a part the supplier back-ordered and never invoiced; the office switches that line to Not
 * billed, and the supplier's correction under the ticket carries the same part as a negative line,
 * also Not billed. Run as the importer runs them: lines grouped by bill (linesByBillId), returns held
 * to their purchases (returnLinesAgainstPurchases), a purchase itemised (billItemisation), a return
 * credited (returnCreditRows). Stand-ins: supplier "Northline Supply", job J-952.
 */
const PART = "ACME 77120 Meter Socket 200A";
const BACK_ORDERED = "ACME 88410 Ground Rod Kit";
type Bill = { id: string; supplier: string; amount: string; created_at: string; corrects_bill_id?: string | null };
const ticket: Bill = { id: "ticket-952", supplier: "Northline Supply", amount: "211.20", created_at: "2026-11-10T10:00:00Z", corrects_bill_id: null };
const correction: Bill = { id: "corr-952", supplier: "Northline Supply", amount: "-61.20", created_at: "2026-11-12T10:00:00Z", corrects_bill_id: "ticket-952" };
const lines = (): (BillLine & { bill_id: string; returned?: boolean; returned_credit_bill_id?: string | null })[] => [
  { bill_id: "ticket-952", id: "l1", description: PART, quantity: "1", unit_price: "150", amount: "150", category: "Electrical", billable: true, billed_amount: null, returned: false, returned_credit_bill_id: null },
  { bill_id: "ticket-952", id: "l2", description: BACK_ORDERED, quantity: "1", unit_price: "61.20", amount: "61.20", category: "Electrical", billable: false, billed_amount: null, returned: false, returned_credit_bill_id: null },
  { bill_id: "corr-952", id: "l3", description: BACK_ORDERED, quantity: "1", unit_price: "-61.20", amount: "-61.20", category: "Electrical", billable: false, billed_amount: null },
];

/** What the customer is billed, as the importer's bill loop adds it up, at a 20% markup. */
function billed(bills: Bill[]) {
  const by = linesByBillId(lines().filter((l) => bills.some((b) => b.id === l.bill_id)));
  const held = returnLinesAgainstPurchases(bills, (b) => by.get(b.id) ?? []);
  let total = 0;
  const creditRows: number[] = [];
  for (const b of bills) {
    const rows = isReturnBill(b.amount) ? returnCreditRows(b, held.get(b) ?? by.get(b.id) ?? [], 20) : billItemisation(b, by.get(b.id) ?? [], 20);
    const sum = Math.round(rows.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100;
    if (isReturnBill(b.amount)) creditRows.push(rows.length);
    total = Math.round((total + sum) * 100) / 100;
  }
  return { total, creditRows, held, by };
}

describe("a Not billed correction line through the importer's arithmetic", () => {
  it("the correction credits the customer nothing", () => {
    expect(billed([ticket, correction]).creditRows).toEqual([0]);
  });

  it("what the customer is billed is the same with and without the correction: the part he got, marked up", () => {
    expect(billed([ticket]).total).toBe(180);
    expect(billed([ticket, correction]).total).toBe(180);
  });

  it("it spends nothing that went back: the matcher hands the correction's line back untouched", () => {
    const { held, by } = billed([ticket, correction]);
    expect(held.get(correction)).toEqual(by.get("corr-952"));
  });
});
