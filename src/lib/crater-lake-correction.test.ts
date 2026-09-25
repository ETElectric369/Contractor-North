import { describe, it, expect } from "vitest";
import { billableBillCost, type BillLine } from "@/lib/bill-itemisation";
import { returnCreditCost, returnCreditRows, returnLinesAgainstPurchases } from "@/lib/supplier-returns";
import { computeUnbilledWork, foldClaims } from "@/lib/unbilled-work";
import { computeJobProfitRows } from "@/lib/analytics/job-profitability";
import { computeJobProgress } from "@/lib/job-progress-math";

/**
 * THE 518 CRATER LAKE CORRECTION, READ BY THE APP'S OWN ARITHMETIC (2026-09-24).
 *
 * Bill c0535cdb on J-046 was recorded from a counter sheet that turned out to be CED's internal
 * cost sheet: $467.87. CED's real invoice 8802-1108330 is $653.25, and CED then issued two credit
 * memos, 8802-1108541 (-$115.33, the 30641J wire connectors it billed twice and never shipped) and
 * 8802-1108540 (-$82.10, a lot credit for over-billing). Erik's call: the bill takes CED's real
 * figures, both memos go on the job as COST ONLY, and INV-069 - which Jason has paid in full -
 * does not move.
 *
 * "Cost only" has no column of its own, and it does not need one. A negative bill is a supplier
 * return, and supplier-returns.ts credits the customer for it UNLESS its lines were never the
 * customer's (billable = false, 0268). So the memos are written as negative bills whose every line
 * is switched off - never lineless, because a lineless negative bill credits in full. This file
 * pins that the shape the one-off SQL writes is read that way by every reader: nothing reaches a
 * customer, the job's cost drops to what CED actually charged, and the corrected purchase would
 * bill (if INV-069 were ever voided and rebuilt) only what Jason actually received.
 *
 * The figures are the production rows, read 2026-09-24. Markup on this job is 25%.
 */

const MAIN = "c0535cdb-e485-4679-8e56-fd0918fd728b";
const MEMO_DUP = "memo-8802-1108541";
const MEMO_LOT = "memo-8802-1108540";
const JOB = "3d1bb8cc-ac74-4a57-9eef-6739d0a1a0c3";
const line = (id: string, description: string, quantity: number, amount: number, extra: Partial<BillLine> = {}): BillLine => ({
  id,
  description,
  quantity,
  unit_price: Math.round((amount / quantity) * 100) / 100,
  amount,
  category: "Electrical",
  billable: true,
  billed_amount: null,
  ...extra,
});

/** c0535cdb after the correction: the same eight line ids (INV-069's import keys still name them),
 *  at CED's extensions, plus the double-keyed 30641J line switched off and CED's own tax. */
const MAIN_LINES: BillLine[] = [
  line("90cf614c", "ITE PN1632L1125C 125A Plug On Neutral Load Center", 1, 119.26),
  line("374b0d23", "3M 33+SUPER3/4X76FT 3/4 x 76 33+ Super Vinyl Tape", 2, 20.6),
  line("24bfd5db", "IDEAL 30641 500/5000 Twister 341-Tan", 500, 77.39),
  line("595b34f6", "IDEAL 30030 8-Oz Anti Oxidant Comp", 1, 2.95),
  line("eb753e54", "SQD HOM120 Miniature Circuit", 3, 23.13),
  line("266c063c", "SQD HOMT1515 Miniature Circuit", 4, 75.6),
  line("1c3216e4", "SQD HOMT2020 Miniature Circuit", 4, 75.6),
  line("99fb20d5", "SQD HOMT230250 Miniature Ckt Brkr", 2, 94.48),
  line("n30641j", "WIRE CONNECTOR (30641J)", 500, 104.85, { billable: false }),
  line("ntax0330", "Sales Tax (Invoice 8802-1108330)", 1, 59.39, { category: "Tax" }),
];

/** The memos: positive counts, negative prices (so the price book never learns a credit as a
 *  purchase), and every line switched off. */
const DUP_LINES: BillLine[] = [
  line("d1", "WIRE CONNECTOR (30641J)", 500, -104.85, { billable: false }),
  line("d2", "Sales Tax (Invoice 8802-1108541)", 1, -10.48, { category: "Tax", billable: false }),
];
const LOT_LINES: BillLine[] = [
  line("l1", "LOT CREDIT FOR OVER BILLING", 1, -75.32, { category: "Materials", billable: false }),
  line("l2", "Sales Tax (Invoice 8802-1108540)", 1, -6.78, { category: "Tax", billable: false }),
];

