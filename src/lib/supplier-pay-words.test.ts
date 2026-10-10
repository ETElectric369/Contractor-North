import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { paidByLine, paidByOfBills, supplierPayMethodLabel } from "./supplier-pay-words";

describe("how a bill was paid, in words", () => {
  it("names the method the way the pay sheet does", () => {
    expect(supplierPayMethodLabel("transfer")).toBe("ACH / Transfer");
    expect(supplierPayMethodLabel("check")).toBe("Check");
    expect(supplierPayMethodLabel("venmo")).toBe("venmo");
    expect(supplierPayMethodLabel(null)).toBe("Other");
  });

  it("the latest live payment on a bill wins; a voided one never answers; a hand-marked bill is absent", () => {
    const payments = [
      { id: "p1", paid_on: "2026-10-01", method: "check", voided_at: null },
      { id: "p2", paid_on: "2026-10-03", method: "transfer", voided_at: null },
      { id: "p3", paid_on: "2026-10-09", method: "card", voided_at: "2026-10-09T10:00:00Z" },
    ];
    const allocations = [
      { supplier_payment_id: "p1", bill_id: "b1" },
      { supplier_payment_id: "p2", bill_id: "b1" },
      { supplier_payment_id: "p3", bill_id: "b1" },
      { supplier_payment_id: "p1", bill_id: "b2" },
      { supplier_payment_id: "gone", bill_id: "b3" },
    ];
    const m = paidByOfBills(allocations, payments);
    expect(m.get("b1")).toEqual({ method: "transfer", paidOn: "2026-10-03" });
    expect(m.get("b2")).toEqual({ method: "check", paidOn: "2026-10-01" });
    expect(m.has("b3")).toBe(false);
    expect(m.has("b4")).toBe(false);
    expect(paidByOfBills(null, null).size).toBe(0);
  });

  it("says how and when, and only how when the day is missing", () => {
    const day = (iso: string) => (iso === "2026-10-03" ? "Oct 3" : iso);
    expect(paidByLine({ method: "transfer", paidOn: "2026-10-03" }, day)).toBe("Paid by ACH / Transfer on Oct 3");
    expect(paidByLine({ method: "cash", paidOn: "" }, day)).toBe("Paid by Cash");
    expect(paidByLine(null, day)).toBeNull();
  });

  it("the ledger row prints it under the badge, and the pay sheet reads the same labels", () => {
    const row = readFileSync(new URL("../app/(app)/bills/bills-receipts.tsx", import.meta.url), "utf8");
    expect(row).toContain("paidByLine(b.paid_by");
    const page = readFileSync(new URL("../app/(app)/bills/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("paid_by: paidByOfBill.get(String(b.id)) ?? null");
    const card = readFileSync(new URL("../app/(app)/bills/suppliers-card.tsx", import.meta.url), "utf8");
    expect(card).toContain("SUPPLIER_PAY_METHOD_LABELS");
    expect(card).not.toMatch(/const METHOD_LABELS: Record<SupplierPayMethod, string> = \{/);
  });
});
