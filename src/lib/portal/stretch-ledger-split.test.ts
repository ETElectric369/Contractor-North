import { describe, it, expect } from "vitest";
import { buildJobLedger, type LedgerInput } from "./stretch-ledger";
import { INV_078, LINES, PAYMENTS, STRETCHES } from "./j011-fixture";
import { INV_078_TODAY, LINES_TODAY, PAYMENTS_TODAY } from "./j011-today-fixture";

/**
 * LABOR AND MATERIALS, APART (Erik, 2026-09-24: "no simple breakdown separating time and material
 * right at the top, its all mixed in"), and a deposit with its credit (audit v994 MR5).
 */
const TZ = "America/Los_Angeles";
const j011 = (over: Partial<LedgerInput> = {}) =>
  buildJobLedger({ stretches: STRETCHES, invoices: [INV_078], lines: LINES, payments: PAYMENTS, tz: TZ, ...over });
const today = () => buildJobLedger({ stretches: STRETCHES, invoices: [INV_078_TODAY], lines: LINES_TODAY, payments: PAYMENTS_TODAY, tz: TZ });
const cents = (n: number) => Math.round(n * 100);
const splitOf = (split: { lines: { group: string; amount: number }[] }) => Object.fromEntries(split.lines.map((l) => [l.group, l.amount]));

describe("labor and materials apart, at every level, to the cent", () => {
  it("J-011 today: $9,590.89 of work is Labor $7,000.00 (83.5 hours) and Materials $2,590.89; paid $6,760; balance $2,830.89", () => {
    const l = today();
    expect(l.workTotal).toBe(9590.89);
    expect(l.split).toEqual({
      laborHours: 83.5,
      lines: [
        { group: "labor", label: "Labor", amount: 7000 },
        { group: "materials", label: "Materials", amount: 2590.89 },
      ],
    });
    expect(l.paidTotal).toBe(6760);
    expect(l.balance).toBe(2830.89);
    expect(l.billedTotal).toBe(9590.89);
    expect(l.billedBalance).toBe(2830.89);
    expect(l.reconciles).toBe(true);
    expect(l.stretches.map((s) => [s.label, splitOf(s.split), s.split.laborHours, s.paidTotal, s.balanceAfter])).toEqual([
      ["Rough-in Start", { labor: 1850, materials: 409.12 }, 21, 1850, 409.12],
      ["Rough-in", { labor: 3400, materials: 744.52 }, 39.5, 4050, 503.64],
      ["Trim", { labor: 850, materials: 945.39 }, 11, 860, 1439.03],
      ["Fixtures", { labor: 900, materials: 491.86 }, 12, 0, 2830.89],
    ]);
  });

  it("every level's split adds up to its own total, and the days' splits add up to the stretch's", () => {
    for (const l of [j011(), today()]) {
      expect(l.split.lines.reduce((a, x) => a + cents(x.amount), 0)).toBe(cents(l.workTotal));
      for (const s of l.stretches) {
        expect(s.split.lines.reduce((a, x) => a + cents(x.amount), 0)).toBe(cents(s.workTotal));
        const fromDays = new Map<string, number>();
        let dayHours = 0;
        for (const d of s.days) {
          expect(d.split.lines.reduce((a, x) => a + cents(x.amount), 0)).toBe(cents(d.total));
          for (const x of d.split.lines) fromDays.set(x.group, (fromDays.get(x.group) ?? 0) + cents(x.amount));
          // Each row sits under the group it was summed into.
          const labor = d.labor.reduce((a, r) => a + cents(r.amount), 0) + d.items.filter((i) => i.group === "labor").reduce((a, i) => a + cents(i.amount), 0);
          expect(cents(d.split.lines.find((x) => x.group === "labor")?.amount ?? 0)).toBe(labor);
          const materials = d.items.filter((i) => i.group === "materials").reduce((a, i) => a + cents(i.amount), 0);
          expect(cents(d.split.lines.find((x) => x.group === "materials")?.amount ?? 0)).toBe(materials);
          dayHours += Math.round(d.split.laborHours * 100);
        }
        for (const x of s.split.lines) expect(fromDays.get(x.group) ?? 0).toBe(cents(x.amount));
        expect(dayHours).toBe(Math.round(s.split.laborHours * 100));
      }
    }
  });

  it("the older snapshot splits the same way (Labor $6,100 for 71.5 hours, Materials $2,218.62)", () => {
    expect(j011().split).toEqual({
      laborHours: 71.5,
      lines: [
        { group: "labor", label: "Labor", amount: 6100 },
        { group: "materials", label: "Materials", amount: 2218.62 },
      ],
    });
  });

  it("a stretch with only materials still lists Labor, at $0.00; a day lists only what it has", () => {
    const fixtures = j011().stretches[3];
    expect(splitOf(fixtures.split)).toEqual({ labor: 0, materials: 119.59 });
    expect(fixtures.days.every((d) => d.split.lines.every((x) => x.group === "materials"))).toBe(true);
  });

  it("other kinds get their own group only when present; a typed line billed in hours is labor, a typed line in each is Other", () => {
    const inv = { id: "a", invoice_number: "INV-9", status: "sent", invoice_kind: "standard", tax: 7.5, total: 507.5, amount_paid: 0, created_at: "2026-03-02T18:00:00Z", sent_at: "2026-03-02T18:00:00Z" };
    const lines = [
      { invoice_id: "a", sort_order: 0, description: "Labor - Brian", quantity: 2, unit: "hr", unit_price: 50, line_total: 100, import_source: null },
      { invoice_id: "a", sort_order: 1, description: "Labor - extra hour", quantity: 1, unit: "ea", unit_price: 40, line_total: 40, import_source: null },
      { invoice_id: "a", sort_order: 2, description: "Add a circuit", quantity: 1, unit: "lot", unit_price: 300, line_total: 300, import_source: "change_orders" },
      { invoice_id: "a", sort_order: 3, description: "Wire", quantity: 1, unit: "ea", unit_price: 60, line_total: 60, import_source: "costs", sources: [{ date: "2026-03-01", at: null }] },
    ];
    const l = buildJobLedger({ stretches: [], invoices: [inv], lines, payments: [], tz: TZ });
    expect(l.split).toEqual({
      laborHours: 2,
      lines: [
        { group: "labor", label: "Labor", amount: 100 },
        { group: "materials", label: "Materials", amount: 60 },
        { group: "change_orders", label: "Change Orders", amount: 300 },
        { group: "tax", label: "Sales Tax", amount: 7.5 },
        { group: "other", label: "Other", amount: 40 },
      ],
    });
    expect(l.reconciles).toBe(true);
  });
});

