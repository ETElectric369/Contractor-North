import { describe, it, expect } from "vitest";
import { recalcTotals, resolveDrawCredit, drawAmount, progressSummary, shouldBlockStandardImport } from "@/lib/invoice-math";

describe("shouldBlockStandardImport (H4 — one billing path per job)", () => {
  it("blocks importing onto a STANDARD invoice when the job has draws", () => {
    expect(shouldBlockStandardImport("standard", true)).toBe(true);
    expect(shouldBlockStandardImport(null, true)).toBe(true); // null kind = standard
  });
  it("allows a standard invoice when the job has NO draws", () => {
    expect(shouldBlockStandardImport("standard", false)).toBe(false);
  });
  it("never blocks a draw invoice (it IS the billing path)", () => {
    expect(shouldBlockStandardImport("progress", true)).toBe(false);
    expect(shouldBlockStandardImport("final", true)).toBe(false);
    expect(shouldBlockStandardImport("deposit", true)).toBe(false);
  });
});

describe("recalcTotals", () => {
  it("sums lines, applies tax, sums payments", () => {
    expect(recalcTotals([100, 50], [], 0, "sent")).toMatchObject({ subtotal: 150, tax: 0, total: 150, amountPaid: 0 });
  });
  it("rounds tax + total to cents", () => {
    const r = recalcTotals([100], [], 0.0825, "draft");
    expect(r.tax).toBe(8.25);
    expect(r.total).toBe(108.25);
  });
  it("marks paid when payments cover the total", () => {
    expect(recalcTotals([100], [100], 0, "sent").status).toBe("paid");
    expect(recalcTotals([100], [60, 40], 0, "sent").status).toBe("paid");
  });
  it("marks partial on a part payment", () => {
    expect(recalcTotals([100], [40], 0, "sent").status).toBe("partial");
  });
  it("reverts a now-unpaid invoice from paid/partial back to sent", () => {
    expect(recalcTotals([100], [], 0, "paid").status).toBe("sent");
    expect(recalcTotals([100], [], 0, "partial").status).toBe("sent");
  });
  it("never advances a voided invoice", () => {
    expect(recalcTotals([100], [100], 0, "void").status).toBe("void");
  });
  it("does not mark a $0 invoice paid", () => {
    expect(recalcTotals([], [], 0, "draft").status).toBe("draft");
  });
  it("lets a negative credit line flow through (the AIA 'less previous billings' line)", () => {
    const r = recalcTotals([11327.87, -10000], [], 0, "draft");
    expect(r.subtotal).toBeCloseTo(1327.87, 2);
    expect(r.total).toBeCloseTo(1327.87, 2);
  });
});

describe("resolveDrawCredit (H1 — a draw can never go negative)", () => {
  it("bails 'no-work' when nothing is logged", () => {
    expect(resolveDrawCredit(0, 5000)).toEqual({ ok: false, reason: "no-work" });
  });
  it("bails 'covered' when prior billings already cover the work (Tao: $16k prior vs $11.3k work)", () => {
    expect(resolveDrawCredit(11327.87, 16000)).toEqual({ ok: false, reason: "covered" });
    expect(resolveDrawCredit(10000, 10000)).toEqual({ ok: false, reason: "covered" });
  });
  it("credits the prior billings when there's new work to bill", () => {
    expect(resolveDrawCredit(11327.87, 10000)).toEqual({ ok: true, credit: 10000 });
  });
  it("credits nothing when there are no prior billings (first draw)", () => {
    expect(resolveDrawCredit(5000, 0)).toEqual({ ok: true, credit: 0 });
  });
  it("never credits more than the imported work (floors the balance at $0)", () => {
    const r = resolveDrawCredit(5000, 4999.99);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.credit).toBeLessThanOrEqual(5000);
  });
});

describe("drawAmount", () => {
  it("bills a percent of the remaining estimate", () => {
    expect(drawAmount("percent", 50, 7325)).toBe(3662.5);
  });
  it("clamps the percent to 0-100", () => {
    expect(drawAmount("percent", 150, 1000)).toBe(1000); // 100%
    expect(drawAmount("percent", -10, 1000)).toBe(0);
  });
  it("bills a fixed amount, rounded to cents", () => {
    expect(drawAmount("fixed", 6000, 999)).toBe(6000);
    expect(drawAmount("fixed", 99.999, 0)).toBe(100);
  });
});

describe("progressSummary", () => {
  it("computes percent complete + balance (Tao $6k draw)", () => {
    expect(progressSummary(17325, 11327.87, 10000, 6000)).toEqual({ pctComplete: 65, balance: 1325 });
  });
  it("never divides by zero when there's no estimate", () => {
    expect(progressSummary(0, 500, 0, 0)).toEqual({ pctComplete: 0, balance: 0 });
  });
  it("can show over-100% on a T&M job that ran past the estimate", () => {
    expect(progressSummary(17325, 20000, 0, 0).pctComplete).toBeGreaterThan(100);
  });
});
