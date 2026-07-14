import { describe, it, expect } from "vitest";
import { computeArAging, computeArByCustomer, computeRevenueTrend, computeQuoteStats, computeCustomerValue } from "@/lib/analytics/money-metrics";

describe("computeArAging — A/R buckets (reconciles /analytics)", () => {
  const NOW = Date.UTC(2026, 6, 5); // 2026-07-05
  const mk = (status: string, dueDaysAgo: number, total = 1000, paid = 0) => ({
    invoice_number: `INV-${dueDaysAgo}`,
    status,
    total,
    amount_paid: paid,
    due_date: new Date(NOW - dueDaysAgo * 86_400_000).toISOString(),
    created_at: new Date(NOW).toISOString(),
    customers: { name: "Cust" },
  });

  it("buckets open invoices by days past due, worst first", () => {
    const ar = computeArAging(
      [
        mk("sent", -10), // due 10 days in the future → not yet due
        mk("sent", 10), // 1–30
        mk("sent", 45), // 31–60
        mk("sent", 90), // 60+
        mk("paid", 90), // excluded (paid)
      ],
      NOW,
    );
    expect(ar.buckets).toEqual({ current: 1000, d30: 1000, d60: 1000, d90: 1000 });
    expect(ar.outstanding).toBe(4000);
    expect(ar.openCount).toBe(4);
    expect(ar.invoices.map((r) => r.bucket)).toEqual(["d90", "d60", "d30", "current"]);
    expect(ar.invoices[0].daysLate).toBe(90);
  });

  it("skips zero-balance invoices from buckets but still counts them open", () => {
    const ar = computeArAging([mk("sent", 45, 500, 500)], NOW);
    expect(ar.outstanding).toBe(0);
    expect(ar.openCount).toBe(1);
    expect(ar.invoices.length).toBe(0);
  });
});

describe("computeRevenueTrend — collected by month", () => {
  const NOW = new Date("2026-07-15T12:00:00Z");
  const pay = (amount: number, month: string, isVoid = false) => ({
    amount,
    paid_at: `2026-${month}-10T00:00:00Z`,
    invoices: { status: isVoid ? "void" : "paid" },
  });

  it("buckets by month, skips void-invoice payments, nets refunds, finds best/worst", () => {
    const t = computeRevenueTrend(
      [pay(1000, "07"), pay(500, "07"), pay(2000, "06"), pay(999, "07", true)],
      [{ amount: 100 }],
      NOW,
    );
    expect(t.series.length).toBe(12);
    expect(t.series.find((s) => s.month === "2026-07")!.collected).toBe(1500);
    expect(t.series.find((s) => s.month === "2026-06")!.collected).toBe(2000);
    expect(t.collected12).toBe(3400); // 3500 collected − 100 refund
    expect(t.best!.month).toBe("2026-06");
  });

  it("ignores payments outside the trailing 12-month window", () => {
    const t = computeRevenueTrend([{ amount: 5000, paid_at: "2024-01-10T00:00:00Z", invoices: { status: "paid" } }], [], NOW);
    expect(t.collected12).toBe(0);
  });
});

describe("computeQuoteStats — win rate & pipeline", () => {
  it("counts won/lost/awaiting, win rate over decided, pipeline of sent", () => {
    const s = computeQuoteStats([
      { status: "accepted" },
      { status: "accepted" },
      { status: "declined" },
      { status: "expired" },
      { status: "sent", total: 5000 },
      { status: "sent", total: 3000 },
      { status: "draft" },
    ]);
    expect(s.won).toBe(2);
    expect(s.lost).toBe(2); // declined + expired
    expect(s.awaiting).toBe(2);
    expect(s.pipelineValue).toBe(8000);
    expect(s.winRatePct).toBe(50); // 2 / (2+1+1)
  });

  it("win rate is null when nothing is decided yet", () => {
    const s = computeQuoteStats([{ status: "sent", total: 100 }, { status: "draft" }]);
    expect(s.winRatePct).toBeNull();
    expect(s.pipelineValue).toBe(100);
  });
});

describe("computeCustomerValue — lifetime collected per customer", () => {
  it("sums collected (skips void), tracks last paid + job count, best first", () => {
    const payments = [
      { amount: 1000, paid_at: "2026-06-01", invoices: { customer_id: "c1", status: "paid" } },
      { amount: 500, paid_at: "2026-07-01", invoices: { customer_id: "c1", status: "paid" } },
      { amount: 2000, paid_at: "2026-05-01", invoices: { customer_id: "c2", status: "paid" } },
      { amount: 999, paid_at: "2026-07-05", invoices: { customer_id: "c2", status: "void" } }, // reversed
    ];
    const out = computeCustomerValue(payments, new Map([["c1", 3], ["c2", 1]]), new Map([["c1", "Alice"], ["c2", "Bob"]]));
    expect(out).toEqual([
      { customer: "Bob", collected: 2000, jobs: 1, lastPaid: "2026-05-01" },
      { customer: "Alice", collected: 1500, jobs: 3, lastPaid: "2026-07-01" },
    ]);
  });
});

describe("computeArByCustomer — the AR ledger rollup", () => {
  const NOW = Date.UTC(2026, 6, 5);
  it("groups open balances per customer, worst lateness first, totals rounded", () => {
    const aging = computeArAging(
      [
        { id: "i1", customer_id: "c1", invoice_number: "INV-1", status: "sent", total: 1000, amount_paid: 0, due_date: new Date(NOW - 40 * 86400_000).toISOString(), customers: { name: "Alice" } },
        { id: "i2", customer_id: "c1", invoice_number: "INV-2", status: "partial", total: 500, amount_paid: 100, due_date: new Date(NOW + 5 * 86400_000).toISOString(), customers: { name: "Alice" } },
        { id: "i3", customer_id: "c2", invoice_number: "INV-3", status: "sent", total: 200, amount_paid: 0, due_date: new Date(NOW - 5 * 86400_000).toISOString(), customers: { name: "Bob" } },
        { id: "i4", customer_id: "c2", invoice_number: "INV-4", status: "paid", total: 999, amount_paid: 999, due_date: null, created_at: new Date(NOW).toISOString(), customers: { name: "Bob" } },
      ],
      NOW,
    );
    const out = computeArByCustomer(aging);
    expect(out.map((c) => c.customer)).toEqual(["Alice", "Bob"]); // 40d late beats 5d
    expect(out[0].balance).toBe(1400); // 1000 + 400 open
    expect(out[0].worstDaysLate).toBe(40);
    expect(out[0].invoices).toHaveLength(2);
    expect(out[1].balance).toBe(200); // the paid invoice never enters
    expect(out[1].invoices).toHaveLength(1);
  });

  it("falls back to the name (then a dash) when customer_id is missing", () => {
    const aging = computeArAging(
      [{ invoice_number: "INV-9", status: "sent", total: 50, amount_paid: 0, created_at: new Date(NOW).toISOString(), customers: null }],
      NOW,
    );
    const out = computeArByCustomer(aging);
    expect(out).toHaveLength(1);
    expect(out[0].customer).toBe("No customer");
    expect(out[0].balance).toBe(50);
  });
});
