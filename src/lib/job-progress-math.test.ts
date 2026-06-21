import { describe, it, expect } from "vitest";
import { computeJobProgress } from "./job-progress-math";

const base = {
  billingTypeRaw: "tm",
  quotes: [{ total: 17325 }],
  invoices: [
    { total: 10000, status: "sent", amount_paid: 10000 },
    { total: 5000, status: "draft", amount_paid: 0 },
    { total: 2000, status: "void", amount_paid: 2000 },
  ],
  billableLabor: 6037.5,
  pos: [{ total: 5000 }],
  bills: [{ amount: 290.37 }],
  markupPercent: 0,
};

describe("computeJobProgress", () => {
  it("reconciles to the billed lines (Tao: labor + materials, markup 0)", () => {
    const r = computeJobProgress(base);
    expect(r.estimate).toBe(17325);
    expect(r.workToDate).toBeCloseTo(11327.87, 2); // 6037.50 labor + 5290.37 materials
    expect(r.billingType).toBe("tm");
  });

  it("invoiced excludes void AND draft; collected excludes only void", () => {
    const r = computeJobProgress(base);
    expect(r.invoiced).toBe(10000); // only the 'sent' one (draft + void excluded)
    expect(r.collected).toBe(10000); // sent's 10000; void's 2000 excluded; draft's 0
  });

  it("marks materials up PER ROW", () => {
    const r = computeJobProgress({ ...base, markupPercent: 10 });
    // 5000*1.1 = 5500.00 ; 290.37*1.1 = 319.41 (rounded per row) ; +6037.50 labor
    expect(r.workToDate).toBeCloseTo(11856.91, 2);
  });

  it("skips non-positive material rows (no negative/zero costs billed)", () => {
    const r = computeJobProgress({
      ...base,
      markupPercent: 0,
      pos: [{ total: 5000 }, { total: 0 }, { total: -100 }],
      bills: [],
    });
    expect(r.workToDate).toBeCloseTo(11037.5, 2); // 6037.50 + 5000 only
  });

  it("billingType is 'fixed' unless raw is exactly 'tm'", () => {
    expect(computeJobProgress({ ...base, billingTypeRaw: "fixed" }).billingType).toBe("fixed");
    expect(computeJobProgress({ ...base, billingTypeRaw: null }).billingType).toBe("fixed");
    expect(computeJobProgress({ ...base, billingTypeRaw: "tm" }).billingType).toBe("tm");
  });

  it("coerces non-finite money to 0", () => {
    const r = computeJobProgress({
      ...base,
      quotes: [{ total: NaN as any }],
      invoices: [],
      pos: [],
      bills: [],
      billableLabor: Infinity as any,
    });
    expect(r.estimate).toBe(0);
    expect(r.workToDate).toBe(0);
    expect(r.invoiced).toBe(0);
  });
});
