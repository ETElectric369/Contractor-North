import { describe, it, expect } from "vitest";
import { shortSupplierName, supplierAccountFor } from "./supplier-name";

const ACCOUNTS = [
  { id: "a1", name: "Consolidated Electrical Distributors", account_number: "TR-34426", branch_code: "8802" },
  { id: "a2", name: "Main Street Supply", account_number: "MS-1", branch_code: "0101" },
];

describe("who a supplier paper is from", () => {
  it("matches the account number the paper prints, else the branch in its number", () => {
    expect(supplierAccountFor(ACCOUNTS, { accountNumber: "tr-34426", invoiceNumber: "9999-1" })).toEqual({ id: "a1", name: "Consolidated Electrical Distributors" });
    expect(supplierAccountFor(ACCOUNTS, { accountNumber: null, invoiceNumber: "0101-555" })).toEqual({ id: "a2", name: "Main Street Supply" });
    // The number beats the branch, whichever account comes first.
    expect(supplierAccountFor(ACCOUNTS, { accountNumber: "MS-1", invoiceNumber: "8802-1" })).toEqual({ id: "a2", name: "Main Street Supply" });
  });

  it("names nobody on a paper from a supplier the company has no account for", () => {
    expect(supplierAccountFor(ACCOUNTS, { accountNumber: "ZZ-9", invoiceNumber: "7777-1" })).toBeNull();
    expect(supplierAccountFor([], { accountNumber: "TR-34426", invoiceNumber: "8802-1" })).toBeNull();
  });

  it("shortens a long name the way the company would say it", () => {
    expect(shortSupplierName("Consolidated Electrical Distributors")).toBe("CED");
    expect(shortSupplierName("Main Street Supply")).toBe("Main Street Supply");
    expect(shortSupplierName("Outdoor Supply Hardware (OSH - Cupertino)")).toBe("OSH - Cupertino");
    expect(shortSupplierName("")).toBe("The Supplier");
  });
});
