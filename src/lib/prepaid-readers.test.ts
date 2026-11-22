import { describe, it, expect } from "vitest";
import { billedWorkOnInvoices, computeJobProgress } from "./job-progress-math";
import { countsAsWorkCompleted, lineGroup, sectionLines, LINE_GROUP_LABEL, LINE_GROUP_ORDER, PAYMENT_REQUEST_LABEL } from "./portal/line-kind";
import { buildJobLedger, type LedgerInvoiceIn, type LedgerLineIn } from "./portal/stretch-ledger";
import { eligibleInvoice, eligibleLines, abLineOf } from "./already-billed";
import { DRAW_CREDIT, PREPAID_CREDIT, PREPAYMENT_KIND, PREPAYMENT_LINE } from "./prepayments";
import { isActualsDraw, unbilledCardDoor } from "./actuals-draw";
import { milestoneSettled } from "./billing-pipeline";
import { quoteSettled } from "./action-items/quote-settled";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CostBreakdown } from "@/components/cost-breakdown";

/**
 * MONEY ASKED FOR AHEAD, AS EVERY READER SEES IT (cn-v1177). A payment request is a bill of kind
 * "prepayment" with one line (import_source "prepayment"); the next bill on the job takes it off with a
 * "prepaid_credit" line (line_kind "credit"). The readers must count neither as work: the request is
 * money asked ahead, and the credit is that money coming back off, so the two together leave the work
 * billed exactly the later bill's own work. The portal's ledger must still reconcile, to the cent.
 */

const requestLine = { import_source: PREPAYMENT_LINE, description: "Deposit", line_kind: null, unit: null, line_total: 1000 };
const creditLine = { import_source: PREPAID_CREDIT, description: "Less deposit (INV-900)", line_kind: "credit", unit: null, line_total: -1000 };

describe("the line rule: a request is Payment Requests, its credit is Credits, neither is work", () => {
  it("a request's own line reads under Payment Requests whatever it says, on its own kind of bill", () => {
    expect(lineGroup(requestLine, PREPAYMENT_KIND)).toBe("prepayment");
    // Even a line typed with words the hand rule would call labor, on a request: never work.
    expect(lineGroup({ import_source: null, description: "Labor - Sam Tillery", unit: "hr", line_kind: null }, PREPAYMENT_KIND)).toBe("prepayment");
    expect(countsAsWorkCompleted(requestLine, PREPAYMENT_KIND)).toBe(false);
    expect(LINE_GROUP_LABEL.prepayment).toBe("Payment Requests");
    expect(LINE_GROUP_ORDER.indexOf("prepayment")).toBe(LINE_GROUP_ORDER.indexOf("deposit") + 1);
  });
  it("the credit that takes a request off reads as a Credit, stored kind or not", () => {
    expect(lineGroup(creditLine, "standard")).toBe("credit");
    expect(lineGroup({ ...creditLine, line_kind: null }, "standard")).toBe("credit");
    expect(countsAsWorkCompleted(creditLine, "standard")).toBe(false);
    expect(countsAsWorkCompleted({ ...creditLine, line_kind: null }, "standard")).toBe(false);
  });
  it("the one word for the kind", () => {
    expect(PAYMENT_REQUEST_LABEL).toBe("Payment Request");
  });
  it("a request's bill, sectioned for the portal, is one Payment Requests section that adds up", () => {
    expect(sectionLines([requestLine], PREPAYMENT_KIND).map((s) => [s.label, s.subtotal])).toEqual([["Payment Requests", 1000]]);
  });
});

