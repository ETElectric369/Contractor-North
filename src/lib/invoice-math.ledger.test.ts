import { describe, it, expect } from "vitest";
import { paymentLedger } from "@/lib/invoice-math";

// Made-up figures only: this repo is public.
describe("paymentLedger — the statement's payment history", () => {
  it("lists payments oldest first with the balance left after each", () => {
    const l = paymentLedger(1000, 600, [
      { paid_at: "2026-03-10T17:00:00Z", method: "check", amount: 400 },
      { paid_at: "2026-02-01T17:00:00Z", method: "cash", amount: 200 },
    ]);
    expect(l.rows.map((r) => [r.method, r.amount, r.balanceAfter])).toEqual([
      ["cash", 200, 800],
      ["check", 400, 400],
    ]);
    expect(l.reconciles).toBe(true);
  });

  it("keeps the given order for payments on the same instant, and puts undated ones last", () => {
    const l = paymentLedger(300, 300, [
      { paid_at: null, method: "other", amount: 50 },
      { paid_at: "2026-01-05T00:00:00Z", method: "a", amount: 100 },
      { paid_at: "2026-01-05T00:00:00Z", method: "b", amount: 150 },
    ]);
    expect(l.rows.map((r) => r.method)).toEqual(["a", "b", "other"]);
    expect(l.rows.map((r) => r.balanceAfter)).toEqual([200, 50, 0]);
  });

  it("floors the running balance at zero on an overpayment", () => {
    const l = paymentLedger(100, 130, [
      { paid_at: "2026-01-01T00:00:00Z", method: "cash", amount: 80 },
      { paid_at: "2026-01-02T00:00:00Z", method: "cash", amount: 50 },
    ]);
    expect(l.rows.map((r) => r.balanceAfter)).toEqual([20, 0]);
    expect(l.reconciles).toBe(true);
  });

  it("rounds to cents, so float dust does not leave a penny", () => {
    const l = paymentLedger(0.3, 0.3, [
      { paid_at: "2026-01-01T00:00:00Z", method: "cash", amount: 0.1 },
      { paid_at: "2026-01-02T00:00:00Z", method: "cash", amount: 0.2 },
    ]);
    expect(l.rows.map((r) => r.balanceAfter)).toEqual([0.2, 0]);
    expect(l.reconciles).toBe(true);
  });

  it("does not reconcile when a credit is in amount_paid but not in payments", () => {
    const l = paymentLedger(500, 350, [{ paid_at: "2026-01-01T00:00:00Z", method: "check", amount: 250 }]);
    expect(l.reconciles).toBe(false);
    expect(l.rows[0].balanceAfter).toBe(250);
  });

  it("an invoice with no payments has no rows and reconciles only at zero paid", () => {
    expect(paymentLedger(100, 0, [])).toEqual({ rows: [], reconciles: true });
    expect(paymentLedger(100, 40, []).reconciles).toBe(false);
  });

  it("treats a bad amount as zero rather than NaN", () => {
    const l = paymentLedger(100, 0, [{ paid_at: "2026-01-01T00:00:00Z", method: "cash", amount: null }]);
    expect(l.rows[0]).toEqual({ paid_at: "2026-01-01T00:00:00Z", method: "cash", amount: 0, balanceAfter: 100 });
  });
});
