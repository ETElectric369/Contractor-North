import { describe, it, expect } from "vitest";
import { milestoneAmount, milestoneKind, scheduleStatus, defaultSchedule, contractTotalFromQuotes, leftToBill, depositIsRequested } from "@/lib/payment-schedule-math";

describe("contractTotalFromQuotes (shared contract-base rule)", () => {
  it("uses the accepted quote(s) when any are accepted (ignores a superseded draft/revision)", () => {
    const t = contractTotalFromQuotes([
      { total: 40000, status: "accepted" },
      { total: 38000, status: "draft" },
    ]);
    expect(t).toBe(40000);
  });
  // The title used to say "sums all quotes" and passed ONE quote, so it could not tell a sum from
  // newest-wins — it described the rule audit 8 REMOVED (the $22,000 contract). Two dated quotes,
  // so the assertion can only pass under the rule the code actually implements (audit v921).
  it("with nothing accepted, the NEWEST proposal stands alone (never a sum)", () => {
    expect(
      contractTotalFromQuotes([
        { total: 10000, status: "sent", created_at: "2026-01-01T00:00:00Z" },
        { total: 12000, status: "sent", created_at: "2026-02-01T00:00:00Z" },
      ]),
    ).toBe(12000);
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
  // Audit v921: each percent milestone rounded to cents on its own, so an odd-cent contract left
  // a cent that no draw ever billed and nothing flagged (the percents DO sum to 100).
  it("an odd-cent contract is partitioned exactly — the final milestone absorbs the rounding", () => {
    // cn-v1177: defaultSchedule takes the contract and the deposit rule; 30% with no cap is the old 30.
    const s = scheduleStatus(defaultSchedule(100.01, { percent: 30, cap: 0 }), 100.01);
    expect(s.scheduledTotal).toBe(100.01);
    // The deposit row is depositFor's $30.00 to the cent (29.997...% of the contract), so the progress
    // row's half of the rest rounds up to $35.01 and the final absorbs the cent: still exactly the contract.
    expect(s.rows.map((r) => r.dollars)).toEqual([30, 35.01, 35]);
    expect(s.percentOff).toBe(false);
    expect(s.overContract).toBe(false);
  });
  it("a genuine under-schedule is still flagged, not quietly topped up", () => {
    const s = scheduleStatus([{ sort_order: 0, label: "a", percent: 50 }, { sort_order: 1, label: "b", percent: 40 }], 10000);
    expect(s.scheduledTotal).toBe(9000);
    expect(s.percentUnder).toBe(true);
  });
  it("sorts by sort_order regardless of input order", () => {
    const s = scheduleStatus([{ sort_order: 2, label: "Final", percent: 30 }, { sort_order: 0, label: "Deposit", percent: 70 }], 1000);
    expect(s.rows[0].label).toBe("Deposit");
    expect(s.next?.label).toBe("Deposit"); // first pending in order
  });
});

describe("defaultSchedule", () => {
  // cn-v1177 RE-PIN, ON PURPOSE: this used to take a bare percent and answer 30 for 0, because 0 was the
  // setting's default and meant "never chose". The default is now 10% up to $1,000 (lib/deposit-rule,
  // Erik 2026-11-21) and a stored 0 is a company's choice of NO deposit, so 0 answers no deposit row;
  // and the deposit row is depositFor of the contract (the cap included), never its own percent math.
  it("the rows always sum to exactly 100, for any rule and any contract", () => {
    for (const total of [0, 100.01, 5000, 30000, 50000, 123456.78])
      for (const rule of [{ percent: 0, cap: 0 }, { percent: 10, cap: 1000 }, { percent: 25, cap: 0 }, { percent: 33, cap: 2500 }, { percent: 100, cap: 0 }]) {
        const s = defaultSchedule(total, rule);
        expect(Math.round(s.reduce((t, m) => t + (m.percent ?? 0), 0) * 1_000_000), `${total} ${JSON.stringify(rule)}`).toBe(100_000_000);
        expect(s.map((m) => m.sort_order)).toEqual(s.map((_, i) => i));
      }
  });
  it("the deposit row is depositFor of the contract: 10% under the cap, the cap's share above it", () => {
    expect(defaultSchedule(5000, { percent: 10, cap: 1000 })[0]).toMatchObject({ label: "Deposit", percent: 10 });
    expect(defaultSchedule(50000, { percent: 10, cap: 1000 })[0]).toMatchObject({ label: "Deposit", percent: 2 });
    const odd = defaultSchedule(30000, { percent: 10, cap: 1000 });
    expect(odd.map((m) => m.percent)).toEqual([3.333333, 48.333334, 48.333333]);
    // The cap to the cent: $1,000.00, not the $999 a two-place percent would bill.
    expect(scheduleStatus(odd, 30000).rows[0].dollars).toBe(1000);
    expect(scheduleStatus(odd, 30000).scheduledTotal).toBe(30000);
    expect(defaultSchedule(20000, { percent: 25, cap: 0 })[0].percent).toBe(25);
  });
  it("0% is no deposit: progress and final only; with no contract the rule's own percent stands; never above 90", () => {
    expect(defaultSchedule(20000, { percent: 0, cap: 1000 })).toEqual([
      { sort_order: 0, label: "Progress payment", percent: 50 },
      { sort_order: 1, label: "Final payment", percent: 50 },
    ]);
    expect(defaultSchedule(0, { percent: 10, cap: 1000 })[0]).toMatchObject({ label: "Deposit", percent: 10 });
    expect(defaultSchedule(1000, { percent: 100, cap: 0 })[0].percent).toBe(90);
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

describe("contractTotalFromQuotes — a caller that omits created_at must not degrade silently", () => {
  // Audit v800: four projections shipped without created_at. Every comparison returned 0, the
  // stable sort preserved PostgREST's arbitrary order, and "newest revision wins" quietly became
  // "whichever row came back first" — in practice the OLDEST. A job's whole contract total, and
  // the deposit computed from it, rode on that.
  it("throws rather than guessing when several unaccepted quotes arrive without timestamps", () => {
    expect(() =>
      contractTotalFromQuotes([
        { total: 10000, status: "sent" },
        { total: 12000, status: "sent" },
      ]),
    ).toThrow(/created_at/);
  });

  it("still picks the newest revision when the timestamps are present", () => {
    expect(
      contractTotalFromQuotes([
        { total: 10000, status: "sent", created_at: "2026-01-01T00:00:00Z" },
        { total: 12000, status: "sent", created_at: "2026-02-01T00:00:00Z" },
      ]),
    ).toBe(12000);
  });

  it("a single quote needs no timestamp, and accepted quotes never take this path", () => {
    expect(contractTotalFromQuotes([{ total: 9000, status: "sent" }])).toBe(9000);
    expect(
      contractTotalFromQuotes([
        { total: 5000, status: "accepted" },
        { total: 7000, status: "sent" },
      ]),
    ).toBe(5000);
  });
});

describe("leftToBill — the one figure on a job billed by its contract (W1-19)", () => {
  it("a fixed-price contract: the contract less what went out on sent bills (a draft is not a bill)", () => {
    // progress.invoiced already leaves out drafts and void bills (computeJobProgress).
    const l = leftToBill({ estimate: 20000, invoiced: 5000 }, null);
    expect(l.kind).toBe("contract");
    expect(l.contract).toBe(20000);
    expect(l.billed).toBe(5000);
    expect(l.left).toBe(15000);
    expect(l.billedInFull).toBe(false);
    expect(l.over).toBe(0);
  });

  it("billed to the cent: $0.00 left and billed in full", () => {
    const l = leftToBill({ estimate: 12345.67, invoiced: 12345.67 }, null);
    expect(l.left).toBe(0);
    expect(l.billedInFull).toBe(true);
  });

  it("billed past the contract: never a negative figure, and how far over is said", () => {
    const l = leftToBill({ estimate: 10000, invoiced: 10750.5 }, null);
    expect(l.left).toBe(0);
    expect(l.billedInFull).toBe(true);
    expect(l.over).toBe(750.5);
  });

  it("an estimate with no price is not 'billed in full'", () => {
    const l = leftToBill({ estimate: 0, invoiced: 0 }, null);
    expect(l.left).toBe(0);
    expect(l.billedInFull).toBe(false);
  });

  it("a schedule: its own remaining and next payment, the same figures Request Next Payment draws", () => {
    const s = scheduleStatus(
      [
        { sort_order: 0, label: "Deposit", percent: 30, invoice_id: "inv-1", billed_amount: 3000 },
        { sort_order: 1, label: "Rough-In", percent: 35 },
        { sort_order: 2, label: "Final", percent: 35 },
      ],
      10000,
    );
    const l = leftToBill({ estimate: 10000, invoiced: 3000 }, s);
    expect(l.kind).toBe("schedule");
    expect(l.left).toBe(s.remaining);
    expect(l.left).toBe(7000);
    expect(l.billed).toBe(3000);
    expect(l.next).toEqual({ label: "Rough-In", dollars: 3500 });
    expect(l.scheduleShort).toBe(0);
    expect(l.scheduleOver).toBe(0);
  });

  it("a fully drawn schedule: $0.00 left, no next payment", () => {
    const s = scheduleStatus([{ sort_order: 0, label: "Full", percent: 100, invoice_id: "inv-1", billed_amount: 5000 }], 5000);
    const l = leftToBill({ estimate: 5000, invoiced: 5000 }, s);
    expect(l.left).toBe(0);
    expect(l.next).toBeNull();
    expect(l.billedInFull).toBe(true);
  });

  it("a schedule that draws less, or more, than the contract says by how much", () => {
    const short = leftToBill(
      { estimate: 10000, invoiced: 0 },
      scheduleStatus([{ sort_order: 0, label: "a", percent: 50 }, { sort_order: 1, label: "b", percent: 40 }], 10000),
    );
    expect(short.scheduleShort).toBe(1000);
    expect(short.scheduleOver).toBe(0);
    const over = leftToBill(
      { estimate: 10000, invoiced: 0 },
      scheduleStatus([{ sort_order: 0, label: "a", amount: 6000 }, { sort_order: 1, label: "b", amount: 5000 }], 10000),
    );
    expect(over.scheduleOver).toBe(1000);
    expect(over.scheduleShort).toBe(0);
  });

  it("an empty schedule is no schedule; bad numbers never become NaN", () => {
    expect(leftToBill({ estimate: 100, invoiced: 0 }, scheduleStatus([], 100)).kind).toBe("contract");
    const l = leftToBill({ estimate: NaN as unknown as number, invoiced: Infinity as unknown as number }, undefined);
    expect(l.left).toBe(0);
    expect(Number.isFinite(l.billed)).toBe(true);
  });
});

/**
 * THE PREFILL DOES NOT ASK THE DEPOSIT AGAIN (cn-v1178, audit D6). On a job whose deposit was already
 * requested (paid or not), a Deposit row would bill the same figure as a draw the request then nets to
 * $0.00, a bill of nothing sent to the customer. The prefill proposes progress and final only.
 */
describe("defaultSchedule on a job with a live deposit request", () => {
  it("proposes no Deposit row, and the rows still sum to 100", () => {
    const rows = defaultSchedule(30000, { percent: 10, cap: 1000 }, { depositRequested: true });
    expect(rows.map((r) => r.label)).toEqual(["Progress payment", "Final payment"]);
    expect(rows.reduce((t, r) => t + Number(r.percent), 0)).toBe(100);
    expect(defaultSchedule(30000, { percent: 10, cap: 1000 })[0].label).toBe("Deposit");
  });
  it("a deposit request is one that is an estimate's deposit or was made as a deposit; a materials payment is not", () => {
    expect(depositIsRequested([{ quoteId: "q-900", label: "Deposit", status: "paid" }])).toBe(true);
    expect(depositIsRequested([{ quoteId: null, label: "Deposit", status: "sent" }])).toBe(true);
    expect(depositIsRequested([{ quoteId: null, label: "Materials Payment", status: "sent" }])).toBe(false);
    expect(depositIsRequested([{ quoteId: "q-900", label: "Deposit", status: "void" }])).toBe(false);
    expect(depositIsRequested(null)).toBe(false);
  });
});
