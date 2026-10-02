import { describe, it, expect } from "vitest";
import { billedWorkOnInvoices, computeJobProgress, livePurchaseOrders } from "./job-progress-math";
import { countsAsWorkCompleted } from "./portal/line-kind";

const base = {
  billingTypeRaw: "tm",
  quotes: [{ total: 17325 }],
  invoices: [
    { total: 10000, status: "sent", amount_paid: 10000 },
    { total: 5000, status: "draft", amount_paid: 0 },
    { total: 2000, status: "void", amount_paid: 2000 },
  ],
  billableLabor: 6037.5,
  pos: [{ total: 5000 }],
  bills: [{ amount: 290.37 }],
  markupPercent: 0,
};

describe("computeJobProgress", () => {
  it("reconciles to the billed lines (Tess: labor + materials, markup 0)", () => {
    const r = computeJobProgress(base);
    expect(r.estimate).toBe(17325);
    expect(r.workToDate).toBeCloseTo(11327.87, 2); // 6037.50 labor + 5290.37 materials
    expect(r.billingType).toBe("tm");
  });

  it("invoiced excludes void AND draft; collected excludes only void", () => {
    const r = computeJobProgress(base);
    expect(r.invoiced).toBe(10000); // only the 'sent' one (draft + void excluded)
    expect(r.collected).toBe(10000); // sent's 10000; void's 2000 excluded; draft's 0
  });

  it("marks materials up PER ROW", () => {
    const r = computeJobProgress({ ...base, markupPercent: 10 });
    // 5000*1.1 = 5500.00 ; 290.37*1.1 = 319.41 (rounded per row) ; +6037.50 labor
    expect(r.workToDate).toBeCloseTo(11856.91, 2);
  });

  it("skips non-positive material rows (no negative/zero costs billed)", () => {
    const r = computeJobProgress({
      ...base,
      markupPercent: 0,
      pos: [{ total: 5000 }, { total: 0 }, { total: -100 }],
      bills: [],
    });
    expect(r.workToDate).toBeCloseTo(11037.5, 2); // 6037.50 + 5000 only
  });

  it("billingType is 'fixed' unless raw is exactly 'tm'", () => {
    expect(computeJobProgress({ ...base, billingTypeRaw: "fixed" }).billingType).toBe("fixed");
    expect(computeJobProgress({ ...base, billingTypeRaw: null }).billingType).toBe("fixed");
    expect(computeJobProgress({ ...base, billingTypeRaw: "tm" }).billingType).toBe("tm");
  });

  // ── THE double-charge (migration 0142) ─────────────────────────────────────
  // A PO is what we EXPECT the delivery to cost; the supplier's bill is what it DID.
  // Summing both charged the customer twice for one pallet of wire.
  it("a bill SUPERSEDES the PO it pays — one delivery, one material charge", () => {
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [{ id: "po-12", total: 2400, status: "received" }],
      bills: [{ amount: 2400, po_id: "po-12" }],
    });
    expect(r.workToDate).toBeCloseTo(2400, 2); // NOT 4800
  });

  it("bills at the amount the supplier actually invoiced, not the PO estimate", () => {
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [{ id: "po-12", total: 2400, status: "received" }],
      bills: [{ amount: 2712.55, po_id: "po-12" }], // price went up between order and delivery
    });
    expect(r.workToDate).toBeCloseTo(2712.55, 2);
  });

  it("an UNLINKED bill still adds (nothing can infer the link)", () => {
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [{ id: "po-12", total: 2400, status: "received" }],
      bills: [{ amount: 2400, po_id: null }],
    });
    expect(r.workToDate).toBeCloseTo(4800, 2);
  });

  it("only the PO that was actually billed is superseded", () => {
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [
        { id: "po-12", total: 2400, status: "received" },
        { id: "po-13", total: 900, status: "sent" }, // ordered, not yet invoiced
      ],
      bills: [{ amount: 2400, po_id: "po-12" }],
    });
    expect(r.workToDate).toBeCloseTo(3300, 2); // 2400 bill + 900 open PO
  });

  it("a DRAFT PO still counts as cost; only a CANCELLED one is dropped", () => {
    // Draft is the DEFAULT PO status — excluding it silently under-billed the customer
    // for committed material (audit re-review 2026-07-20). Only a killed order is a non-cost.
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [
        { id: "po-1", total: 500, status: "draft" }, // committed, just not advanced — COUNTS
        { id: "po-2", total: 700, status: "cancelled" }, // killed order — dropped
        { id: "po-3", total: 300, status: "received" },
      ],
      bills: [],
    });
    expect(r.workToDate).toBeCloseTo(800, 2); // 500 draft + 300 received
  });

  it("a PARTIAL bill leaves the PO's un-billed remainder on the job", () => {
    // $5k PO, $2k partial bill linked → 3k remainder on the PO + 2k bill = 5k committed
    // (not 2k, which the wholesale-supersede fix would have under-billed).
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [{ id: "po-1", total: 5000, status: "received" }],
      bills: [{ amount: 2000, po_id: "po-1" }],
    });
    expect(r.workToDate).toBeCloseTo(5000, 2);
  });

  it("a bill that fully covers its PO supersedes it (no double-count)", () => {
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 0,
      pos: [{ id: "po-1", total: 5000, status: "received" }],
      bills: [{ amount: 5000, po_id: "po-1" }],
    });
    expect(r.workToDate).toBeCloseTo(5000, 2); // bill only, PO drops to 0
  });

  it("markup applies to the superseding bill, not the dropped PO", () => {
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      markupPercent: 25,
      pos: [{ id: "po-12", total: 2400, status: "received" }],
      bills: [{ amount: 2400, po_id: "po-12" }],
    });
    expect(r.workToDate).toBeCloseTo(3000, 2); // 2400 * 1.25 once — not 6000
  });

  it("coerces non-finite money to 0", () => {
    const r = computeJobProgress({
      ...base,
      quotes: [{ total: NaN as any }],
      invoices: [],
      pos: [],
      bills: [],
      billableLabor: Infinity as any,
    });
    expect(r.estimate).toBe(0);
    expect(r.workToDate).toBe(0);
    expect(r.invoiced).toBe(0);
  });
});

