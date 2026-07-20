import { describe, it, expect } from "vitest";
import { computeArAging, computeArByCustomer, computeRevenueTrend, computeQuoteStats, computeCustomerValue, computeCollected, trailing12Months, jobBillingStatus } from "@/lib/analytics/money-metrics";

describe("computeArAging — A/R buckets (reconciles /analytics)", () => {
  const TODAY = "2026-07-05"; // org-local today
  const NOW = Date.UTC(2026, 6, 5);
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
      TODAY,
    );
    expect(ar.buckets).toEqual({ current: 1000, d30: 1000, d60: 1000, d90: 1000 });
    expect(ar.outstanding).toBe(4000);
    expect(ar.openCount).toBe(4);
    expect(ar.invoices.map((r) => r.bucket)).toEqual(["d90", "d60", "d30", "current"]);
    expect(ar.invoices[0].daysLate).toBe(90);
  });

  it("skips zero-balance invoices from buckets but still counts them open", () => {
    const ar = computeArAging([mk("sent", 45, 500, 500)], TODAY);
    expect(ar.outstanding).toBe(0);
    expect(ar.openCount).toBe(1);
    expect(ar.invoices.length).toBe(0);
  });

  it("an invoice with NO due date is outstanding but never 'late' (matches /billing's overdue rule)", () => {
    // The 7/15 "these numbers aren't calculating right": /analytics said "1–30 days late"
    // for dateless sent invoices (created_at fallback) while /billing's Overdue tile said $0.
    const ar = computeArAging(
      [{ invoice_number: "INV-29", status: "sent", total: 387.5, amount_paid: 0, due_date: null, created_at: "2026-06-26T21:10:56Z", customers: { name: "Doe" } }],
      TODAY,
    );
    expect(ar.buckets).toEqual({ current: 387.5, d30: 0, d60: 0, d90: 0 });
    expect(ar.outstanding).toBe(387.5);
    expect(ar.invoices[0].daysLate).toBe(0);
    expect(ar.invoices[0].bucket).toBe("current");
  });

  it("due TODAY is not late; due YESTERDAY is 1 day late — whole org-local days, no UTC drift", () => {
    const inv = (due: string) => ({ invoice_number: due, status: "sent", total: 100, amount_paid: 0, due_date: due, customers: null });
    const ar = computeArAging([inv("2026-07-05"), inv("2026-07-04")], TODAY);
    const byNum = Object.fromEntries(ar.invoices.map((r) => [r.invoice_number, r]));
    expect(byNum["2026-07-05"].bucket).toBe("current"); // due today ≠ late (old code flagged it from 5 PM Pacific the night BEFORE)
    expect(byNum["2026-07-05"].daysLate).toBe(0);
    expect(byNum["2026-07-04"].bucket).toBe("d30");
    expect(byNum["2026-07-04"].daysLate).toBe(1);
  });
});

