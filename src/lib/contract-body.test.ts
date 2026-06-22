import { describe, it, expect } from "vitest";
import { buildContractBody, type ContractInput } from "@/lib/contract-body";

const base: ContractInput = {
  contractor: { name: "ET Electric", line2: "License #C10-12345", address: "1 Main St, Town CA 90001", contact: "555-1212" },
  customer: { name: "Jane Owner", line2: "Acme LLC", address: "9 Oak Ave, Town CA 90002" },
  propertyAddress: "9 Oak Ave, Town CA 90002",
  scopeTitle: "200A panel upgrade",
  scopeDetail: "Replace main panel and feeders.",
  startDate: "Jul 1, 2026",
  endDate: "Jul 10, 2026",
  billingType: "fixed",
  contractTotal: 40000,
  schedule: [
    { label: "Deposit", percent: 30, dollars: 12000 },
    { label: "Progress", percent: 40, dollars: 16000 },
    { label: "Final", percent: 30, dollars: 12000 },
  ],
  terms: "1. Payment due per schedule.",
};

describe("buildContractBody", () => {
  it("includes both parties, the property, scope, schedule, and terms", () => {
    const body = buildContractBody(base);
    expect(body).toContain("Contractor: ET Electric");
    expect(body).toContain("Customer: Jane Owner");
    expect(body).toContain("200A panel upgrade");
    expect(body).toContain("9 Oak Ave");
    expect(body).toContain("Jul 1, 2026");
    expect(body).toContain("1. Payment due per schedule.");
    expect(body).toContain("electronically");
  });
  it("renders the fixed-bid payment schedule with dollar amounts", () => {
    const body = buildContractBody(base);
    expect(body).toContain("Contract price: $40,000.00");
    expect(body).toContain("1. Deposit (30%) — $12,000.00");
    expect(body).toContain("3. Final (30%) — $12,000.00");
  });
  it("renders T&M language instead of a schedule", () => {
    const body = buildContractBody({ ...base, billingType: "tm" });
    expect(body).toContain("Time & Materials");
    expect(body).not.toContain("Payment schedule:");
  });
  it("is deterministic (same inputs -> identical body, so it can be frozen)", () => {
    expect(buildContractBody(base)).toBe(buildContractBody(base));
  });
  it("handles a missing schedule gracefully", () => {
    const body = buildContractBody({ ...base, schedule: [] });
    expect(body).toContain("no schedule set");
  });
});
