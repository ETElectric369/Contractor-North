import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { leftToBill, scheduleStatus } from "@/lib/payment-schedule-math";

/**
 * LEFT TO BILL (W1-19): on a job billed by its contract the Overview leads with ONE figure, "Left To
 * Bill $L", and ONE button: the job's own New Invoice opened on Part Of The Estimate (a fixed-price
 * contract), or Request Next Payment (a schedule). The figure is never printed on a button whose click
 * doesn't bill it, a draft is named and never counted, and the reasoning waits in a Why? fold (a
 * <details>, so it is in the server's HTML and toContain still reaches it).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
// The job's New Invoice is lane 4's button, mounted as is: here it only shows what it was handed.
vi.mock("./new-invoice-button", () => ({
  NewInvoiceButton: (p: { preset?: string; label?: string }) =>
    createElement("button", { "data-new-invoice": p.preset ?? "none" }, p.label ?? "New Invoice"),
}));
vi.mock("./payment-schedule-card", () => ({ useRequestNextPayment: () => ({ pending: false, error: null, requestNext() {} }) }));

import { LeftToBillCard } from "./left-to-bill-card";
import { contractEstimates } from "./contract-estimates";

const NEW_INVOICE = { jobId: "j-011" };
const fold = (html: string) => html.slice(html.indexOf("<details"), html.indexOf("</details>") + "</details>".length);
const render = (p: Partial<Parameters<typeof LeftToBillCard>[0]> & { view: Parameters<typeof LeftToBillCard>[0]["view"] }) =>
  renderToStaticMarkup(createElement(LeftToBillCard, { jobId: "j-011", newInvoice: NEW_INVOICE, ...p }));

describe("a fixed-price contract", () => {
  const view = leftToBill({ estimate: 20000, invoiced: 5000 }, null);
  const estimates = [{ number: "E-012", total: 20000, accepted: true }];
  const sent = [{ id: "i1", number: "INV-079", total: 5000 }];

  it("Contract $C, the big Left To Bill $L, and the job's New Invoice on Part Of The Estimate", () => {
    const html = render({ view, estimates, sent });
    expect(html).toContain("Contract $20,000.00");
    expect(html).toContain("Left To Bill $15,000.00");
    expect(html).toContain('data-new-invoice="part"');
    expect(html).toMatch(/data-new-invoice="part"[^>]*>New Invoice</);
    // Never the figure on the button: the click opens the sheet that asks how much.
    expect(html).not.toMatch(/<button[^>]*>[^<]*\$15,000\.00/);
  });

  it("a thin Billed | Left bar, and the fold names the estimate and each bill that went out", () => {
    const html = render({ view, estimates, sent });
    expect(html).toContain('aria-label="$5,000.00 billed, $15,000.00 left"');
    expect(html).toContain("width:25%");
    const f = fold(html);
    expect(f).toContain(">Why?<");
    expect(f).toContain("E-012");
    expect(f).toContain("INV-079 · $5,000.00 · went out");
  });

  it("a draft open: named, never counted, and the button says it opens it", () => {
    const html = render({
      view,
      estimates,
      sent,
      draft: { id: "i2", number: "INV-080", total: 2000 },
      openDraft: { id: "i2", number: "INV-080", refreshable: false },
    });
    expect(html).toContain("INV-080 ($2,000.00) is a draft.");
    expect(html).toContain("Left To Bill $15,000.00");
    expect(html).toMatch(/data-new-invoice="part"[^>]*>Open INV-080</);
    expect(fold(html)).toContain("draft, not counted until it goes out");
  });

  it("billed in full: $0.00 · the contract is billed, and no button", () => {
    const html = render({ view: leftToBill({ estimate: 20000, invoiced: 20000 }, null), estimates, sent });
    expect(html).toContain("Left To Bill $0.00");
    expect(html).toContain("the contract is billed");
    expect(html).not.toContain("<button");
  });

  it("an estimate not accepted yet is called an estimate, not a contract", () => {
    const html = render({ view, estimates: [{ number: "E-013", total: 20000, accepted: false }] });
    expect(html).toContain("Estimate $20,000.00");
    expect(html).not.toContain("Contract $");
  });
});

describe("a payment schedule", () => {
  const ms = [
    { sort_order: 0, label: "Deposit", percent: 30, invoice_id: "d1", billed_amount: 3000 },
    { sort_order: 1, label: "Rough-In", percent: 35 },
    { sort_order: 2, label: "Final", percent: 35 },
  ];
  const s = scheduleStatus(ms, 10000);
  const rows = s.rows.map((r) => ({ label: r.label, percent: r.percent, dollars: r.dollars, billed: r.billed, next: s.next?.index === r.index }));

  it("the schedule's own remaining, and Request Next Payment ($next) on a fixed-price job", () => {
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 3000 }, s), rows });
    expect(html).toContain("Payment Schedule · $10,000.00");
    expect(html).toContain("Left To Bill $7,000.00");
    expect(html).toContain("Request Next Payment ($3,500.00)");
    expect(html).not.toContain("data-new-invoice");
    const f = fold(html);
    expect(f).toContain("Deposit · 30% · $3,000.00");
    expect(f).toContain(">Billed<");
    expect(f).toContain("Rough-In · 35% · $3,500.00");
    expect(f).toContain(">Next<");
  });

  it("Time & Material: the click bills the work since the last bill, so no figure on the button, and it says why", () => {
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 3000 }, s), rows, isTm: true });
    expect(html).toMatch(/<button[^>]*>Request Next Payment</);
    expect(html).not.toContain("Request Next Payment ($");
    expect(html).toContain("bills the hours and receipts since the last bill");
  });

  it("fully drawn: $0.00 · every payment is billed, no button", () => {
    const done = scheduleStatus(ms.map((m) => ({ ...m, invoice_id: "x", billed_amount: m.billed_amount ?? 3500 })), 10000);
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 10000 }, done), rows: [] });
    expect(html).toContain("Left To Bill $0.00");
    expect(html).toContain("every payment is billed");
    expect(html).not.toContain("<button");
  });

  it("an open draft: the button opens it (the server refuses a second payment beside it)", () => {
    const html = render({
      view: leftToBill({ estimate: 10000, invoiced: 3000 }, s),
      rows,
      draft: { id: "d2", number: "INV-081", total: 3500 },
      openDraft: { id: "d2", number: "INV-081", refreshable: false },
    });
    expect(html).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Open INV-081</);
    expect(html).not.toContain("Request Next Payment");
  });

  it("a schedule that draws less than the contract says so in amber, outside the fold", () => {
    const short = scheduleStatus([{ sort_order: 0, label: "a", percent: 50 }, { sort_order: 1, label: "b", percent: 40 }], 10000);
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 0 }, short), rows: [] });
    const words = "This schedule draws $1,000.00 less than the $10,000.00 contract.";
    expect(html).toContain(words);
    expect(fold(html)).not.toContain(words);
  });
});

describe("contractEstimates: the fold names the estimate the figure was taken from", () => {
  it("the accepted estimates, or else the newest one alone", () => {
    const q = [
      { quote_number: "E-1", total: 100, status: "sent", created_at: "2026-01-01" },
      { quote_number: "E-2", total: 200, status: "accepted", created_at: "2026-01-02" },
      { quote_number: "E-3", total: 300, status: "accepted", created_at: "2026-01-03" },
    ];
    expect(contractEstimates(q).map((e) => e.number)).toEqual(["E-2", "E-3"]);
    expect(contractEstimates(q.slice(0, 1).concat({ quote_number: "E-4", total: 50, status: "draft", created_at: "2026-02-01" })).map((e) => e.number)).toEqual(["E-4"]);
  });
});
