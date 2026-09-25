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

  it("other kinds get their own group only when present; a typed line billed in hours is labor, and so is one worded Labor", () => {
    const inv = { id: "a", invoice_number: "INV-9", status: "sent", invoice_kind: "standard", tax: 7.5, total: 522.5, amount_paid: 0, created_at: "2026-03-02T18:00:00Z", sent_at: "2026-03-02T18:00:00Z" };
    const lines = [
      { invoice_id: "a", sort_order: 0, description: "Labor - Brian", quantity: 2, unit: "hr", unit_price: 50, line_total: 100, import_source: null },
      { invoice_id: "a", sort_order: 1, description: "Permit fee", quantity: 1, unit: "ea", unit_price: 55, line_total: 55, import_source: null },
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
        { group: "other", label: "Other", amount: 55 },
      ],
    });
    expect(l.reconciles).toBe(true);
  });

  it("typed lines worded Labor or Materials are listed under them (INV-059, J-010), and hours are not printed when some labor was billed in each", () => {
    const inv = { id: "b", invoice_number: "INV-059", status: "paid", invoice_kind: "standard", tax: 0, total: 757.5, amount_paid: 757.5, created_at: "2026-08-02T18:00:00Z", sent_at: "2026-08-02T18:00:00Z" };
    const lines = [
      { invoice_id: "b", sort_order: 0, description: "Labor - Erik ", quantity: 3, unit: "ea", unit_price: 125, line_total: 375, import_source: null },
      { invoice_id: "b", sort_order: 1, description: "Labor - Brian", quantity: 2.5, unit: "ea", unit_price: 65, line_total: 162.5, import_source: null },
      { invoice_id: "b", sort_order: 2, description: "Materials", quantity: 1, unit: "ea", unit_price: 110, line_total: 110, import_source: null },
      { invoice_id: "b", sort_order: 3, description: "Material: Wire, boxes, GFCI, Faceplate", quantity: 1, unit: "ea", unit_price: 110, line_total: 110, import_source: null },
    ];
    const l = buildJobLedger({ stretches: [], invoices: [inv], lines, payments: [], tz: TZ });
    expect(l.split).toEqual({
      laborHours: 0,
      lines: [
        { group: "labor", label: "Labor", amount: 537.5 },
        { group: "materials", label: "Materials", amount: 220 },
      ],
    });
    const items = l.stretches[0].days.flatMap((d) => d.items);
    expect(items.map((i) => [i.description, i.group])).toEqual([
      ["Labor - Erik ", "labor"],
      ["Labor - Brian", "labor"],
      ["Materials", "materials"],
      ["Material: Wire, boxes, GFCI, Faceplate", "materials"],
    ]);
    expect(l.reconciles).toBe(true);
  });

  it("a job whose work the rule cannot split never reads Labor $0.00 / Materials $0.00 (J-053's service call)", () => {
    const inv = { id: "c", invoice_number: "INV-080", status: "sent", invoice_kind: "standard", tax: 0, total: 450, amount_paid: 0, created_at: "2026-09-02T18:00:00Z", sent_at: "2026-09-02T18:00:00Z" };
    const lines = [{ invoice_id: "c", sort_order: 0, description: "Emergency service call", quantity: 1, unit: "ea", unit_price: 450, line_total: 450, import_source: null }];
    const l = buildJobLedger({ stretches: [], invoices: [inv], lines, payments: [], tz: TZ });
    expect(l.split.lines).toEqual([{ group: "other", label: "Other", amount: 450 }]);
    expect(l.stretches[0].split.lines.map((x) => x.group)).toEqual(["other"]);
    // A job of labor alone still says Materials $0.00: that zero is true.
    const lab = buildJobLedger({
      stretches: [],
      invoices: [{ ...inv, total: 100 }],
      lines: [{ invoice_id: "c", sort_order: 0, description: "Service", quantity: 2, unit: "hrs", unit_price: 50, line_total: 100, import_source: null }],
      payments: [],
      tz: TZ,
    });
    expect(lab.split).toEqual({
      laborHours: 2,
      lines: [
        { group: "labor", label: "Labor", amount: 100 },
        { group: "materials", label: "Materials", amount: 0 },
      ],
    });
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
  it("a credit that also nets a later fixed payment request is split: each piece goes with the bill it takes off", () => {
    const S3 = [
      { id: "jun", label: "June", starts_on: "2026-06-01", ends_on: "2026-06-30" },
      { id: "jul", label: "July", starts_on: "2026-07-01", ends_on: "2026-07-31" },
      { id: "aug", label: "August", starts_on: "2026-08-01", ends_on: "2026-08-31" },
    ];
    const invoices = [
      { id: "dep", invoice_number: "INV-1", status: "paid", invoice_kind: "deposit", tax: 0, total: 10000, amount_paid: 10000, created_at: "2026-06-01T18:00:00Z", sent_at: "2026-06-01T18:00:00Z" },
      { id: "fix", invoice_number: "INV-2", status: "paid", invoice_kind: "progress", tax: 0, total: 5000, amount_paid: 5000, created_at: "2026-07-15T18:00:00Z", sent_at: "2026-07-15T18:00:00Z" },
      { id: "act", invoice_number: "INV-3", status: "sent", invoice_kind: "progress", tax: 0, total: 5000, amount_paid: 0, created_at: "2026-08-15T18:00:00Z", sent_at: "2026-08-15T18:00:00Z" },
    ];
    const lines = [
      { invoice_id: "dep", sort_order: 0, description: "Deposit", quantity: 1, unit: "lot", unit_price: 10000, line_total: 10000, import_source: null },
      { invoice_id: "fix", sort_order: 0, description: "Progress payment 1", quantity: 1, unit: "lot", unit_price: 5000, line_total: 5000, import_source: null },
      { invoice_id: "act", sort_order: 0, description: "Panel and wire", quantity: 1, unit: "ea", unit_price: 20000, line_total: 20000, import_source: "costs", sources: [{ date: "2026-08-10", at: null }] },
      { invoice_id: "act", sort_order: 1, description: "Less previous billings (deposit & prior draws)", quantity: 1, unit: "lot", unit_price: -15000, line_total: -15000, import_source: "draw_credit" },
    ];
    const payments = [
      { invoice_id: "dep", amount: 10000, paid_at: "2026-06-02T18:00:00Z", method: "check" },
      { invoice_id: "fix", amount: 5000, paid_at: "2026-07-16T18:00:00Z", method: "check" },
    ];
    const l = buildJobLedger({ stretches: S3, invoices, lines, payments, tz: TZ });
    // No real work until August: each stretch's balance is the real work so far less what was paid.
    expect(l.stretches.map((s) => [s.label, s.workTotal, s.paidTotal, s.balanceAfter])).toEqual([
      ["June", 0, 10000, -10000],
      ["July", 0, 5000, -15000],
      ["August", 20000, 0, 5000],
    ]);
    const credits = l.stretches.flatMap((s) => s.days.flatMap((d) => d.items.filter((i) => i.group === "credit").map((i) => [d.date, i.amount, i.datedBy])));
    expect(credits).toEqual([
      ["2026-06-01", -10000, "deposit"],
      ["2026-07-15", -5000, "draw"],
    ]);
    expect(l.reconciles).toBe(true);
    expect(l.balance).toBe(5000);
  });

  it("a credit larger than the lump money the customer is shown keeps the rest on its own bill's day", () => {
    const l = buildJobLedger({
      stretches: STR,
      invoices: [deposit("2026-07-01T18:00:00Z"), progress("2026-08-15T18:00:00Z")],
      lines: LINES_MR5.map((x) => (x.import_source === "draw_credit" ? { ...x, unit_price: -12000, line_total: -12000 } : x)),
      payments: PAYS,
      tz: TZ,
    });
    const credits = l.stretches.flatMap((s) => s.days.flatMap((d) => d.items.filter((i) => i.group === "credit").map((i) => [d.date, i.amount, i.datedBy])));
    expect(credits).toEqual([
      ["2026-07-01", -10000, "deposit"],
      ["2026-08-15", -2000, "bill"],
    ]);
  });
});
