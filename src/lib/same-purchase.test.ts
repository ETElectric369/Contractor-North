import { describe, it, expect } from "vitest";
import { indexSupplierAliases } from "@/lib/supplier-identity";
import {
  billsCarryingNumber,
  billsCoveredByDocuments,
  normalizeDocNumber,
  samePurchaseCandidates,
  samePurchaseSentence,
  type LedgerBill,
  type SupplierDoc,
} from "./same-purchase";

/**
 * ONE PURCHASE, ONE BILL (audit v994, DB1). Every fixture is ET Electric's own: the CED account
 * (6fae3d9c), Paper B's counter ticket on J-011 (e2380fc9, 8802-SO-257555, $323.71) and Paper A's
 * TOOLS ticket (fef38cb9, 8802-SO-257558, $44.44, no job).
 */
const CED = "6fae3d9c-2bd5-484f-8998-94ddcf77a52d";
const J011 = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";
const aliases = indexSupplierAliases([{ alias: "Consolidated Electrical Dist.", supplier_account_id: CED }]);

const paperB: LedgerBill = {
  id: "e2380fc9",
  supplier: "Consolidated Electrical Dist.",
  supplier_account_id: CED,
  bill_number: "8802-SO-257555",
  supplier_invoice_number: null,
  amount: "323.71",
  bill_date: "2026-09-24",
  job_id: J011,
  jobs: { job_number: "J-011", name: "13897 Herringbone" },
};
const paperA: LedgerBill = {
  id: "fef38cb9",
  supplier: "Consolidated Electrical Dist.",
  supplier_account_id: CED,
  bill_number: "8802-SO-257558",
  supplier_invoice_number: null,
  amount: "44.44",
  bill_date: "2026-09-24",
  job_id: null,
};
/** A tray ticket that DID carry CED's invoice number (the J-046 counter sheet shape). */
const trayTicket: LedgerBill = {
  id: "tray-1",
  supplier: "Consolidated Electrical Dist.",
  supplier_account_id: CED,
  bill_number: "8802-1109000",
  amount: "400.00",
  bill_date: "2026-09-10",
  job_id: "job-046",
};

describe("billsCarryingNumber: the one reading every door uses", () => {
  it("finds the tray's bill_number from CED's own document (the double bill the audit found)", () => {
    expect(billsCarryingNumber("#8802 1109000", { accountId: CED }, [trayTicket], aliases).map((b) => b.id)).toEqual(["tray-1"]);
  });

  it("finds a supplier_invoice_number from a tray paper", () => {
    const recorded: LedgerBill = { ...trayTicket, id: "rec-1", bill_number: null, supplier_invoice_number: "8802-1109000" };
    expect(billsCarryingNumber("8802-1109000", { supplier: "Consolidated Electrical Dist." }, [recorded], aliases).map((b) => b.id)).toEqual(["rec-1"]);
  });

  it("finds a number named on a scanned statement's own lines", () => {
    const statement: LedgerBill = { ...trayTicket, id: "st-1", bill_number: null, named_numbers: ["8802-1105868", "8802-1105963"] };
    expect(billsCarryingNumber("8802-1105963", { accountId: CED }, [statement], aliases)).toHaveLength(1);
  });

  it("never a set-aside copy (0271)", () => {
    expect(billsCarryingNumber("8802-1109000", { accountId: CED }, [{ ...trayTicket, superseded_by_bill_id: "keeper" }], aliases)).toEqual([]);
  });

  it("never a bill on another account", () => {
    expect(billsCarryingNumber("8802-1109000", { accountId: "acct-other" }, [trayTicket], aliases)).toEqual([]);
  });

  it("a bill on no account yet still matches a long number, never a short one", () => {
    const unfiled: LedgerBill = { ...trayTicket, supplier: "CED Truckee counter", supplier_account_id: null };
    expect(billsCarryingNumber("8802-1109000", { accountId: CED }, [unfiled], aliases)).toHaveLength(1);
    expect(billsCarryingNumber("1234", { accountId: CED }, [{ ...unfiled, bill_number: "1234" }], aliases)).toEqual([]);
  });

  it("normalises the printed number one way", () => {
    expect(normalizeDocNumber("8802-SO-257555")).toBe("8802SO257555");
  });
});