describe("computeJobProgress — work to date is what the customer will be billed (0268/0272)", () => {
  /** His OSH run for Jason Wexley, from the live row (bills 905c9f3d on J-046). */
  const osh = {
    amount: 16.28,
    po_id: null,
    bill_line_items: [
      { id: "o1", quantity: 1, unit_price: 2.09, amount: 2.09, category: "Other", billable: false },
      { id: "o2", quantity: 1, unit_price: 2.09, amount: 2.09, category: "Other", billable: false },
      { id: "o3", quantity: 1, unit_price: 4.99, amount: 4.99, category: "Other", billable: false },
      { id: "o4", quantity: 10, unit_price: 0.61, amount: 6.1, category: "Fasteners", billable: true },
      { id: "o5", quantity: 1, unit_price: 1.01, amount: 1.01, category: "Tax", billable: true },
    ],
  };

  it("leaves the snacks out of the reference figure a draw is measured against", () => {
    const r = computeJobProgress({ ...base, billableLabor: 0, pos: [], bills: [osh], markupPercent: 25 });
    expect(r.workToDate).toBe(8.13); // NOT 20.35 — the same $8.13 importCostsIntoInvoice writes
  });

  it("counts a receipt whose lines were never read exactly as it always did", () => {
    const r = computeJobProgress({ ...base, billableLabor: 0, pos: [], bills: [{ amount: 16.28 }], markupPercent: 25 });
    expect(r.workToDate).toBe(20.35);
  });

  it("a receipt that was entirely the company's own adds nothing", () => {
    const allOff = { ...osh, bill_line_items: osh.bill_line_items.map((l) => (l.category === "Tax" ? l : { ...l, billable: false })) };
    const r = computeJobProgress({ ...base, billableLabor: 0, pos: [], bills: [allOff], markupPercent: 25 });
    expect(r.workToDate).toBe(0);
  });

  it("still supersedes its PO at the SUPPLIER'S charge, never at the customer's price", () => {
    // Netting only the billable part would leave $9.78 of snacks on the job as a PO remainder.
    const r = computeJobProgress({
      ...base,
      billableLabor: 0,
      pos: [{ id: "po-osh", total: 16.28, status: "sent" }],
      bills: [{ ...osh, po_id: "po-osh" }],
      markupPercent: 25,
    });
    expect(r.workToDate).toBe(8.13);
  });

  it("a supplier return comes off, marked up like the parts it reverses (INV-078)", () => {
    const ret = (billable: boolean) => ({
      amount: -51.58,
      po_id: null,
      bill_line_items: [
        { id: "r1", quantity: -4, unit_price: -11.83, amount: -47.32, category: "Electrical", billable },
        { id: "r2", quantity: 1, unit_price: -4.26, amount: -4.26, category: "Tax", billable },
      ],
    });
    const on = computeJobProgress({ ...base, billableLabor: 100, pos: [], bills: [ret(true)], markupPercent: 15 });
    expect(on.workToDate).toBe(40.68); // 100 − 59.32, the credit the importer writes
    // Switched off (the purchase was taken off by hand instead): nothing comes off twice.
    const off = computeJobProgress({ ...base, billableLabor: 100, pos: [], bills: [ret(false)], markupPercent: 15 });
    expect(off.workToDate).toBe(100);
  });
});