describe("jobBillingStatus — the /jobs completed-row tag (shares AR's invoiceBalance math)", () => {
  const inv = (status: string, total = 1000, paid = 0) => ({ status, total, amount_paid: paid });

  it("no invoices at all → To Be Invoiced", () => {
    expect(jobBillingStatus([])).toBe("to_be_invoiced");
  });

  it("draft-ONLY → To Be Invoiced (the finish-job 'held for review' queue case)", () => {
    // auto_send_invoice_on_complete=false parks the auto-invoice as a draft in the
    // "To be invoiced" queue — the tag must use the app's own vocabulary for that.
    expect(jobBillingStatus([inv("draft", 500)])).toBe("to_be_invoiced");
  });

  it("void invoices don't count as billed", () => {
    expect(jobBillingStatus([inv("void", 500)])).toBe("to_be_invoiced");
    expect(jobBillingStatus([inv("void", 500), inv("draft", 500)])).toBe("to_be_invoiced");
  });

  it("sent + nothing paid → Pending", () => {
    expect(jobBillingStatus([inv("sent", 1000)])).toBe("pending");
  });

  it("OVERDUE still reads Pending here — aging is /billing/ar's concern, not the tag's", () => {
    expect(jobBillingStatus([inv("overdue", 1000)])).toBe("pending");
  });

  it("some but not all paid → Partial (partially-paid invoice)", () => {
    expect(jobBillingStatus([inv("partial", 1000, 400)])).toBe("partial");
  });

  it("one invoice paid, another still open → Partial (job-level, not invoice-level)", () => {
    expect(jobBillingStatus([inv("paid", 500, 500), inv("sent", 500)])).toBe("partial");
  });

  it("every live invoice settled → Paid In Full", () => {
    expect(jobBillingStatus([inv("paid", 1000, 1000)])).toBe("paid_in_full");
    expect(jobBillingStatus([inv("paid", 500, 500), inv("paid", 250, 250)])).toBe("paid_in_full");
  });

  it("an UN-DRAWN milestone keeps a paid-deposit draw job at Partial (audit 2026-07-20)", () => {
    // finishJob completes a draw job without drafting the remaining draws: the deposit is
    // the only live invoice and it's paid, but most of the contract is still to bill —
    // getMoneyPipeline shows the same job in "Done — not invoiced". Green would be a lie.
    expect(jobBillingStatus([inv("paid", 5000, 5000)], { hasOpenMilestones: true })).toBe("partial");
    expect(jobBillingStatus([inv("paid", 5000, 5000)], { hasOpenMilestones: false })).toBe("paid_in_full");
    // No milestones at all (T&M jobs) behaves exactly as before the option existed.
    expect(jobBillingStatus([inv("paid", 5000, 5000)])).toBe("paid_in_full");
    // An un-drawn milestone can't upgrade a not-yet-invoiced job either.
    expect(jobBillingStatus([inv("draft", 5000, 0)], { hasOpenMilestones: true })).toBe("to_be_invoiced");
  });

  it("a VOID invoice can't block Paid In Full", () => {
    expect(jobBillingStatus([inv("paid", 1000, 1000), inv("void", 800)])).toBe("paid_in_full");
  });

  it("cents-tolerant like invoiceBalance: float dust never leaves a job stuck Partial", () => {
    // 0.01 + 2.01-style dust: owed 0.004 must read settled, not "partial".
    expect(jobBillingStatus([inv("paid", 100, 99.996)])).toBe("paid_in_full");
  });

  it("paid deposit + a DRAFTED final draw → Partial, never Paid In Full (billing isn't finished)", () => {
    // The real draw workflow: deposit collected, finish-job drafts the final draw.
    // The lingering draft is money still to bill — the job can't read settled.
    expect(jobBillingStatus([inv("paid", 2000, 2000), inv("draft", 3000)])).toBe("partial");
  });

  it("a $0 leftover draft doesn't block Paid In Full (nothing left to bill)", () => {
    expect(jobBillingStatus([inv("paid", 1000, 1000), inv("draft", 0)])).toBe("paid_in_full");
  });

  it("null/garbage money fields never poison the tag", () => {
    expect(jobBillingStatus([{ status: "sent", total: null, amount_paid: null }])).toBe("paid_in_full"); // $0 sent = zero open balance
    expect(jobBillingStatus([{ status: "sent", total: NaN, amount_paid: undefined }])).toBe("paid_in_full");
    expect(jobBillingStatus([inv("sent", 1000, NaN)])).toBe("pending");
  });
});

describe("trailing12Months — day-1-pinned month math", () => {
  it("ends in today's month, oldest first", () => {
    const m = trailing12Months("2026-07-15");
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2025-08");
    expect(m[11]).toBe("2026-07");
  });

  it("does not overflow on the 31st (May 31 − 11 months is June, not July)", () => {
    const m = trailing12Months("2026-05-31");
    expect(m[0]).toBe("2025-06"); // setMonth overflow produced 2025-07 and dropped the current month
    expect(m[11]).toBe("2026-05");
  });
});