const cedBills = [
  { id: MAIN, job_id: JOB, supplier: "Contractors Electrical Distributors", bill_number: "8802-1108330", amount: 653.25, po_id: null, bill_line_items: MAIN_LINES },
  { id: MEMO_DUP, job_id: JOB, supplier: "Consolidated Electrical Distributors", bill_number: "8802-1108541", amount: -115.33, po_id: null, bill_line_items: DUP_LINES },
  { id: MEMO_LOT, job_id: JOB, supplier: "Consolidated Electrical Distributors", bill_number: "8802-1108540", amount: -82.1, po_id: null, bill_line_items: LOT_LINES },
];
const sum = (ls: BillLine[]) => Math.round(ls.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100;

describe("518 Crater Lake - the corrected bill and two cost-only memos", () => {
  it("each bill's lines add up to the supplier's own total, to the cent", () => {
    expect(sum(MAIN_LINES)).toBe(653.25);
    expect(sum(DUP_LINES)).toBe(-115.33);
    expect(sum(LOT_LINES)).toBe(-82.1);
  });

  it("credits the customer nothing for either memo", () => {
    const capped = returnLinesAgainstPurchases(cedBills, (b) => b.bill_line_items);
    for (const memo of cedBills.slice(1)) {
      expect(returnCreditCost(memo.amount, capped.get(memo) ?? memo.bill_line_items)).toBe(0);
      expect(returnCreditRows(memo, capped.get(memo) ?? memo.bill_line_items, 25)).toEqual([]);
    }
  });

  it("would credit in full if a memo were written with no lines - the shape the SQL refuses", () => {
    expect(returnCreditCost(-115.33, [])).toBe(115.33);
  });

  it("the corrected purchase bills only what Jason received: $653.25 less 30641J and its tax share", () => {
    // 104.85 + round(59.39 x 104.85 / 593.86) = 104.85 + 10.49; CED's memo rounded the tax to 10.48.
    expect(billableBillCost(653.25, MAIN_LINES)).toBe(537.91);
  });

  it("puts nothing on the Unbilled card: the purchase is INV-069's, and the memos bill nobody", () => {
    const claims = foldClaims(
      [{ id: "inv69", invoice_number: "INV-069", status: "paid", created_at: "2026-09-18T22:59:05Z", invoice_items: [{ import_key: `bill:${MAIN}:remainder`, source_ids: [MAIN] }] }],
      true,
    );
    const w = computeUnbilledWork({
      claims,
      jobEntries: [],
      nonBillableCodes: new Set<string>(),
      defaultRate: 0,
      levelRate: null,
      pos: [],
      bills: cedBills,
      markupPct: 25,
    });
    expect(w.billsCount).toBe(0);
    expect(w.billsAmount).toBe(0);
    expect(w.returnsCount).toBe(0);
    expect(w.returnsCredit).toBe(0);
    expect(w.total).toBe(0);
    expect(w.claimedOn).toEqual(["INV-069"]);
  });

  it("costs the job what CED actually charged: $455.82 of CED, $1,064.34 of materials in all", () => {
    const otherReceipts = [155.19, 400.85, 9.87, 16.28, 26.33].map((amount, i) => ({ id: `r${i}`, job_id: JOB, amount, po_id: null }));
    const cedOnly = computeJobProfitRows({ jobs: [{ id: JOB, job_number: "J-046", name: "Jason Waldow", status: "complete" }], payments: [], pos: [], bills: cedBills, jobRefunds: [], entries: [], pettyCash: [], shelfNet: [] });
    expect(Math.round(cedOnly[0].cost * 100) / 100).toBe(455.82);
    const all = computeJobProfitRows({ jobs: [{ id: JOB, job_number: "J-046", name: "Jason Waldow", status: "complete" }], payments: [], pos: [], bills: [...cedBills, ...otherReceipts], jobRefunds: [], entries: [], pettyCash: [], shelfNet: [] });
    expect(Math.round(all[0].cost * 100) / 100).toBe(1064.34);
  });

  it("moves the work-to-date reference to the real purchase and takes nothing off for the memos", () => {
    const p = computeJobProgress({ billingTypeRaw: "tm", quotes: [], invoices: [], billableLabor: 0, pos: [], bills: cedBills, markupPercent: 25 });
    expect(p.workToDate).toBe(672.39); // 537.91 x 1.25
  });
});