describe("livePurchaseOrders", () => {
  it("treats a status-less PO as live (partial selects + old fixtures must not lose costs)", () => {
    expect(livePurchaseOrders([{ total: 100 }], [])).toHaveLength(1);
  });

  it("is case-insensitive about the dead statuses", () => {
    expect(livePurchaseOrders([{ id: "a", total: 100, status: "CANCELLED" }], [])).toHaveLength(0);
  });

  it("ignores a bill whose po_id names a PO that isn't in this list", () => {
    const pos = [{ id: "po-1", total: 100, status: "received" }];
    expect(livePurchaseOrders(pos, [{ amount: 50, po_id: "po-999" }])).toHaveLength(1);
  });

  it("drops a PO once ANY of several bills claims it (partial deliveries)", () => {
    const pos = [{ id: "po-1", total: 1000, status: "partial" }];
    const bills = [
      { amount: 400, po_id: "po-1" },
      { amount: 600, po_id: "po-1" },
    ];
    expect(livePurchaseOrders(pos, bills)).toHaveLength(0);
  });

  it("tolerates null/undefined inputs", () => {
    expect(livePurchaseOrders(null, null)).toEqual([]);
    expect(livePurchaseOrders(undefined, undefined)).toEqual([]);
  });
});

describe("billedWorkOnInvoices — T&M work to date is what was billed, at the price billed (Tess Zane, J-002)", () => {
  // J-002 as it stands: the $10,000 deposit, INV-00028 itemizing June at $150 / $75 and netting the
  // deposit, INV-080 billing September at today's rates.
  const deposit = { status: "paid", invoice_kind: "deposit", invoice_items: [{ import_source: null, unit: "lot", description: "Deposit — Tess Zane hot tub feed", line_total: "10000.00" }] };
  const inv28 = {
    status: "paid",
    invoice_kind: "progress",
    invoice_items: [
      { import_source: "draw_credit", unit: "lot", description: "Less previous billings (deposit & prior draws)", line_total: "-10000.00" },
      { import_source: "labor", unit: "hr", description: "Labor — Brian Taylor", line_total: "3712.50" },
      { import_source: "labor", unit: "hr", description: "Labor — Erik Taylor", line_total: "7575.00" },
      { import_source: "costs", unit: "lot", description: "Materials — The Home Depot", line_total: "5239.80" },
    ],
  };
  const inv80 = {
    status: "sent",
    invoice_kind: "final",
    invoice_items: [
      { import_source: "labor", unit: "hr", description: "Labor - Erik Taylor", line_total: 1950 },
      { import_source: "labor", unit: "hr", description: "Labor - Brian Taylor", line_total: 1105 },
      { import_source: "costs", unit: "ea", description: "Box 1-Gang", line_total: 134.34 },
    ],
  };

  it("J-002: 16,527.30 + 3,189.34 = 19,716.64 - never the deposit, never the credit that nets it", () => {
    expect(billedWorkOnInvoices([deposit, inv28, inv80])).toBe(19716.64);
  });

  it("a void bill is nothing; a DRAFT's lines are the running bill and count at their own prices (INV-078)", () => {
    expect(billedWorkOnInvoices([{ ...inv80, status: "void" }])).toBe(0);
    expect(billedWorkOnInvoices([{ ...inv80, status: "draft" }])).toBe(3189.34);
  });

  it("a lump draw's own amount and a milestone line are money asked for against work, not work", () => {
    const pctDraw = { status: "sent", invoice_kind: "progress", invoice_items: [{ import_source: null, unit: "lot", description: "Progress payment — 50% of estimate", line_total: 8662.5 }] };
    const milestone = { status: "sent", invoice_kind: "progress", invoice_items: [{ import_source: "milestone", description: "Rough-in complete", line_total: 4000 }] };
    expect(billedWorkOnInvoices([pctDraw, milestone])).toBe(0);
  });

  it("hand lines, change orders, estimate lines and a returned part are what was billed; a typed credit is not", () => {
    const std = {
      status: "paid",
      invoice_kind: "standard",
      invoice_items: [
        { import_source: null, unit: "ea", description: "Emergency service call", line_total: 250 },
        { import_source: "change_orders", description: "CO-1 add a circuit", line_total: 400 },
        { import_source: "quote", description: "Panel swap", line_total: 1200 },
        { import_source: "costs", description: "Return — LED housings", line_total: -51.58 },
        { import_source: null, description: "Less previous billings", line_total: -500 },
        { import_source: null, line_kind: "credit", description: "Goodwill", line_total: -100 },
      ],
    };
    expect(billedWorkOnInvoices([std])).toBe(1798.42);
  });

  it("a hand line typed in hours is labor, so it is work, on a draw that itemizes too", () => {
    const draw = {
      status: "sent",
      invoice_kind: "progress",
      invoice_items: [
        { import_source: "labor", unit: "hr", description: "Labor - Erik Taylor", line_total: 500 },
        { import_source: null, unit: "hr", description: "Lift rental", line_total: 120 },
      ],
    };
    expect(billedWorkOnInvoices([draw])).toBe(620);
  });

  // Erik, 2026-09-26: "i don't think fees, referrals and discounts would necessarily be considered
  // work completed". Decided by the line's KIND, never by its words.
  describe("fees, referrals and discounts the office files as Other are not work completed", () => {
    const labor = { import_source: "labor", unit: "hr", description: "Labor - Erik Taylor", line_total: 1000 };
    const mat = { import_source: "costs", unit: "ea", description: "Materials - supplier", line_total: 300 };

    it("J-028: INV-061's $400 referral line, filed as Other, drops out; the labor and materials stay", () => {
      const inv61 = {
        status: "paid",
        invoice_kind: "standard",
        invoice_items: [labor, mat, { import_source: null, unit: "ea", line_kind: "other", description: "Referral - Rob Walters", line_total: 400 }],
      };
      expect(billedWorkOnInvoices([inv61])).toBe(1300);
    });

    it("J-046: a $160 voluntary card-fee line, filed as Other, drops out", () => {
      const inv77 = {
        status: "paid",
        invoice_kind: "standard",
        invoice_items: [{ import_source: null, unit: "ea", line_kind: "other", description: "Voluntary payment from Jason toward the card fees on INV-069", line_total: 160 }],
      };
      expect(billedWorkOnInvoices([inv77])).toBe(0);
    });

    it("a hand discount filed as Other neither adds nor takes away work", () => {
      const inv = { status: "sent", invoice_kind: "standard", invoice_items: [labor, { import_source: null, unit: "ea", line_kind: "other", description: "Discount", line_total: -150 }] };
      expect(billedWorkOnInvoices([inv])).toBe(1000);
    });

    it("a line the office filed as Other is not work, whatever imported it", () => {
      const inv = { status: "sent", invoice_kind: "standard", invoice_items: [{ ...labor, line_kind: "other" }, { ...mat, line_kind: "other" }] };
      expect(billedWorkOnInvoices([inv])).toBe(0);
    });

    it("the KIND decides, never the words: a line the office filed as Labor or Materials counts whatever it says", () => {
      const inv = {
        status: "sent",
        invoice_kind: "standard",
        invoice_items: [
          { import_source: null, unit: "ea", line_kind: "labor", description: "Service call", line_total: 150 },
          { import_source: null, unit: "ea", line_kind: "materials", description: "10/3 romex", line_total: 175.5 },
          // The same words filed as Other are out, and "fee" words filed as Labor are in.
          { import_source: null, unit: "ea", line_kind: "other", description: "Service call", line_total: 150 },
          { import_source: null, unit: "ea", line_kind: "other", description: "10/3 romex", line_total: 175.5 },
          { import_source: null, unit: "ea", line_kind: "labor", description: "Card processing fee", line_total: 25 },
        ],
      };
      expect(billedWorkOnInvoices([inv])).toBe(350.5);
    });

    it("a hand line nobody filed is work, as it always was: J-043's service call, J-018's romex, a book of installed work", () => {
      const inv = {
        status: "sent",
        invoice_kind: "standard",
        invoice_items: [
          { import_source: null, unit: "ea", description: "Service call: a customer", line_total: 150 },
          { import_source: null, unit: "ea", description: "10/3 romex", line_total: 175.5 },
          { import_source: null, unit: "ft", description: "12/2 Romex", line_total: 28.35 },
          // Added from a price book of installed work (no supplier, not in hours): no stored kind.
          { import_source: null, unit: "sq ft", description: "D1 — New Construction — Deck Build", line_total: 22814 },
          { import_source: null, unit: "ea", description: "Install 20A circuit", line_total: 450 },
        ],
      };
      expect(billedWorkOnInvoices([inv])).toBe(23617.85);
    });

    it("J-002 is untouched: every line on it is labor, materials, a deposit or the credit netting it", () => {
      expect(billedWorkOnInvoices([deposit, inv28, inv80])).toBe(19716.64);
      expect(countsAsWorkCompleted({ import_source: null, unit: "lot", description: "Deposit — Tess Zane hot tub feed" }, "deposit")).toBe(false);
    });
  });

  it("tolerates nothing to read", () => {
    expect(billedWorkOnInvoices(null)).toBe(0);
    expect(billedWorkOnInvoices([{ status: "sent", invoice_kind: "standard", invoice_items: null }])).toBe(0);
  });
});

describe("computeJobProgress — T&M work to date = billed work + unbilled work", () => {
  it("J-002: the billed lines at their prices, not every hour re-priced at today's rate", () => {
    // Every hour at today's $125 / $85 is what read 18,624.14; the billed lines say 19,716.64.
    const r = computeJobProgress({ ...base, billableLabor: 99999, tmWork: { billed: 19716.64, unbilled: 0 } });
    expect(r.workToDate).toBe(19716.64);
  });

  it("adds the unbilled half, and a pending return credit comes off it", () => {
    expect(computeJobProgress({ ...base, tmWork: { billed: 1000, unbilled: 250.5 } }).workToDate).toBe(1250.5);
    expect(computeJobProgress({ ...base, tmWork: { billed: 1000, unbilled: -51.58 } }).workToDate).toBe(948.42);
  });

  it("fixed price keeps its contract roll-up whatever is passed", () => {
    const r = computeJobProgress({ ...base, billingTypeRaw: "fixed", tmWork: { billed: 1, unbilled: 1 } });
    expect(r.workToDate).toBeCloseTo(11327.87, 2);
  });
});
