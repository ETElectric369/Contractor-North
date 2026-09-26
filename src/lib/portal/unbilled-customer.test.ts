import { describe, it, expect } from "vitest";
import { computeUnbilledWork, customerUnbilled, foldClaims, netOfDeposit } from "@/lib/unbilled-work";
import { customerRateRow, payViewRow } from "@/lib/labor-billing";
import { jobBillsItsActuals } from "@/lib/invoice-import-rule";

/**
 * THE WORK NOT ON A BILL YET, AS THE CUSTOMER SEES IT: the office's arithmetic, cut to the fields a
 * customer may read. The office shape carries the receipts at cost, what was taken off them as the
 * company's own and the markup; none of it may reach the portal.
 */
describe("customerUnbilled", () => {
  const u = computeUnbilledWork({
    claims: foldClaims([], true),
    jobEntries: [
      { id: "t1", clock_in: "2026-09-24T16:00:00Z", clock_out: "2026-09-24T20:10:00Z", lunch_minutes: 0, profiles: { id: "b", full_name: "Brian", bill_rate: 50 } },
    ],
    nonBillableCodes: new Set(),
    defaultRate: 100,
    levelRate: null,
    pos: [],
    bills: [{ id: "b1", amount: 100, po_id: null, bill_line_items: [] } as never],
    markupPct: 15,
  });

  it("is the office figure, at the customer's prices", () => {
    const c = customerUnbilled(u);
    expect(c).toEqual({
      hours: 4.25,
      laborByPerson: [{ name: "Brian", hours: 4.25, amount: 212.5 }],
      laborAmount: 212.5,
      materials: 115,
      returnsCredit: 0,
      total: 327.5,
    });
  });

  it("carries none of the office's cost fields", () => {
    const c = customerUnbilled(u);
    expect(Object.keys(c).sort()).toEqual(["hours", "laborAmount", "laborByPerson", "materials", "returnsCredit", "total"]);
    const text = JSON.stringify(c);
    for (const banned of ["billsAmount", "excluded", "markupPct", "returnsAmount", "claimed", "lastInvoice", "poCovered", "schemaReady", "rate"]) {
      expect(text).not.toContain(banned);
    }
    expect(u.billsAmount).toBe(100); // the office still sees its cost
  });
});

describe("netOfDeposit: the portal nets the deposit the office card nets", () => {
  const c = { hours: 19.5, laborByPerson: [], laborAmount: 2437.5, materials: 0, returnsCredit: 0, total: 2437.5 };
  it("a deposit that covers the work takes all of it (Tao-shaped: $10,000 against $2,437.50)", () => {
    expect(netOfDeposit(c, 10000).lessDeposit).toBe(2437.5);
  });
  it("a smaller deposit takes itself", () => {
    expect(netOfDeposit(c, 1000).lessDeposit).toBe(1000);
  });
  it("no deposit, or a credit-only total, adds nothing", () => {
    expect(netOfDeposit(c, 0)).toEqual(c);
    expect(netOfDeposit({ ...c, total: -40 }, 1000).lessDeposit).toBeUndefined();
  });
});

describe("payViewRow is profile_pay, row for row, for the service role", () => {
  it("an owner is paid by draw and bills at his bill rate, else his hourly figure", () => {
    expect(payViewRow({ id: "o", role: "owner", hourly_rate: 80, bill_rate: 100 })).toEqual({ id: "o", hourly_rate: 0, bill_rate: 100 });
    expect(payViewRow({ id: "o", role: "owner", hourly_rate: 80, bill_rate: null })).toEqual({ id: "o", hourly_rate: 0, bill_rate: 80 });
  });
  it("anyone else keeps both figures as stored", () => {
    expect(payViewRow({ id: "t", role: "tech", hourly_rate: "32.50", bill_rate: null })).toEqual({ id: "t", hourly_rate: 32.5, bill_rate: null });
    expect(payViewRow({ id: "t", role: "office", hourly_rate: null, bill_rate: "65" })).toEqual({ id: "t", hourly_rate: null, bill_rate: 65 });
  });
});

describe("customerRateRow: the customer's page never prices with a pay rate", () => {
  it("drops the hourly figure; an owner keeps his bill figure", () => {
    expect(customerRateRow({ id: "t", role: "tech", hourly_rate: 32.5, bill_rate: null })).toEqual({ id: "t", hourly_rate: null, bill_rate: null });
    expect(customerRateRow({ id: "t", role: "tech", hourly_rate: 32.5, bill_rate: 65 })).toEqual({ id: "t", hourly_rate: null, bill_rate: 65 });
    expect(customerRateRow({ id: "o", role: "owner", hourly_rate: 80, bill_rate: null })).toEqual({ id: "o", hourly_rate: null, bill_rate: 80 });
  });

  it("a person with no bill rate is priced at the org's rate, so amount / hours is never their pay", () => {
    const pay = { id: "j", role: "tech", hourly_rate: 32.5, bill_rate: null };
    const entry = { id: "t9", clock_in: "2026-09-24T16:00:00Z", clock_out: "2026-09-24T20:00:00Z", lunch_minutes: 0 };
    const run = (profile: object, levelRate: number | null) =>
      customerUnbilled(
        computeUnbilledWork({
          claims: foldClaims([], true),
          jobEntries: [{ ...entry, profiles: { full_name: "Jimmy", ...profile } }],
          nonBillableCodes: new Set(),
          defaultRate: 100,
          levelRate,
          pos: [],
          bills: [],
          markupPct: 0,
        }),
      );
    expect(run(customerRateRow(pay), null).laborByPerson).toEqual([{ name: "Jimmy", hours: 4, amount: 400 }]);
    expect(run(customerRateRow(pay), 85).laborByPerson).toEqual([{ name: "Jimmy", hours: 4, amount: 340 }]);
    // The office's own path agrees now (audit v994 PL2): it used to bill 4 h at his 32.50 PAY
    // ($130). No path prices with a pay rate, so the portal and the importer read one figure.
    expect(run(payViewRow(pay), null).laborByPerson).toEqual([{ name: "Jimmy", hours: 4, amount: 400 }]);
    expect(run(payViewRow(pay), 85).laborByPerson).toEqual([{ name: "Jimmy", hours: 4, amount: 340 }]);
  });
});

describe("jobBillsItsActuals: the Unbilled card's rule, shared with the portal", () => {
  it("EVERY T&M job with no schedule bills its actuals - an estimate is a guide, never a block (Tao J-002)", () => {
    expect(jobBillsItsActuals("tm", 0)).toBe(true);
  });
  it("a schedule or a fixed-price job bills something else", () => {
    expect(jobBillsItsActuals("tm", 2)).toBe(false);
    expect(jobBillsItsActuals("fixed", 0)).toBe(false);
    expect(jobBillsItsActuals(null, 0)).toBe(false);
  });
});
