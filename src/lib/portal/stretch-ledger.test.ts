import { describe, it, expect } from "vitest";
import { buildJobLedger, orgDay, spreadHours, splitByWeight, type LedgerInput } from "./stretch-ledger";
import { INV_078, LINES, PAYMENTS, STRETCHES } from "./j011-fixture";

const TZ = "America/Los_Angeles";
const j011 = (over: Partial<LedgerInput> = {}) =>
  buildJobLedger({ stretches: STRETCHES, invoices: [INV_078], lines: LINES, payments: PAYMENTS, tz: TZ, ...over });

describe("J-011 / INV-078: the stretches reconcile to the invoice to the cent", () => {
  const ledger = j011();
  const s = ledger.stretches;

  it("each stretch's work, payments and running balance are Erik's figures", () => {
    expect(s.map((x) => [x.label, x.workTotal, x.paidTotal, x.balanceAfter])).toEqual([
      ["Rough-in Start", 2259.12, 1850, 409.12],
      ["Rough-in", 4144.52, 4050, 503.64],
      ["Trim", 1795.39, 860, 1439.03],
      ["Fixtures", 119.59, 0, 1558.62],
    ]);
  });

  it("the last balance is the invoice's balance, and the work is the invoice's total", () => {
    expect(ledger.workTotal).toBe(8318.62);
    expect(ledger.paidTotal).toBe(6760);
    expect(ledger.balance).toBe(1558.62);
    expect(ledger.billedTotal).toBe(8318.62);
    expect(ledger.billedBalance).toBe(1558.62);
    expect(ledger.reconciles).toBe(true);
  });

  it("the days add up to the stretch, and every labor day prices at the line's rate exactly", () => {
    for (const st of s) {
      const cents = st.days.reduce((a, d) => a + Math.round(d.total * 100), 0);
      expect(cents).toBe(Math.round(st.workTotal * 100));
      for (const d of st.days) {
        for (const l of d.labor) expect(Math.round(l.hours * l.rate * 100)).toBe(Math.round(l.amount * 100));
      }
    }
    const hoursByPerson = new Map<string, number>();
    for (const st of s) for (const d of st.days) for (const l of d.labor) hoursByPerson.set(l.person, Math.round(((hoursByPerson.get(l.person) ?? 0) + l.hours) * 100) / 100);
    // The billed lines: Erik 50.50 h, Brian 10 h, Jimmy 11 h.
    expect(Object.fromEntries(hoursByPerson)).toEqual({ Erik: 50.5, Brian: 10, Jimmy: 11 });
  });

  it("the 3.509 h entry on Aug 5 bills as 3.50 h, and every other entry keeps its clock time", () => {
    const aug5 = s[0].days.find((d) => d.date === "2026-08-05");
    expect(aug5?.labor).toEqual([{ person: "Erik", hours: 3.5, rate: 100, amount: 350, invoiceNumber: "INV-078", lump: false }]);
    const jul14 = s[0].days.find((d) => d.date === "2026-07-14");
    expect(jul14?.labor.map((l) => [l.person, l.hours, l.amount])).toEqual([["Erik", 1, 100]]);
  });

  it("pricing each entry at its own clock time would not reconcile (the critique's ~$8,319.5x)", () => {
    let naive = 0;
    for (const ln of LINES) {
      if (ln.import_source !== "labor") {
        naive += Math.round(Number(ln.line_total) * 100);
        continue;
      }
      for (const e of ln.entries ?? []) {
        const h = (Date.parse(e.clock_out!) - Date.parse(e.clock_in) - (e.lunch_minutes ?? 0) * 60_000) / 3_600_000;
        naive += Math.round(h * Number(ln.unit_price) * 100);
      }
    }
    // Aug 5's 3.509 h at its own clock time bills 91 cents the invoice never charged.
    expect(naive - 831862).toBe(91);
  });

  it("Sep 18's 5 PM shift is Sep 18 in the org's day, not Sep 19 (UTC)", () => {
    expect(orgDay("2026-09-19T00:00:00+00:00", TZ)).toBe("2026-09-18");
    const trim = s[2];
    expect(trim.days.map((d) => d.date)).toEqual(["2026-09-18", "2026-09-22"]);
    expect(trim.days[0].labor).toEqual([{ person: "Erik", hours: 1, rate: 100, amount: 100, invoiceNumber: "INV-078", lump: false }]);
    expect(trim.days.every((d) => d.inRange)).toBe(true);
  });

  it("a bill's own date is never shifted by the timezone", () => {
    expect(orgDay("2026-07-31", TZ)).toBe("2026-07-31");
    const jul31 = s[0].days.find((d) => d.date === "2026-07-31");
    expect(jul31?.items.reduce((a, i) => a + Math.round(i.amount * 100), 0)).toBe(40912);
    expect(jul31?.items.every((i) => i.kind === "material" && i.datedBy === "purchase")).toBe(true);
  });

  it("payments sit in the stretch they were paid at the end of", () => {
    expect(s.map((x) => x.payments.map((p) => [p.date, p.amount, p.method]))).toEqual([
      [["2026-08-10", 1850, "cash"]],
      [
        ["2026-08-29", 300, "cash"],
        ["2026-08-31", 2550, "venmo"],
        ["2026-08-31", 1200, "cash"],
      ],
      [
        ["2026-09-23", 500, "cash"],
        ["2026-09-23", 360, "cash"],
      ],
      [],
    ]);
  });

  it("with no stretches named, the whole job is one stretch that still reconciles", () => {
    const one = j011({ stretches: [] });
    expect(one.stretches).toHaveLength(1);
    expect(one.stretches[0]).toMatchObject({ id: null, label: "All Work", startsOn: "2026-07-14", endsOn: "2026-09-24", workTotal: 8318.62, balanceAfter: 1558.62 });
  });
});

