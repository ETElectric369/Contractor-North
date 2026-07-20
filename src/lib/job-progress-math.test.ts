import { describe, it, expect } from "vitest";
import { computeJobProgress, livePurchaseOrders } from "./job-progress-math";

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
  it("reconciles to the billed lines (Tao: labor + materials, markup 0)", () => {
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
