import { describe, it, expect } from "vitest";
import { computeJobProfitRows } from "@/lib/analytics/job-profitability";

const job = (id: string, status = "in_progress") => ({ id, job_number: `J-${id}`, name: `Job ${id}`, status });
// a closed entry fully allocated to `jobId` for `hours` at pay rate `rate`
const laborEntry = (jobId: string, hours: number, rate: number) => ({
  job_id: jobId,
  status: "closed",
  profiles: { hourly_rate: rate },
  time_allocations: [{ job_id: jobId, hours }],
});
const empty = { jobs: [], invoices: [], pos: [], bills: [], jobRefunds: [], entries: [] };

describe("computeJobProfitRows — job profit SSOT (reconciles /analytics + job hub + Nort)", () => {
  it("profit = revenue collected − (labor at pay rate + materials)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      invoices: [{ job_id: "A", status: "paid", amount_paid: 1000 }],
      bills: [{ job_id: "A", amount: 200 }],
      entries: [laborEntry("A", 8, 50)], // 8h × $50 = 400
    });
    expect(rows).toEqual([{ id: "A", job_number: "J-A", name: "Job A", status: "in_progress", rev: 1000, cost: 600, profit: 400 }]);
  });

  it("nets refunds out of revenue (keyed via the invoice's job)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      invoices: [{ job_id: "A", status: "paid", amount_paid: 1000 }],
      jobRefunds: [{ amount: 150, invoices: { job_id: "A" } }],
    });
    expect(rows[0].rev).toBe(850);
    expect(rows[0].profit).toBe(850);
  });

  it("excludes void-invoice payments from revenue", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      invoices: [
        { job_id: "A", status: "void", amount_paid: 1000 },
        { job_id: "A", status: "paid", amount_paid: 300 },
      ],
    });
    expect(rows[0].rev).toBe(300);
  });

  it("counts a PO and a bill both — the documented double-count (no bill↔PO link yet)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      invoices: [{ job_id: "A", status: "paid", amount_paid: 1000 }],
      pos: [{ job_id: "A", total: 100 }],
      bills: [{ job_id: "A", amount: 100 }],
    });
    expect(rows[0].cost).toBe(200);
  });

  it("only counts THIS job's allocated hours from a split shift", () => {
    // one shift split across two jobs; A's cost is only its 3 allocated hours
    const shift = {
      job_id: "OTHER",
      status: "closed",
      profiles: { hourly_rate: 40 },
      time_allocations: [{ job_id: "A", hours: 3 }, { job_id: "OTHER", hours: 5 }],
    };
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      invoices: [{ job_id: "A", status: "paid", amount_paid: 500 }],
      entries: [shift],
    });
    expect(rows[0].cost).toBe(120); // 3h × $40
  });

  it("drops jobs with zero revenue AND zero cost", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A"), job("EMPTY")],
      invoices: [{ job_id: "A", status: "paid", amount_paid: 500 }],
    });
    expect(rows.map((r) => r.id)).toEqual(["A"]);
  });

  it("ranks most-profitable first", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("LOW"), job("HIGH")],
      invoices: [
        { job_id: "LOW", status: "paid", amount_paid: 100 },
        { job_id: "HIGH", status: "paid", amount_paid: 900 },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["HIGH", "LOW"]);
  });

  it("floors revenue at zero when refunds exceed collections", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      invoices: [{ job_id: "A", status: "paid", amount_paid: 100 }],
      bills: [{ job_id: "A", amount: 50 }], // keeps the row past the zero-zero filter
      jobRefunds: [{ amount: 300, invoices: { job_id: "A" } }],
    });
    expect(rows[0].rev).toBe(0);
    expect(rows[0].profit).toBe(-50);
  });
});