describe("billedWorkOnInvoices: a request and the bill that took it off never change the work billed", () => {
  const work = [
    { import_source: "labor", line_kind: null, unit: "hr", description: "Labor - Sam Tillery", line_total: 1500 },
    { import_source: "costs", line_kind: null, unit: "ea", description: "Materials", line_total: 700 },
  ];
  const standard = (items: any[], status = "sent") => ({ status, invoice_kind: "standard", invoice_items: items });
  const request = (status = "paid") => ({ status, invoice_kind: PREPAYMENT_KIND, invoice_items: [requestLine] });

  it("work $2,200, a $1,000 request, the bill takes it off: work billed is $2,200, not $1,200 and not $3,200", () => {
    expect(billedWorkOnInvoices([standard(work)])).toBe(2200);
    expect(billedWorkOnInvoices([request(), standard([...work, creditLine])])).toBe(2200);
  });
  it("with the credit stored without a kind (only its source says what it is), the same", () => {
    expect(billedWorkOnInvoices([request(), standard([...work, { ...creditLine, line_kind: null }])])).toBe(2200);
  });
  it("a request alone is no work billed, paid or not, sent or draft", () => {
    expect(billedWorkOnInvoices([request("paid")])).toBe(0);
    expect(billedWorkOnInvoices([request("sent")])).toBe(0);
    expect(billedWorkOnInvoices([request("draft")])).toBe(0);
  });
  it("a draft bill that has taken the request off counts its work, never the credit", () => {
    expect(billedWorkOnInvoices([request(), standard([...work, creditLine], "draft")])).toBe(2200);
  });
  it("the draw pool is untouched: a draw credit is still not work", () => {
    expect(billedWorkOnInvoices([standard([...work, { import_source: DRAW_CREDIT, line_kind: null, unit: null, description: "Less previous billings", line_total: -500 }])])).toBe(2200);
  });
  it("on the job page's figures, invoiced and collected add up with the request: the two bills sum to the work", () => {
    const p = computeJobProgress({
      billingTypeRaw: "tm",
      quotes: [],
      invoices: [
        { total: 1000, status: "paid", amount_paid: 1000 },
        { total: 1200, status: "sent", amount_paid: 0 },
      ],
      billableLabor: 0,
      pos: [],
      bills: [],
      markupPercent: 0,
      tmWork: { billed: billedWorkOnInvoices([request(), standard([...work, creditLine])]), unbilled: 0 },
    });
    expect(p.invoiced).toBe(2200);
    expect(p.collected).toBe(1000);
    expect(p.workToDate).toBe(2200);
  });
});

