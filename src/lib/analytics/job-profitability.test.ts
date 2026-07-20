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
// a payment of `amount` on `jobId`'s invoice (THE cash definition — not invoices.amount_paid)
const pay = (jobId: string, amount: number, status = "paid") => ({ amount, invoices: { job_id: jobId, status } });
const empty = { jobs: [], payments: [], pos: [], bills: [], jobRefunds: [], entries: [] };

describe("computeJobProfitRows — job profit SSOT (reconciles /analytics + Nort)", () => {
  it("profit = revenue collected − (labor at pay rate + materials)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      bills: [{ job_id: "A", amount: 200 }],
      entries: [laborEntry("A", 8, 50)], // 8h × $50 = 400
    });
    expect(rows).toEqual([{ id: "A", job_number: "J-A", name: "Job A", status: "in_progress", rev: 1000, cost: 600, profit: 400 }]);
  });

  it("revenue is the PAYMENTS ledger, not invoices.amount_paid — a credit writeoff is no cash", () => {
    // The regression: amount_paid folds a non-cash account credit in, so a disputed invoice
    // written off as a credit used to inflate the job's revenue. With no payment row, it's $0.
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [], // the invoice's amount_paid was raised by a credit, not cash
      bills: [{ job_id: "A", amount: 50 }], // keeps the row past the zero-zero filter
    });
    expect(rows[0].rev).toBe(0);
  });

  it("nets refunds out of revenue (keyed via the invoice's job)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      jobRefunds: [{ amount: 150, invoices: { job_id: "A" } }],
    });
    expect(rows[0].rev).toBe(850);
    expect(rows[0].profit).toBe(850);
  });

  it("excludes void-invoice payments from revenue", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000, "void"), pay("A", 300, "paid")],
    });
    expect(rows[0].rev).toBe(300);
  });

  it("counts an UNLINKED PO and bill both — they're two separate costs until linked", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pos: [{ id: "po-1", job_id: "A", total: 100 }],
      bills: [{ job_id: "A", amount: 100, po_id: null }],
    });
    expect(rows[0].cost).toBe(200);
  });

  it("a bill that names its PO SUPERSEDES it — one delivery, counted once (0142)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pos: [{ id: "po-1", job_id: "A", total: 2400, status: "received" }],
      bills: [{ job_id: "A", amount: 2400, po_id: "po-1" }],
    });
    expect(rows[0].cost).toBe(2400); // NOT 4800
  });

  it("a cancelled PO is not a cost, but a draft (the default) one IS", () => {
    // Per the 2026-07-20 re-review of livePurchaseOrders: only a KILLED (cancelled) order is
    // a non-cost; a PO the office left in the default 'draft' status is still real committed
    // material and must count, so the job hub can't under-report materials.
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pos: [
        { id: "po-1", job_id: "A", total: 500, status: "cancelled" },
        { id: "po-2", job_id: "A", total: 300, status: "draft" },
        { id: "po-3", job_id: "A", total: 200, status: "received" },
      ],
      bills: [],
    });
    expect(rows[0].cost).toBe(500); // 300 (draft) + 200 (received); cancelled excluded
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
      payments: [pay("A", 500)],
      entries: [shift],
    });
    expect(rows[0].cost).toBe(120); // 3h × $40
  });

  it("drops jobs with zero revenue AND zero cost", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A"), job("EMPTY")],
      payments: [pay("A", 500)],
    });
    expect(rows.map((r) => r.id)).toEqual(["A"]);
  });

  it("ranks most-profitable first", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("LOW"), job("HIGH")],
      payments: [pay("LOW", 100), pay("HIGH", 900)],
    });
    expect(rows.map((r) => r.id)).toEqual(["HIGH", "LOW"]);
  });

  it("floors revenue at zero when refunds exceed collections", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 100)],
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
