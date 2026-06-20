import { describe, it, expect } from "vitest";
import { recalcTotals, resolveDrawCredit, drawAmount, progressSummary } from "@/lib/invoice-math";
import { computeJobLaborBilling } from "@/lib/labor-billing";
import { payPeriodBounds, payPeriodForOffset } from "@/lib/tz";
import { hoursBetween, formatCurrency } from "@/lib/utils";

// Regression tests for bugs found by the adversarial gap hunt. Each one fails on
// the pre-fix code.

describe("recalcTotals — float + NaN + zero/negative-total status", () => {
  it("marks PAID when installments sum to the total in float (0.01 + 2.01 = $2.02)", () => {
    const r = recalcTotals([2.02], [0.01, 2.01], 0, "sent");
    expect(r.amountPaid).toBe(2.02);
    expect(r.status).toBe("paid"); // was stuck "partial"
  });
  it("treats a NaN line / NaN tax as 0 instead of poisoning the total", () => {
    expect(recalcTotals([100, NaN], [], 0, "sent")).toMatchObject({ subtotal: 100, total: 100 });
    expect(recalcTotals([100], [], NaN, "sent")).toMatchObject({ tax: 0, total: 100 });
  });
  it("rounds subtotal + amountPaid to cents (no float dust persisted)", () => {
    expect(recalcTotals([0.1, 0.2], [0.1, 0.2], 0, "sent")).toMatchObject({ subtotal: 0.3, amountPaid: 0.3 });
  });
  it("settles a $0 / credit-memo invoice as paid (not stuck partial / reverted to sent)", () => {
    expect(recalcTotals([], [50], 0, "sent").status).toBe("paid");
    expect(recalcTotals([-50], [], 0, "paid").status).toBe("paid");
  });
});

describe("resolveDrawCredit — never negative / never NaN", () => {
  it("floors a negative prior at 0 (can't ADD money to the invoice)", () => {
    expect(resolveDrawCredit(5000, -2000)).toEqual({ ok: true, credit: 0 });
  });
  it("treats a NaN prior as no prior", () => {
    expect(resolveDrawCredit(5000, NaN)).toEqual({ ok: true, credit: 0 });
  });
  it("rejects a NaN imported total as no-work", () => {
    expect(resolveDrawCredit(NaN, 1000)).toEqual({ ok: false, reason: "no-work" });
  });
});

describe("drawAmount — floored at $0, finite", () => {
  it("returns 0 for a negative remaining estimate", () => {
    expect(drawAmount("percent", 50, -1000)).toBe(0);
  });
  it("returns 0 for a negative fixed value", () => {
    expect(drawAmount("fixed", -500, 0)).toBe(0);
  });
  it("returns 0 (not Infinity/NaN) for non-finite inputs", () => {
    expect(drawAmount("fixed", Infinity, 0)).toBe(0);
    expect(drawAmount("percent", 50, NaN)).toBe(0);
  });
});

describe("progressSummary — finite, no misleading negative", () => {
  it("stays finite with NaN/undefined inputs", () => {
    expect(progressSummary(NaN, 100, 0, 0)).toEqual({ pctComplete: 0, balance: 0 });
    expect(progressSummary(1000, 100, 0, NaN as any)).toMatchObject({ balance: expect.any(Number) });
  });
  it("shows 0 balance (not -5000) when there's no estimate but money was received", () => {
    expect(progressSummary(0, 0, 5000, 0)).toEqual({ pctComplete: 0, balance: 0 });
  });
});

describe("computeJobLaborBilling — id collision, rate-freeze, bad rates, lunch", () => {
  const e = (profiles: any, hours: number, lunch = 0, allocs: any[] = []) => ({
    clock_in: "2026-06-01T08:00:00Z",
    clock_out: new Date(new Date("2026-06-01T08:00:00Z").getTime() + hours * 3_600_000).toISOString(),
    lunch_minutes: lunch, profiles, time_allocations: allocs,
  });
  const a = (profiles: any, hours: number) => ({ hours, time_entries: { profiles } });

  it("does NOT merge two distinct rate-less workers (keys on name when id is absent)", () => {
    const r = computeJobLaborBilling([], [a({ full_name: "A", bill_rate: 75 }, 10), a({ full_name: "B", bill_rate: 150 }, 10)], 0);
    expect(r.lines).toHaveLength(2);
    expect(r.total).toBe(750 + 1500);
  });
  it("does not freeze a person's rate on the first (rate-less) snapshot", () => {
    // alloc snapshot has no rate, entry snapshot has $75 — should bill all 8h at $75.
    const r = computeJobLaborBilling([e({ id: "b", full_name: "Brian", bill_rate: 75 }, 3)], [a({ id: "b", full_name: "Brian" }, 5)], 0);
    expect(r.total).toBe(600);
  });
  it("treats a negative or non-finite rate as no rate (falls back to default)", () => {
    expect(computeJobLaborBilling([e({ id: "x", full_name: "X", bill_rate: -50 }, 8)], [], 99).total).toBe(8 * 99);
    expect(Number.isFinite(computeJobLaborBilling([e({ id: "i", full_name: "I", bill_rate: Infinity }, 4)], [], 50).total)).toBe(true);
  });
  it("a negative lunch can't add billable time", () => {
    // 8h shift, lunch -60 must not become 9h.
    expect(computeJobLaborBilling([e({ id: "b", full_name: "Brian", bill_rate: 100 }, 8, -60)], [], 0).lines[0].quantity).toBe(8);
  });
});

describe("tz — invalid dates don't crash, huge offset doesn't hang", () => {
  it("falls back instead of throwing on a regex-shaped but invalid date (month 13)", () => {
    expect(() => payPeriodBounds("biweekly", "2026-13-05", "2026-06-19")).not.toThrow();
    expect(() => payPeriodBounds("monthly", "x", "2026-02-30")).not.toThrow();
  });
  it("clamps a non-finite offset instead of looping forever", () => {
    const r = payPeriodForOffset("biweekly", "2026-01-05", "2026-01-20", Infinity);
    expect(r).toHaveProperty("start");
    expect(r).toHaveProperty("end");
  });
});

describe("utils — formatCurrency + hoursBetween guards", () => {
  it("never renders $NaN / $Infinity", () => {
    expect(formatCurrency(NaN)).toBe("$0.00");
    expect(formatCurrency(Infinity)).toBe("$0.00");
  });
  it("hoursBetween: negative lunch never adds time; bad/garbage inputs → 0", () => {
    const start = "2026-06-01T08:00:00Z";
    const end = "2026-06-01T16:00:00Z";
    expect(hoursBetween(start, end, -60)).toBe(8);
    expect(hoursBetween(start, end, 600)).toBe(0);
    expect(hoursBetween("not-a-date", end)).toBe(0);
    expect(hoursBetween(start, end, NaN)).toBe(8);
  });
});