describe("the customer's ledger: a request is money asked ahead, its credit lands with it, and everything reconciles", () => {
  const TZ = "America/Los_Angeles";
  const inv = (over: Partial<LedgerInvoiceIn> & { id: string }): LedgerInvoiceIn => ({
    invoice_number: null,
    status: "sent",
    tax: 0,
    total: 0,
    amount_paid: 0,
    created_at: "2026-11-01T18:00:00Z",
    sent_at: null,
    invoice_kind: "standard",
    ...over,
  });
  const line = (over: Partial<LedgerLineIn> & { invoice_id: string }): LedgerLineIn => ({
    sort_order: 0,
    description: "",
    quantity: 1,
    unit: null,
    unit_price: 0,
    line_total: 0,
    import_source: null,
    ...over,
  });
  const stretches = [
    { id: "s1", label: "Rough-in", starts_on: "2026-11-01", ends_on: "2026-11-07" },
    { id: "s2", label: "Trim", starts_on: "2026-11-15", ends_on: "2026-11-21" },
  ];
  const req = inv({ id: "r", invoice_number: "INV-900", status: "paid", total: 1000, amount_paid: 1000, invoice_kind: PREPAYMENT_KIND, created_at: "2026-11-02T18:00:00Z", sent_at: "2026-11-02T18:00:00Z" });
  const reqLine = line({ invoice_id: "r", description: "Deposit", unit_price: 1000, line_total: 1000, import_source: PREPAYMENT_LINE });
  const bill = inv({ id: "b", invoice_number: "INV-901", status: "sent", total: 1200, amount_paid: 0, created_at: "2026-11-20T18:00:00Z", sent_at: "2026-11-20T18:00:00Z" });
  const billWork = line({ invoice_id: "b", sort_order: 0, description: "Install", unit_price: 2200, line_total: 2200 });
  const billCredit = (named: boolean) =>
    line({ invoice_id: "b", sort_order: 1, description: "Less deposit (INV-900)", unit_price: -1000, line_total: -1000, import_source: PREPAID_CREDIT, line_kind: "credit", ...(named ? { prepaid_invoice_id: "r" } : {}) });
  const payments = [{ invoice_id: "r", amount: 1000, paid_at: "2026-11-02T19:00:00Z", method: "card" }];

  it("a paid request with no later bill: billed to date is the request, paid, balance 0, and it reconciles", () => {
    const l = buildJobLedger({ stretches, invoices: [req], lines: [reqLine], payments, tz: TZ });
    expect(l.reconciles).toBe(true);
    expect([l.workTotal, l.paidTotal, l.balance]).toEqual([1000, 1000, 0]);
    // Shown as Payment Requests, never as Labor or Materials work.
    expect(l.split.lines.find((x) => x.group === "prepayment")?.amount).toBe(1000);
    expect(l.split.lines.filter((x) => x.group === "labor" || x.group === "materials").every((x) => x.amount === 0)).toBe(true);
  });

  for (const named of [true, false]) {
    it(`the bill that took it off ${named ? "(the credit names its request)" : "(a read with no name: the oldest request first)"}: the credit lands in the request's stretch, and the money card adds up`, () => {
      const l = buildJobLedger({ stretches, invoices: [req, bill], lines: [reqLine, billWork, billCredit(named)], payments, tz: TZ });
      expect(l.reconciles).toBe(true);
      expect([l.workTotal, l.paidTotal, l.balance, l.billedTotal, l.billedBalance]).toEqual([2200, 1000, 1200, 2200, 1200]);
      // The request and its credit cancel in the first stretch: paid ahead there, never "work owed".
      expect(l.stretches.map((s) => [s.label, s.workTotal, s.paidTotal, s.balanceAfter])).toEqual([
        ["Rough-in", 0, 1000, -1000],
        ["Trim", 2200, 0, 1200],
      ]);
      const credit = l.stretches[0].days.flatMap((d) => d.items).find((it) => it.amount === -1000)!;
      expect(credit.datedBy).toBe("request");
      expect(credit.kind).toBe("credit");
      expect(credit.group).toBe("credit");
    });
  }

  it("the two pools are never mixed: a draw credit on a job with a request never dates itself by the request", () => {
    const drawBill = inv({ id: "d", invoice_number: "INV-902", status: "sent", total: 1700, created_at: "2026-11-20T18:00:00Z", sent_at: "2026-11-20T18:00:00Z", invoice_kind: "progress" });
    const drawWork = line({ invoice_id: "d", description: "Labor", unit_price: 2200, line_total: 2200, import_source: "labor", unit: "ea" });
    const drawCredit = line({ invoice_id: "d", sort_order: 1, description: "Less previous billings", unit_price: -500, line_total: -500, import_source: DRAW_CREDIT });
    const l = buildJobLedger({ stretches, invoices: [req, drawBill], lines: [reqLine, drawWork, drawCredit], payments, tz: TZ });
    expect(l.reconciles).toBe(true);
    const piece = l.stretches.flatMap((s) => s.days.flatMap((d) => d.items)).find((it) => it.amount === -500)!;
    // No lump of the draw pool exists, so the draw credit stays on its own bill's day.
    expect(piece.datedBy).toBe("bill");
  });
});

describe("Already Billed never offers a request or the line that takes one off", () => {
  it("a payment request cannot hold a cost; a credit line is never a line to hold one", () => {
    expect(eligibleInvoice({ status: "paid", invoice_kind: PREPAYMENT_KIND })).toBe(false);
    expect(eligibleInvoice({ status: "sent", invoice_kind: "standard" })).toBe(true);
    const inv: any = {
      id: "b",
      invoice_number: "INV-901",
      status: "sent",
      invoice_kind: "standard",
      created_at: "2026-11-20",
      lines: [abLineOf({ id: "c", description: "Less deposit (INV-900)", line_total: -1000, import_source: PREPAID_CREDIT, edited: true, line_kind: "credit" })],
    };
    expect(eligibleLines(inv, { kind: "bill", negative: true })).toEqual([]);
  });
});