describe("a deposit bill and the credit that takes it off sit together (audit v994 MR5)", () => {
  const STR = [
    { id: "s1", label: "Rough", starts_on: "2026-07-01", ends_on: "2026-07-31" },
    { id: "s2", label: "Finish", starts_on: "2026-08-01", ends_on: "2026-08-31" },
  ];
  const deposit = (sent: string) => ({ id: "dep", invoice_number: "INV-D", status: "paid", invoice_kind: "deposit", tax: 0, total: 10000, amount_paid: 10000, created_at: sent, sent_at: sent });
  const progress = (sent: string) => ({ id: "prg", invoice_number: "INV-P", status: "partial", invoice_kind: "progress", tax: 0, total: 10000, amount_paid: 5000, created_at: sent, sent_at: sent });
  const LINES_MR5 = [
    { invoice_id: "dep", sort_order: 0, description: "Deposit - hot tub feed", quantity: 1, unit: "lot", unit_price: 10000, line_total: 10000, import_source: null },
    { invoice_id: "prg", sort_order: 0, description: "Rough work", quantity: 1, unit: "ea", unit_price: 20000, line_total: 20000, import_source: "costs", sources: [{ date: "2026-07-15", at: null }] },
    { invoice_id: "prg", sort_order: 1, description: "Less previous billings (deposit & prior draws)", quantity: 1, unit: "lot", unit_price: -10000, line_total: -10000, import_source: "draw_credit" },
  ];
  const PAYS = [
    { invoice_id: "dep", amount: 10000, paid_at: "2026-07-02T18:00:00Z", method: "check" },
    { invoice_id: "prg", amount: 5000, paid_at: "2026-08-20T18:00:00Z", method: "check" },
  ];

  it("in the usual order, the first stretch owes the work less the deposit, not the work plus it", () => {
    const l = buildJobLedger({ stretches: STR, invoices: [deposit("2026-07-01T18:00:00Z"), progress("2026-08-15T18:00:00Z")], lines: LINES_MR5, payments: PAYS, tz: TZ });
    expect(l.stretches.map((s) => [s.label, s.workTotal, s.paidTotal, s.balanceAfter])).toEqual([
      ["Rough", 20000, 10000, 10000],
      ["Finish", 0, 5000, 5000],
    ]);
    const credit = l.stretches[0].days.flatMap((d) => d.items.map((i) => ({ date: d.date, ...i }))).find((i) => i.group === "credit");
    expect(credit).toMatchObject({ date: "2026-07-01", amount: -10000, datedBy: "deposit" });
    expect(splitOf(l.stretches[0].split)).toEqual({ labor: 0, materials: 20000, deposit: 10000, credit: -10000 });
    expect(l.reconciles).toBe(true);
    expect(l.balance).toBe(5000);
  });

  it("J-002's inverted dates (the deposit sent after the progress bill): the credit still goes with the deposit", () => {
    const l = buildJobLedger({ stretches: STR, invoices: [deposit("2026-07-12T18:00:00Z"), progress("2026-07-05T18:00:00Z")], lines: LINES_MR5, payments: PAYS, tz: TZ });
    const day = l.stretches[0].days.find((d) => d.date === "2026-07-12");
    expect(day?.items.map((i) => [i.group, i.amount, i.datedBy])).toEqual([
      ["deposit", 10000, "bill"],
      ["credit", -10000, "deposit"],
    ]);
    expect(l.stretches.map((s) => s.balanceAfter)).toEqual([10000, 5000]);
    expect(l.reconciles).toBe(true);
  });

  it("with no deposit bill on the job, a draw credit keeps its own bill's day", () => {
    const l = buildJobLedger({
      stretches: STR,
      invoices: [progress("2026-08-15T18:00:00Z")],
      lines: LINES_MR5.filter((x) => x.invoice_id === "prg"),
      payments: PAYS.filter((p) => p.invoice_id === "prg"),
      tz: TZ,
    });
    const credit = l.stretches.flatMap((s) => s.days.flatMap((d) => d.items.map((i) => ({ date: d.date, ...i })))).find((i) => i.group === "credit");
    expect(credit).toMatchObject({ date: "2026-08-15", datedBy: "bill" });
  });
});
