import { describe, expect, it } from "vitest";
import { everythingBillable, priceQuotes, type BillableInvoice } from "./everything-billable";

/**
 * The table the scout drew (estimate $10,000), row by row, and the shapes an older figure misread.
 * Every row names what the tile says: billable / billed / left / over.
 */
const q = (o: Partial<{ subtotal: number; tax: number; total: number; status: string; created_at: string; quote_number: string }> = {}) => ({
  quote_number: "Q-900",
  status: "accepted",
  created_at: "2026-01-01T00:00:00Z",
  subtotal: 10000,
  tax: 0,
  total: 10000,
  ...o,
});
const inv = (o: Partial<BillableInvoice> = {}): BillableInvoice => ({
  id: "i1",
  invoice_number: "INV-900",
  status: "sent",
  invoice_kind: "standard",
  subtotal: 10000,
  tax: 0,
  total: 10000,
  discount: 0,
  ...o,
});
const co = (amount: number, status = "approved", id = "c1") => ({ id, co_number: "CO-1", description: "Add two receptacles", amount, status });
const four = (r: ReturnType<typeof everythingBillable>) => (r ? [r.billable, r.billed, r.left, r.over] : null);

describe("everythingBillable", () => {
  it("no estimate at all: nothing to measure against", () => {
    expect(everythingBillable({ quotes: [] })).toBeNull();
    expect(everythingBillable({ quotes: null })).toBeNull();
  });

  it("a plain job: one estimate, one bill", () => {
    expect(four(everythingBillable({ quotes: [q()], invoices: [inv()] }))).toEqual([10000, 10000, 0, 0]);
    expect(everythingBillable({ quotes: [q()], invoices: [inv()] })?.billedInFull).toBe(true);
  });

  it("nothing billed yet: all of it is left", () => {
    const r = everythingBillable({ quotes: [q()], invoices: [] });
    expect(four(r)).toEqual([10000, 0, 10000, 0]);
    expect(r?.billedInFull).toBe(false);
  });

  it("a discount line is a lower price, not money still owed (the job that stayed open for ever)", () => {
    const r = everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 9500, total: 9500, discount: -500 })] });
    expect(four(r)).toEqual([9500, 9500, 0, 0]);
    expect(r?.discounts).toBe(500);
    expect(r?.billedInFull).toBe(true);
  });

  it("a discount stored as a positive number is the same cut", () => {
    expect(four(everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 9500, total: 9500, discount: 500 })] }))).toEqual([9500, 9500, 0, 0]);
  });

  it("an approved add that was billed: no 'over'", () => {
    const r = everythingBillable({ quotes: [q()], changeOrders: [co(1000)], invoices: [inv(), inv({ id: "i2", subtotal: 1000, total: 1000 })] });
    expect(four(r)).toEqual([11000, 11000, 0, 0]);
  });

  it("an approved add that was NEVER billed holds the job open (it used to finish on pay)", () => {
    const r = everythingBillable({ quotes: [q()], changeOrders: [co(1000)], invoices: [inv()] });
    expect(four(r)).toEqual([11000, 10000, 1000, 0]);
    expect(r?.billedInFull).toBe(false);
  });

  it("an approved deduct that was billed: done at the lower price (it used to stay open for ever)", () => {
    expect(four(everythingBillable({ quotes: [q()], changeOrders: [co(-900)], invoices: [inv({ subtotal: 9100, total: 9100 })] }))).toEqual([9100, 9100, 0, 0]);
  });

  it("an approved deduct never taken off the bill is said as 'over', never hidden", () => {
    expect(four(everythingBillable({ quotes: [q()], changeOrders: [co(-900)], invoices: [inv()] }))).toEqual([9100, 10000, 0, 900]);
  });

  it("a change order that is pending, rejected or $0 is not part of the price", () => {
    const r = everythingBillable({ quotes: [q()], changeOrders: [co(1000, "pending"), co(500, "rejected", "c2"), co(0, "approved", "c3")], invoices: [inv()] });
    expect(four(r)).toEqual([10000, 10000, 0, 0]);
    expect(r?.pieces.changeOrders).toEqual([]);
  });

  it("a deposit request paid ahead, before and after the bill that takes it off", () => {
    const request = inv({ id: "p1", invoice_kind: "prepayment", subtotal: 2000, total: 2000 });
    expect(four(everythingBillable({ quotes: [q()], invoices: [request] }))).toEqual([10000, 2000, 8000, 0]);
    // The later bill: $10,000 of lines and a -$2,000 credit line, both inside its subtotal.
    const final = inv({ id: "i2", subtotal: 8000, total: 8000 });
    expect(four(everythingBillable({ quotes: [q()], invoices: [request, final] }))).toEqual([10000, 10000, 0, 0]);
  });

  it("a taxed estimate billed with NO tax is billed in full (it used to hold $800 for ever)", () => {
    const r = everythingBillable({ quotes: [q({ tax: 800, total: 10800 })], invoices: [inv({ subtotal: 10000, tax: 0, total: 10000 })] });
    expect(four(r)).toEqual([10000, 10000, 0, 0]);
    expect(r?.taxed).toBe(true);
  });

  it("a taxed estimate billed with its tax: the tax is beside the figures, never inside", () => {
    const r = everythingBillable({ quotes: [q({ tax: 800, total: 10800 })], invoices: [inv({ subtotal: 10000, tax: 800, total: 10800 })] });
    expect(four(r)).toEqual([10000, 10000, 0, 0]);
    expect(r?.tax).toBe(800);
  });

  it("draws slice the estimate's tax-included total and are turned back into before-tax dollars", () => {
    const quotes = [q({ tax: 800, total: 10800 })];
    const draw = (id: string, kind: string) => inv({ id, invoice_kind: kind, subtotal: 5400, tax: 0, total: 5400 });
    expect(four(everythingBillable({ quotes, invoices: [draw("d1", "progress")] }))).toEqual([10000, 5000, 5000, 0]);
    expect(four(everythingBillable({ quotes, invoices: [draw("d1", "progress"), draw("d2", "final")] }))).toEqual([10000, 10000, 0, 0]);
  });

  it("a draw then a standard bill with tax for the rest", () => {
    const quotes = [q({ tax: 800, total: 10800 })];
    const r = everythingBillable({
      quotes,
      invoices: [inv({ id: "d1", invoice_kind: "progress", subtotal: 5400, tax: 0, total: 5400 }), inv({ id: "i2", subtotal: 5000, tax: 400, total: 5400 })],
    });
    expect(four(r)).toEqual([10000, 10000, 0, 0]);
  });

  it("a discount on a draw is real dollars, never scaled", () => {
    const quotes = [q({ tax: 800, total: 10800 })];
    const r = everythingBillable({
      quotes,
      invoices: [
        inv({ id: "d1", invoice_kind: "progress", subtotal: 5300, tax: 0, total: 5300, discount: -100 }),
        inv({ id: "d2", invoice_kind: "final", subtotal: 5400, tax: 0, total: 5400 }),
      ],
    });
    expect(four(r)).toEqual([9900, 9900, 0, 0]);
  });

  it("two accepted estimates add up; an unaccepted revision beside them does not", () => {
    const r = everythingBillable({
      quotes: [q(), q({ quote_number: "Q-901", subtotal: 4000, total: 4000 }), q({ quote_number: "Q-902", status: "sent", subtotal: 99999, total: 99999 })],
      invoices: [],
    });
    expect(four(r)).toEqual([14000, 0, 14000, 0]);
    expect(r?.accepted).toBe(true);
    expect(r?.pieces.estimates.map((e) => e.number)).toEqual(["Q-900", "Q-901"]);
  });

  it("nothing accepted yet: the newest estimate alone, and it says so", () => {
    const r = everythingBillable({
      quotes: [q({ status: "sent", created_at: "2026-01-01T00:00:00Z" }), q({ quote_number: "Q-901", status: "sent", subtotal: 12000, total: 12000, created_at: "2026-02-01T00:00:00Z" })],
    });
    expect(four(r)).toEqual([12000, 0, 12000, 0]);
    expect(r?.accepted).toBe(false);
  });

  it("several unaccepted estimates with no created_at is a caller's bug, never a silent pick", () => {
    expect(() => priceQuotes([{ status: "sent", total: 1 }, { status: "sent", total: 2 }])).toThrow(/created_at/);
  });

  it("void and draft bills count for nothing", () => {
    const r = everythingBillable({ quotes: [q()], invoices: [inv({ status: "void" }), inv({ id: "i2", status: "draft" })] });
    expect(four(r)).toEqual([10000, 0, 10000, 0]);
    expect(r?.pieces.bills).toEqual([]);
  });

  it("a paid or part-paid bill counts exactly as a sent one", () => {
    expect(four(everythingBillable({ quotes: [q()], invoices: [inv({ status: "paid" })] }))).toEqual([10000, 10000, 0, 0]);
    expect(four(everythingBillable({ quotes: [q()], invoices: [inv({ status: "partial", subtotal: 4000, total: 4000 })] }))).toEqual([10000, 4000, 6000, 0]);
  });

  it("a row with no subtotal stored reads total less tax, for an estimate and for a bill", () => {
    const r = everythingBillable({
      quotes: [{ status: "accepted", created_at: "2026-01-01T00:00:00Z", total: 10800, tax: 800 }],
      invoices: [{ status: "sent", invoice_kind: "standard", total: 10800, tax: 800 }],
    });
    expect(four(r)).toEqual([10000, 10000, 0, 0]);
  });

  it("an extra billed by hand on top is 'over', as it always was", () => {
    expect(four(everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 10400, total: 10400 })] }))).toEqual([10000, 10400, 0, 400]);
  });

  describe("what Part of the Estimate may still take (tax-included dollars)", () => {
    it("nothing billed: the whole estimate", () => {
      expect(everythingBillable({ quotes: [q({ tax: 800, total: 10800 })], invoices: [] })?.partLeftGross).toBe(10800);
    });
    it("the estimate all billed and only a change order left: nothing (that is the change orders' door)", () => {
      expect(everythingBillable({ quotes: [q()], changeOrders: [co(1000)], invoices: [inv()] })?.partLeftGross).toBe(0);
    });
    it("a discounted bill leaves no part to take (the sheet used to offer the discount back)", () => {
      expect(everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 9500, total: 9500, discount: -500 })] })?.partLeftGross).toBe(0);
    });
    it("an approved deduct lowers what a part may take", () => {
      expect(everythingBillable({ quotes: [q()], changeOrders: [co(-900)], invoices: [] })?.partLeftGross).toBe(9100);
    });
    it("a taxed estimate billed with NO tax leaves no part (the door used to offer the tax as work)", () => {
      const r = everythingBillable({ quotes: [q({ tax: 800, total: 10800 })], invoices: [inv({ subtotal: 10000, tax: 0, total: 10000 })] });
      expect(r?.partLeftGross).toBe(0);
    });
    it("an approved ADD never widens a part: that is the change orders' door", () => {
      expect(everythingBillable({ quotes: [q()], changeOrders: [co(1000)], invoices: [inv({ subtotal: 4000, total: 4000 })] })?.partLeftGross).toBe(6000);
    });
    it("draws on a taxed estimate leave the estimate's own remainder, to the cent", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      const r = everythingBillable({ quotes, invoices: [inv({ id: "d1", invoice_kind: "progress", subtotal: 5400, tax: 0, total: 5400 })] });
      expect(r?.partLeftGross).toBe(5400);
    });
  });

  describe("a cent of rounding is not money (draws on a taxed estimate always come out even)", () => {
    const cents = (n: number) => Math.round(n * 100) / 100;
    const cases = [
      { subtotal: 1000, rate: 0.0725 },
      { subtotal: 12345.67, rate: 0.08375 },
      { subtotal: 8640.5, rate: 0.095 },
      { subtotal: 4999.99, rate: 0.0775 },
    ];

    it("after any first draw, a part is a part of the estimate's own remainder, to the cent", () => {
      for (const c of cases) {
        const tax = cents(c.subtotal * c.rate);
        const gross = cents(c.subtotal + tax);
        const quotes = [q({ subtotal: c.subtotal, tax, total: gross })];
        for (let p = 1; p <= 99; p++) {
          const draw = cents((gross * p) / 100);
          const r = everythingBillable({ quotes, invoices: [inv({ id: "d1", invoice_kind: "progress", subtotal: draw, tax: 0, total: draw })] });
          expect([c.subtotal, p, r?.partLeftGross]).toEqual([c.subtotal, p, cents(gross - draw)]);
        }
      }
    });

    it("and once the rest is billed the job is billed in full: nothing left, nothing over", () => {
      for (const c of cases) {
        const tax = cents(c.subtotal * c.rate);
        const gross = cents(c.subtotal + tax);
        const quotes = [q({ subtotal: c.subtotal, tax, total: gross })];
        for (let p = 1; p <= 99; p++) {
          const draw = cents((gross * p) / 100);
          const first = inv({ id: "d1", invoice_kind: "progress", subtotal: draw, tax: 0, total: draw });
          const rest = everythingBillable({ quotes, invoices: [first] })!.partLeftGross;
          const r = everythingBillable({ quotes, invoices: [first, inv({ id: "d2", invoice_kind: "final", subtotal: rest, tax: 0, total: rest })] });
          expect([c.subtotal, p, r?.left, r?.over, r?.billedInFull]).toEqual([c.subtotal, p, 0, 0, true]);
        }
      }
    });

    it("a final draw one cent short of the estimate does not hold a job open", () => {
      // 1,000.00 + 72.50 tax = 1,072.50; draws of 353.93 and 718.56 come to 1,072.49.
      const quotes = [q({ subtotal: 1000, tax: 72.5, total: 1072.5 })];
      const draw = (id: string, kind: string, total: number) => inv({ id, invoice_kind: kind, subtotal: total, tax: 0, total });
      const r = everythingBillable({ quotes, invoices: [draw("d1", "progress", 353.93), draw("d2", "final", 718.56)] });
      expect([r?.left, r?.over, r?.billedInFull]).toEqual([0, 0, true]);
    });

    it("but two cents is money: it is still to bill", () => {
      const r = everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 9999.98, total: 9999.98 })] });
      expect([r?.left, r?.billedInFull]).toEqual([0.02, false]);
    });
  });

  describe("money asked ahead is not work (a part is a part of the WORK left; the request comes off its bill)", () => {
    const request = inv({ id: "p1", invoice_kind: "prepayment", subtotal: 2000, total: 2000 });

    it("a request alone: still to bill is less by it, a part is still a part of the whole work", () => {
      const r = everythingBillable({ quotes: [q()], invoices: [request] });
      expect(four(r)).toEqual([10000, 2000, 8000, 0]);
      expect(r?.partLeftGross).toBe(10000);
      expect(r?.requestsToComeOff).toBe(2000);
    });

    it("a part that took the request off counts at its work, and the request is spent", () => {
      // 50% of the work: a 5,000 line, the request's -2,000 credit line, total 3,000.
      const part = inv({ id: "d1", invoice_kind: "progress", subtotal: 3000, total: 3000, prepaidCredit: -2000 });
      const r = everythingBillable({ quotes: [q()], invoices: [request, part] });
      expect(four(r)).toEqual([10000, 5000, 5000, 0]);
      expect(r?.partLeftGross).toBe(5000);
      expect(r?.requestsToComeOff).toBe(0);
    });

    it("a credit stored as a positive number is the same money taken off", () => {
      const part = inv({ id: "d1", invoice_kind: "progress", subtotal: 3000, total: 3000, prepaidCredit: 2000 });
      expect(everythingBillable({ quotes: [q()], invoices: [request, part] })?.partLeftGross).toBe(5000);
    });

    it("a request only partly taken off still has the rest to come off", () => {
      const small = inv({ id: "i2", subtotal: 0, total: 0, prepaidCredit: -500 });
      const r = everythingBillable({ quotes: [q()], invoices: [request, small] });
      expect(r?.requestsToComeOff).toBe(1500);
      expect(r?.partLeftGross).toBe(9500);
    });

    it("on a TAXED estimate a final draw that takes a request off is billed in full (the credit is real dollars, never scaled)", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      // 100% of the work: a 10,800 line, the -2,000 credit, total 8,800. The customer pays 2,000 + 8,800 = 10,800.
      const final = inv({ id: "d1", invoice_kind: "final", subtotal: 8800, tax: 0, total: 8800, prepaidCredit: -2000 });
      const r = everythingBillable({ quotes, invoices: [request, final] });
      expect(four(r)).toEqual([10000, 10000, 0, 0]);
      expect(r?.partLeftGross).toBe(0);
      expect(r?.billedInFull).toBe(true);
    });

    it("a draw is read right with or without its credit line (the credit left the tax-included slice)", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      const final = inv({ id: "d1", invoice_kind: "final", subtotal: 8800, tax: 0, total: 8800 });
      expect(four(everythingBillable({ quotes, invoices: [request, final] }))).toEqual([10000, 10000, 0, 0]);
    });

    it("on a TAXED estimate a request counts at its before-tax share, as a draw does", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      const r = everythingBillable({ quotes, invoices: [request] });
      expect(four(r)).toEqual([10000, 1851.85, 8148.15, 0]);
      expect(r?.pieces.bills).toEqual([{ id: "p1", number: "INV-900", total: 2000, counts: 1851.85 }]);
      expect(r?.requestsToComeOff).toBe(2000);
    });

    it("a request for the WHOLE taxed price is all billed and never 'more than agreed' (it read as over by the tax)", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      const whole = inv({ id: "p1", invoice_kind: "prepayment", subtotal: 10800, total: 10800 });
      const r = everythingBillable({ quotes, invoices: [whole] });
      expect(four(r)).toEqual([10000, 10000, 0, 0]);
      // No bill carries the work yet: a part is still a part of all of it, and the request comes off it.
      expect(r?.partLeftGross).toBe(10800);
      expect(r?.requestsToComeOff).toBe(10800);
    });

    it("a standard taxed bill read WITHOUT its credit line reads as LESS billed, never more (the safe side: the job stays open)", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      const final = inv({ id: "i2", subtotal: 8000, tax: 800, total: 8800 });
      expect(four(everythingBillable({ quotes, invoices: [request, final] }))).toEqual([10000, 9851.85, 148.15, 0]);
    });

    it("a standard bill with tax that takes the request off: its subtotal already has the credit inside", () => {
      const quotes = [q({ tax: 800, total: 10800 })];
      const final = inv({ id: "i2", subtotal: 8000, tax: 800, total: 8800, prepaidCredit: -2000 });
      const r = everythingBillable({ quotes, invoices: [request, final] });
      expect(four(r)).toEqual([10000, 10000, 0, 0]);
      expect(r?.partLeftGross).toBe(0);
    });

    it("a void request asks for nothing", () => {
      const r = everythingBillable({ quotes: [q()], invoices: [{ ...request, status: "void" }] });
      expect(r?.requestsToComeOff).toBe(0);
      expect(four(r)).toEqual([10000, 0, 10000, 0]);
    });
  });
});