describe("a request's credit says nothing about how a draw was built (the draw pool's credit only)", () => {
  it("a fixed-amount draw that took a request off is still a contract draw, not an actuals report", () => {
    expect(isActualsDraw({ invoiceKind: "progress", scheduleActive: false, lineSources: [null, PREPAID_CREDIT] })).toBe(false);
    expect(isActualsDraw({ invoiceKind: "progress", scheduleActive: false, lineSources: [null, DRAW_CREDIT] })).toBe(true);
  });
});

describe("a payment request is not a bill for work (cn-v1177, the sweep)", () => {
  const request = { id: "r", job_id: "j", quote_id: "q", invoice_kind: PREPAYMENT_KIND, status: "paid", created_at: "2026-11-02T18:00:00Z" };

  it("a request never settles a milestone; a standard bill still does", () => {
    expect(milestoneSettled({ milestoneAt: "2026-11-01T00:00:00Z", jobStatus: "complete", jobInvoices: [request] })).toBe(false);
    expect(milestoneSettled({ milestoneAt: "2026-11-01T00:00:00Z", jobStatus: "complete", jobInvoices: [{ ...request, invoice_kind: "standard" }] })).toBe(true);
  });

  it("a request never settles an estimate: not as the invoice naming it, not as the job's bill", () => {
    const quote = { id: "q", status: "accepted", accepted_at: "2026-11-01T00:00:00Z", created_at: "2026-10-30T00:00:00Z" };
    expect(quoteSettled({ quote, job: { id: "j", status: "to_be_scheduled" }, jobInvoices: [request], quoteInvoices: [request] }).settled).toBe(false);
    expect(quoteSettled({ quote, job: { id: "j", status: "to_be_scheduled" }, jobInvoices: [{ ...request, invoice_kind: "standard" }], quoteInvoices: [] }).settled).toBe(true);
  });

  it("the invoice's Cost Breakdown names a request taken off by its own words, apart from previous billings", () => {
    const html = renderToStaticMarkup(
      createElement(CostBreakdown, {
        items: [
          { description: "Labor - Sam Tillery", import_source: "labor", line_total: 1500, quantity: 10, unit_price: 150 },
          { description: "Materials", import_source: "costs", line_total: 700, quantity: 1, unit_price: 700 },
          { description: "Less previous billings", import_source: DRAW_CREDIT, line_total: -200, quantity: 1, unit_price: -200 },
          { description: "Less materials payment (INV-900)", import_source: PREPAID_CREDIT, line_kind: "credit", line_total: -500, quantity: 1, unit_price: -500 },
        ] as any,
      }),
    );
    const row = (label: string) => new RegExp(`<span class="text-slate-600">${label.replace(/[()]/g, "\\$&")}</span><span class="font-medium text-slate-900">([^<]*)</span>`).exec(html)?.[1];
    // The draw's credit alone under "Less previous billings"; the request on its own row, by its own words.
    expect(row("Less previous billings")).toBe("-$200.00");
    expect(row("Less materials payment (INV-900)")).toBe("-$500.00");
  });
});

describe("the job card's covered words are the DRAW pool's (cn-v1177, re-pinned on purpose after skeptic #80)", () => {
  it("every caller hands the card the draw money alone, so the words name the deposit draw", () => {
    const money = (n: number) => "$" + n.toFixed(2);
    const covered = unbilledCardDoor({ openDraft: null, workPending: true, returns: 0, total: 600, newWork: 600, lumpToNet: 1000, money });
    expect(covered).toEqual({ kind: "covered", note: "The $1000.00 deposit not yet taken off a bill still covers this, so there is nothing new to bill yet." });
    const net = unbilledCardDoor({ openDraft: null, workPending: true, returns: 0, total: 1500, newWork: 1500, lumpToNet: 1000, money });
    expect(net).toMatchObject({ kind: "create", amount: 500, note: "That is $1500.00 of work less the $1000.00 deposit not yet taken off a bill." });
  });
});
