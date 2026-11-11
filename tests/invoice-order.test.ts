import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { newestInvoiceFirst } from "@/lib/invoice-order";

const nums = (rows: any[]) => [...rows].sort(newestInvoiceFirst).map((r) => r.invoice_number);

describe("newestInvoiceFirst", () => {
  it.each([
    ["newer created_at first", [{ invoice_number: "INV-001", created_at: "2026-01-01T00:00:00Z" }, { invoice_number: "INV-002", created_at: "2026-02-01T00:00:00Z" }], ["INV-002", "INV-001"]],
    ["same instant: higher number first", [{ invoice_number: "INV-009", created_at: "2026-01-01T00:00:00Z" }, { invoice_number: "INV-010", created_at: "2026-01-01T00:00:00Z" }], ["INV-010", "INV-009"]],
    ["natural numbers: INV-100 before INV-99", [{ invoice_number: "INV-99", created_at: "2026-01-01T00:00:00Z" }, { invoice_number: "INV-100", created_at: "2026-01-01T00:00:00Z" }], ["INV-100", "INV-99"]],
    ["no date sorts last", [{ invoice_number: "INV-005" }, { invoice_number: "INV-001", created_at: "2026-01-01T00:00:00Z" }], ["INV-001", "INV-005"]],
  ])("%s", (_n, rows, want) => expect(nums(rows as any[])).toEqual(want));

  it("the job tab reads its invoices ordered, with created_at, and sorts with the helper", () => {
    const src = readFileSync("src/app/(app)/jobs/[id]/page.tsx", "utf8");
    expect(src).toMatch(/from\("invoices"\)\.select\("id, invoice_number, status, total, amount_paid, invoice_kind, created_at"\)\.eq\("job_id", id\)\.order\("created_at", \{ ascending: false \}\)/);
    expect(src).toContain("newestInvoiceFirst");
  });
  it("the billing list uses the same tie-break", () => {
    expect(readFileSync("src/app/(app)/billing/page.tsx", "utf8")).toContain("newestInvoiceFirst");
  });
});