describe("the running balance, not the ledger balance", () => {
  const inv = { id: "a", invoice_number: "INV-1", status: "sent", tax: 0, total: 100, amount_paid: 150, created_at: "2026-01-02T18:00:00Z", sent_at: "2026-01-02T18:00:00Z" };
  it("a customer who paid ahead is shown ahead: no floor at zero", () => {
    const l = buildJobLedger({
      stretches: [
        { id: "x", label: "One", starts_on: "2026-01-01", ends_on: "2026-01-05" },
        { id: "y", label: "Two", starts_on: "2026-01-10", ends_on: "2026-01-12" },
      ],
      invoices: [{ ...inv, total: 200 }],
      lines: [
        { invoice_id: "a", sort_order: 0, description: "Panel", quantity: 1, unit: "ea", unit_price: 100, line_total: 100, import_source: "costs", sources: [{ date: "2026-01-02", at: null }] },
        { invoice_id: "a", sort_order: 1, description: "Trim", quantity: 1, unit: "ea", unit_price: 100, line_total: 100, import_source: "costs", sources: [{ date: "2026-01-11", at: null }] },
      ],
      payments: [{ invoice_id: "a", amount: 150, paid_at: "2026-01-04T20:00:00Z", method: "check" }],
      tz: TZ,
    });
    expect(l.stretches.map((s) => s.balanceAfter)).toEqual([-50, 50]);
    expect(l.reconciles).toBe(true);
  });
});

describe("rows that have no day of their own, and rows between stretches", () => {
  const base = { id: "a", invoice_number: "INV-9", status: "sent", created_at: "2026-03-01T17:00:00Z", sent_at: "2026-03-20T17:00:00Z" };
  const stretches = [
    { id: "x", label: "Rough", starts_on: "2026-03-01", ends_on: "2026-03-05" },
    { id: "y", label: "Finish", starts_on: "2026-03-15", ends_on: "2026-03-25" },
  ];

  it("a typed charge and the tax carry the bill's sent day; a credit the paid figure holds is shown as one", () => {
    const l = buildJobLedger({
      stretches,
      invoices: [{ ...base, tax: 8, total: 118, amount_paid: 60 }],
      lines: [{ invoice_id: "a", sort_order: 0, description: "Permit fee", quantity: 1, unit: null, unit_price: 110, line_total: 110, import_source: null }],
      payments: [{ invoice_id: "a", amount: 50, paid_at: "2026-03-21T20:00:00Z", method: "check" }],
      tz: TZ,
    });
    const fin = l.stretches[1];
    expect(fin.days).toHaveLength(1);
    expect(fin.days[0].date).toBe("2026-03-20");
    expect(fin.days[0].items.map((i) => [i.description, i.kind, i.amount, i.datedBy])).toEqual([
      ["Permit fee", "charge", 110, "bill"],
      ["Sales Tax", "tax", 8, "bill"],
    ]);
    expect(fin.payments.map((p) => [p.kind, p.amount])).toEqual([
      ["credit", 10],
      ["payment", 50],
    ]);
    expect(l.balance).toBe(58);
    expect(l.reconciles).toBe(true);
  });

  it("a payment and work in the gap between stretches join the one before, and the work is flagged", () => {
    const l = buildJobLedger({
      stretches,
      invoices: [{ ...base, tax: 0, total: 40, amount_paid: 40 }],
      lines: [{ invoice_id: "a", sort_order: 0, description: "Wire", quantity: 1, unit: "ea", unit_price: 40, line_total: 40, import_source: "costs", sources: [{ date: "2026-03-09", at: null }] }],
      payments: [{ invoice_id: "a", amount: 40, paid_at: "2026-03-10T20:00:00Z", method: "cash" }],
      tz: TZ,
    });
    expect(l.stretches[0].days.map((d) => [d.date, d.inRange])).toEqual([["2026-03-09", false]]);
    expect(l.stretches[0].payments.map((p) => [p.date, p.inRange])).toEqual([["2026-03-10", false]]);
    expect(l.stretches[1].workTotal).toBe(0);
  });

  it("a deposit before the first stretch joins the first", () => {
    const l = buildJobLedger({
      stretches,
      invoices: [{ ...base, tax: 0, total: 500, amount_paid: 500 }],
      lines: [],
      payments: [{ invoice_id: "a", amount: 500, paid_at: "2026-02-20T20:00:00Z", method: "check" }],
      tz: TZ,
    });
    expect(l.stretches[0].payments[0]).toMatchObject({ date: "2026-02-20", inRange: false, amount: 500 });
  });
});