describe("computeRevenueTrend — collected by month", () => {
  const TODAY = "2026-07-15"; // org-local today
  const pay = (amount: number, month: string, isVoid = false) => ({
    amount,
    paid_at: `2026-${month}-10T00:00:00Z`,
    invoices: { status: isVoid ? "void" : "paid" },
  });

  it("buckets by month, skips void-invoice payments, nets refunds, finds best/worst", () => {
    const t = computeRevenueTrend(
      [pay(1000, "07"), pay(500, "07"), pay(2000, "06"), pay(999, "07", true)],
      [{ amount: 100 }],
      TODAY,
      "UTC",
    );
    expect(t.series.length).toBe(12);
    expect(t.series.find((s) => s.month === "2026-07")!.collected).toBe(1500);
    expect(t.series.find((s) => s.month === "2026-06")!.collected).toBe(2000);
    expect(t.collected12).toBe(3400); // 3500 collected − 100 refund
    expect(t.best!.month).toBe("2026-06");
  });

  it("ignores payments outside the trailing 12-month window", () => {
    const t = computeRevenueTrend([{ amount: 5000, paid_at: "2024-01-10T00:00:00Z", invoices: { status: "paid" } }], [], TODAY, "UTC");
    expect(t.collected12).toBe(0);
  });

  it("buckets a late-evening Pacific payment into the ORG month, not the UTC month", () => {
    // 2026-07-01T02:26Z is June 30, 7:26 PM in Los Angeles — the /payments-page
    // month-boundary class: it must land in the JUNE bar, not July's.
    const evening = { amount: 540, paid_at: "2026-07-01T02:26:02Z", invoices: { status: "paid" } };
    const t = computeRevenueTrend([evening], [], TODAY, "America/Los_Angeles");
    expect(t.series.find((s) => s.month === "2026-06")!.collected).toBe(540);
    expect(t.series.find((s) => s.month === "2026-07")!.collected).toBe(0);
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
  const TODAY = "2026-07-05";
  const NOW = Date.UTC(2026, 6, 5);
  it("groups open balances per customer, worst lateness first, totals rounded", () => {
    const aging = computeArAging(
      [
        { id: "i1", customer_id: "c1", invoice_number: "INV-1", status: "sent", total: 1000, amount_paid: 0, due_date: new Date(NOW - 40 * 86400_000).toISOString(), customers: { name: "Alice" } },
        { id: "i2", customer_id: "c1", invoice_number: "INV-2", status: "partial", total: 500, amount_paid: 100, due_date: new Date(NOW + 5 * 86400_000).toISOString(), customers: { name: "Alice" } },
        { id: "i3", customer_id: "c2", invoice_number: "INV-3", status: "sent", total: 200, amount_paid: 0, due_date: new Date(NOW - 5 * 86400_000).toISOString(), customers: { name: "Bob" } },
        { id: "i4", customer_id: "c2", invoice_number: "INV-4", status: "paid", total: 999, amount_paid: 999, due_date: null, created_at: new Date(NOW).toISOString(), customers: { name: "Bob" } },
      ],
      TODAY,
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
      TODAY,
    );
    const out = computeArByCustomer(aging);
    expect(out).toHaveLength(1);
    expect(out[0].customer).toBe("No customer");
    expect(out[0].balance).toBe(50);
  });
});

describe("computeCollected — THE cash definition (/billing + /payments headline)", () => {
  const pays = [
    { amount: 1000, paid_at: "2026-06-15T18:00:00Z", invoices: { status: "paid" } },
    { amount: 400, paid_at: "2026-07-02T18:00:00Z", invoices: { status: "partial" } },
  ];

  it("sums the payments table — an account CREDIT is not cash and never appears here", () => {
    // The bug: both tiles summed invoices.amount_paid, and recalcInvoice folds open credits
    // into that field. Writing off a disputed invoice as a $1,500 credit — no cash anywhere —
    // pushed "Collected" UP by $1,500, above the payments ledger printed right below it and
    // above what /analytics and Nort reported for the same period.
    expect(computeCollected(pays, [])).toBe(1400);
  });

  it("refunds are cash OUT and come off the top", () => {
    expect(computeCollected(pays, [{ amount: 150, created_at: "2026-07-03T18:00:00Z" }])).toBe(1250);
  });

  it("a voided invoice's payments are reversed money — dropped (matches the ledger + revenue trend)", () => {
    const withVoid = [...pays, { amount: 900, paid_at: "2026-07-04T18:00:00Z", invoices: { status: "void" } }];
    expect(computeCollected(withVoid, [])).toBe(1400);
  });

  it("`since` narrows both sides to the period (the /payments month tile)", () => {
    const monthStart = new Date("2026-07-01T07:00:00Z"); // org-local July 1, Pacific
    expect(computeCollected(pays, [{ amount: 100, created_at: "2026-06-20T18:00:00Z" }], monthStart)).toBe(400);
    expect(computeCollected(pays, [{ amount: 100, created_at: "2026-07-05T18:00:00Z" }], monthStart)).toBe(300);
  });

  it("agrees with computeRevenueTrend on the same rows — one number across the app", () => {
    const trend = computeRevenueTrend(pays, [], "2026-07-20", "America/Los_Angeles");
    expect(computeCollected(pays, [])).toBe(trend.collected12);
  });

  it("empty/garbage rows are $0, never NaN", () => {
    expect(computeCollected([], [])).toBe(0);
    expect(computeCollected([{ amount: null, paid_at: null }], [])).toBe(0);
  });
});