describe("samePurchaseCandidates: the counter ticket and CED's invoice for it", () => {
  // CED invoices Paper B's breakers later, under its own number, job name "13897 HERRINGBONE".
  const cedInvoice: SupplierDoc = {
    id: "si-new",
    invoice_number: "8802-1109999",
    supplier_account_id: CED,
    job_id: J011,
    total: "323.71",
    invoice_date: "2026-09-26",
  };

  it("offers Paper B's SO ticket to CED's invoice for it: same account, job and total, two days apart", () => {
    const c = samePurchaseCandidates(cedInvoice, [paperB, paperA], new Set(), aliases);
    expect(c).toEqual([expect.objectContaining({ billId: "e2380fc9", exact: false, dollarsOff: 0, daysApart: 2, jobId: J011 })]);
    expect(samePurchaseSentence(c[0])).toContain("Maybe already on the books: Consolidated Electrical Dist. #8802-SO-257555, $323.71, 2026-09-24, on J-011 13897 Herringbone");
    expect(samePurchaseSentence(c[0])).toContain("the same total, 2 days apart");
  });

  it("offers Paper A's TOOLS ticket to a no-job invoice for the same $44.44", () => {
    const tools: SupplierDoc = { ...cedInvoice, id: "si-tools", job_id: null, total: "44.44" };
    expect(samePurchaseCandidates(tools, [paperB, paperA], new Set(), aliases).map((c) => c.billId)).toEqual(["fef38cb9"]);
  });

  it("never a bill a document already covers, another job's, another account's, or a statement", () => {
    expect(samePurchaseCandidates(cedInvoice, [paperB], new Set(["e2380fc9"]), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, job_id: "job-other" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, supplier: "Home Depot", supplier_account_id: "acct-hd" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, is_statement: true }], new Set(), aliases)).toEqual([]);
  });

  it("only within a few dollars and days", () => {
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, amount: "330.00" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, bill_date: "2026-07-01" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(cedInvoice, [{ ...paperB, amount: "321.00" }], new Set(), aliases)).toHaveLength(1);
  });

  it("a $0.00 placeholder is never 'maybe the same purchase', and a small invoice is held to 3% (the live replay)", () => {
    // ET's books: a $0.00 CED bill on J-013 was offered against 8802-1105997 ($2.30) by a flat $5.
    const small: SupplierDoc = { ...cedInvoice, id: "si-small", invoice_number: "8802-1105997", job_id: "j13", total: "2.30", invoice_date: "2026-08-19" };
    const zero: LedgerBill = { ...paperB, id: "zero", bill_number: null, amount: "0.00", job_id: "j13", bill_date: "2026-08-19" };
    expect(samePurchaseCandidates(small, [zero], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(small, [{ ...zero, amount: "4.00" }], new Set(), aliases)).toEqual([]);
    expect(samePurchaseCandidates(small, [{ ...zero, amount: "2.30" }], new Set(), aliases)).toHaveLength(1);
  });

  it("a bill carrying the invoice's own number is certain, and ranked first", () => {
    const exact: LedgerBill = { ...paperB, id: "exact-1", bill_number: "8802-1109999", amount: "100.00", bill_date: "2026-01-01" };
    const c = samePurchaseCandidates(cedInvoice, [paperB, exact], new Set(["exact-1"]), aliases);
    expect(c.map((x) => [x.billId, x.exact])).toEqual([
      ["exact-1", true],
      ["e2380fc9", false],
    ]);
    expect(samePurchaseSentence(c[0])).toMatch(/^Already on the books with this number:/);
  });
});

describe("billsCoveredByDocuments", () => {
  it("covers a bill by a link or by carrying a document's number on its account", () => {
    const docs: SupplierDoc[] = [{ id: "si-1", invoice_number: "8802-1109000", supplier_account_id: CED, total: 400, invoice_date: "2026-09-12" }];
    const covered = billsCoveredByDocuments([trayTicket, paperB, paperA], docs, [{ bill_id: "fef38cb9", supplier_invoice_id: "si-9" }], aliases);
    expect([...covered].sort()).toEqual(["fef38cb9", "tray-1"]);
  });
});
