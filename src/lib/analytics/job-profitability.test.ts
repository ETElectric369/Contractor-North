import { describe, it, expect } from "vitest";
import { computeJobProfitRows, computeProfitByType, mergeBudgetActual, type JobProfitRow } from "@/lib/analytics/job-profitability";

describe("mergeBudgetActual — per-scope budget vs actual", () => {
  it("joins budget + actual by scope and flags over/under (the masked-overrun catch)", () => {
    const rows = mergeBudgetActual(
      [
        { category: "Framing", budget: 26510 },
        { category: "Decking", budget: 40350 },
        { category: "Demo", budget: 10500 },
      ],
      [
        { category: "Framing", actual: 48390 },
        { category: "Demo", actual: 25600 },
        // Decking not started → no actual row
      ],
    );
    const framing = rows.find((r) => r.category === "Framing")!;
    expect(framing.overBudget).toBe(true);
    expect(framing.burnPct).toBe(183); // 48390/26510
    expect(framing.remaining).toBe(26510 - 48390);
    const decking = rows.find((r) => r.category === "Decking")!;
    expect(decking.actual).toBe(0); // not started — the money hiding spot
    expect(decking.overBudget).toBe(false);
  });
  it("actual-only scope (e.g. an unbudgeted 'Uncategorized' spend) surfaces with null burnPct", () => {
    const rows = mergeBudgetActual([], [{ category: "Uncategorized", actual: 2286 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].budget).toBe(0);
    expect(rows[0].burnPct).toBeNull();
    expect(rows[0].overBudget).toBe(false);
  });
});

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

describe("computeProfitByType — margin by work type", () => {
  const row = (id: string, rev: number, cost: number): JobProfitRow => ({ id, job_number: `J-${id}`, name: `Job ${id}`, status: "complete", rev, cost, profit: rev - cost });

  it("groups jobs by type, sums money, computes margin %, sorts by profit", () => {
    const rows = [row("a", 1000, 600), row("b", 500, 450), row("c", 2000, 1000)];
    const typeOf = new Map([["a", "Panel swap"], ["b", "Panel swap"], ["c", "Service call"]]);
    const out = computeProfitByType(rows, typeOf);
    expect(out).toEqual([
      { type: "Service call", jobs: 1, revenue: 2000, cost: 1000, profit: 1000, marginPct: 50 },
      { type: "Panel swap", jobs: 2, revenue: 1500, cost: 1050, profit: 450, marginPct: 30 },
    ]);
  });

  it("jobs with no type fall under 'Uncategorized'; null margin when zero revenue", () => {
    const out = computeProfitByType([row("x", 0, 200)], new Map());
    expect(out).toEqual([{ type: "Uncategorized", jobs: 1, revenue: 0, cost: 200, profit: -200, marginPct: null }]);
  });
});
