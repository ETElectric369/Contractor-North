import { describe, it, expect } from "vitest";
import { milestoneAmount, milestoneKind, scheduleStatus, defaultSchedule, contractTotalFromQuotes } from "@/lib/payment-schedule-math";

describe("contractTotalFromQuotes (shared contract-base rule)", () => {
  it("uses the accepted quote(s) when any are accepted (ignores a superseded draft/revision)", () => {
    const t = contractTotalFromQuotes([
      { total: 40000, status: "accepted" },
      { total: 38000, status: "draft" },
    ]);
    expect(t).toBe(40000);
  });
  it("sums all quotes only when none are accepted yet", () => {
    expect(contractTotalFromQuotes([{ total: 10000, status: "sent" }])).toBe(10000);
  });
  it("handles empty + bad totals", () => {
    expect(contractTotalFromQuotes([])).toBe(0);
    expect(contractTotalFromQuotes([{ total: NaN as any, status: "accepted" }])).toBe(0);
  });
});

describe("milestoneAmount", () => {
  it("computes percent of contract", () => {
    expect(milestoneAmount({ sort_order: 0, label: "Deposit", percent: 30 }, 40000)).toBe(12000);
  });
  it("falls back to a fixed amount when no percent", () => {
    expect(milestoneAmount({ sort_order: 0, label: "x", amount: 2500 }, 40000)).toBe(2500);
  });
  it("never returns negative or non-finite", () => {
    expect(milestoneAmount({ sort_order: 0, label: "x", percent: -10 }, 40000)).toBe(0);
    expect(milestoneAmount({ sort_order: 0, label: "x", amount: NaN as any }, 40000)).toBe(0);
  });
});

describe("milestoneKind (position -> draw kind)", () => {
  it("first = deposit, last = final, middle = progress", () => {
    expect(milestoneKind(0, 3)).toBe("deposit");
    expect(milestoneKind(1, 3)).toBe("progress");
    expect(milestoneKind(2, 3)).toBe("final");
  });
  it("a single milestone is a final (full payment)", () => {
    expect(milestoneKind(0, 1)).toBe("final");
  });
});

describe("scheduleStatus", () => {
  const ms = [
    { sort_order: 0, label: "Deposit", percent: 30, invoice_id: "inv-dep" }, // billed (linked)
    { sort_order: 1, label: "Progress", percent: 40 },
    { sort_order: 2, label: "Final", percent: 30 },
  ];
  it("computes totals, billed-to-date, and the next pending milestone", () => {
    const s = scheduleStatus(ms, 40000);
    expect(s.scheduledPct).toBe(100);
    expect(s.scheduledTotal).toBe(40000);
    expect(s.billedTotal).toBe(12000); // only the deposit is linked to an invoice
    expect(s.remaining).toBe(28000);
    expect(s.next?.label).toBe("Progress");
    expect(s.next?.dollars).toBe(16000);
    expect(s.next?.kind).toBe("progress");
  });
  it("next is null once every milestone is billed (linked)", () => {
    const s = scheduleStatus(ms.map((m) => ({ ...m, invoice_id: "inv-x" })), 40000);
    expect(s.next).toBeNull();
    expect(s.billedTotal).toBe(40000);
  });
  it("a deleted draft (invoice_id nulled) re-offers that milestone", () => {
    const s = scheduleStatus(ms.map((m) => ({ ...m, invoice_id: null })), 40000);
    expect(s.next?.label).toBe("Deposit");
    expect(s.billedTotal).toBe(0);
  });
  it("a billed milestone shows its frozen snapshot, not percent-of-the-new-contract", () => {
    // Deposit was billed at $12,000; the contract is later edited up to $50,000.
    const billed = [{ sort_order: 0, label: "Deposit", percent: 30, invoice_id: "inv-dep", billed_amount: 12000 }];
    const s = scheduleStatus(billed, 50000);
    expect(s.rows[0].dollars).toBe(12000); // frozen, NOT 30% of 50,000 = 15,000
    expect(s.billedTotal).toBe(12000);
  });
  it("flags percentOff when the percents don't add to 100", () => {
    const s = scheduleStatus([{ sort_order: 0, label: "a", percent: 50 }, { sort_order: 1, label: "b", percent: 40 }], 10000);
    expect(s.percentOff).toBe(true);
  });
  it("sorts by sort_order regardless of input order", () => {
    const s = scheduleStatus([{ sort_order: 2, label: "Final", percent: 30 }, { sort_order: 0, label: "Deposit", percent: 70 }], 1000);
    expect(s.rows[0].label).toBe("Deposit");
    expect(s.next?.label).toBe("Deposit"); // first pending in order
  });
});

describe("defaultSchedule", () => {
  it("deposit + progress + final always sum to exactly 100", () => {
    for (const dep of [0, 10, 25, 33, 50]) {
      const s = defaultSchedule(dep);
      expect(s.reduce((t, m) => t + (m.percent ?? 0), 0)).toBe(100);
      expect(s.length).toBe(3);
    }
  });
  it("uses the org deposit % when given, else 30", () => {
    expect(defaultSchedule(25)[0].percent).toBe(25);
    expect(defaultSchedule(0)[0].percent).toBe(30);
  });
});

describe("contract DRIFT under a part-drawn schedule (the accepted-quote edit)", () => {
  // 30/40/30 on a $10,000 accepted quote, deposit already drawn and sent (frozen at $3,000).
  const drawn = [
    { sort_order: 0, label: "Deposit", percent: 30, invoice_id: "inv-1", billed_amount: 3000 },
    { sort_order: 1, label: "Progress payment", percent: 40 },
    { sort_order: 2, label: "Final payment", percent: 30 },
  ];

  it("editing the quote DOWN over-bills the contract — and overContract says so", () => {
    // Scope drops to $8,000. The billed deposit keeps its frozen $3,000 while the pending
    // draws re-price off the NEW total: 3000 + 3200 + 2400 = 8600 against an $8,000 contract.
    // setPaymentSchedule's over-contract check only ever ran at creation time, so this flag
    // (rendered on the schedule card) is the only thing standing between the office and a
    // silent $600 overbill.
    const s = scheduleStatus(drawn, 8000);
    expect(s.scheduledTotal).toBe(8600);
    expect(s.overContract).toBe(true);
    expect(s.next?.dollars).toBe(3200);
  });

  it("editing the quote UP under-bills — the schedule no longer covers the contract", () => {
    const s = scheduleStatus(drawn, 12000);
    expect(s.scheduledTotal).toBe(11400); // 3000 frozen + 4800 + 3600
    expect(s.overContract).toBe(false);
    expect(s.scheduledTotal).toBeLessThan(12000);
  });

  it("an untouched contract stays exactly whole", () => {
    const s = scheduleStatus(drawn, 10000);
    expect(s.scheduledTotal).toBe(10000);
    expect(s.overContract).toBe(false);
    expect(s.percentOff).toBe(false);
  });

  it("contractTotalFromQuotes reads the ACCEPTED quote's live total — the value that drifts", () => {
    expect(contractTotalFromQuotes([{ total: 8000, status: "accepted" }, { total: 10000, status: "declined" }])).toBe(8000);
  });
});