describe("a labor line whose hours are not its entries' hours is shown as a lump", () => {
  it("26 h billed off 30 h of entries: one row, on the last entry's day, for the line's own dollars", () => {
    const entry = (d: string) => ({ person: "Erik", clock_in: `${d}T15:00:00Z`, clock_out: `${d}T22:30:00Z`, lunch_minutes: 30 });
    const l = buildJobLedger({
      stretches: [],
      invoices: [{ id: "a", invoice_number: "INV-048", status: "paid", tax: 0, total: 2600, amount_paid: 2600, created_at: "2026-07-20T18:00:00Z", sent_at: "2026-07-20T18:00:00Z" }],
      lines: [{ invoice_id: "a", sort_order: 0, description: "Labor - Erik", quantity: 26, unit: "hr", unit_price: 100, line_total: 2600, import_source: "labor", entries: ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14"].map(entry) }],
      payments: [],
      tz: TZ,
    });
    const days = l.stretches[0].days;
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-07-14");
    expect(days[0].labor).toEqual([{ person: "Erik", hours: 26, rate: 100, amount: 2600, invoiceNumber: "INV-048", lump: true }]);
    expect(l.reconciles).toBe(true);
  });

  it("the quarter-hour rounding the importer does is spread, not lumped", () => {
    // 5.07 h + 5.06 h worked = 10.13 h, billed 10.25 h at $47.33.
    const l = buildJobLedger({
      stretches: [],
      invoices: [{ id: "a", invoice_number: "INV-1", status: "sent", tax: 0, total: 485.13, amount_paid: 0, created_at: "2026-05-02T18:00:00Z", sent_at: null }],
      lines: [
        {
          invoice_id: "a",
          sort_order: 0,
          description: "Labor - Brian",
          quantity: 10.25,
          unit: "hr",
          unit_price: 47.33,
          line_total: 485.13,
          import_source: "labor",
          entries: [
            { person: "Brian", clock_in: "2026-05-01T15:00:00Z", clock_out: "2026-05-01T20:04:12Z", lunch_minutes: 0 },
            { person: "Brian", clock_in: "2026-05-02T15:00:00Z", clock_out: "2026-05-02T20:03:36Z", lunch_minutes: 0 },
          ],
        },
      ],
      payments: [],
      tz: TZ,
    });
    const labor = l.stretches[0].days.flatMap((d) => d.labor);
    expect(labor.every((x) => !x.lump)).toBe(true);
    expect(Math.round(labor.reduce((a, x) => a + x.hours, 0) * 100)).toBe(1025);
    expect(Math.round(labor.reduce((a, x) => a + x.amount, 0) * 100)).toBe(48513);
    expect(l.reconciles).toBe(true);
  });

  it("a running shift on a line bills nothing to its own day", () => {
    const l = buildJobLedger({
      stretches: [],
      invoices: [{ id: "a", invoice_number: "INV-2", status: "draft", tax: 0, total: 100, amount_paid: 0, created_at: "2026-05-02T18:00:00Z" }],
      lines: [
        {
          invoice_id: "a",
          sort_order: 0,
          description: "Labor - Jimmy",
          quantity: 1,
          unit: "hr",
          unit_price: 100,
          line_total: 100,
          import_source: "labor",
          entries: [
            { person: "Jimmy", clock_in: "2026-05-01T15:00:00Z", clock_out: "2026-05-01T16:00:00Z", lunch_minutes: 0 },
            { person: "Jimmy", clock_in: "2026-05-02T15:00:00Z", clock_out: null, lunch_minutes: 0 },
          ],
        },
      ],
      payments: [],
      tz: TZ,
    });
    expect(l.stretches[0].days.map((d) => [d.date, d.total])).toEqual([["2026-05-01", 100]]);
  });
});

describe("the two spreading rules", () => {
  it("spreadHours keeps each entry's own hundredths and puts the rounding where the floor cut most", () => {
    const h = (x: number) => Math.round(x * 3_600_000);
    expect(spreadHours([h(1), h(3.50914), h(5)], 950)).toEqual([100, 350, 500]);
    expect(spreadHours([h(1.004), h(1.009)], 202)).toEqual([101, 101]);
    expect(spreadHours([h(1.004), h(1.009)], 200)).toEqual([100, 100]);
    expect(spreadHours([h(1.004), h(1.009)], 199)).toEqual([99, 100]);
  });

  it("splitByWeight sums exactly, whatever the weights", () => {
    expect(splitByWeight(48513, [507, 518])).toEqual([23996, 24517]);
    expect(splitByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitByWeight(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(splitByWeight(5, [0, 0])).toEqual([5, 0]);
  });
});
