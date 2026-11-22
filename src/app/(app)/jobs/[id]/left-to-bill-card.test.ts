import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { leftToBill, scheduleStatus } from "@/lib/payment-schedule-math";
import { everythingBillable, type BillableInvoice } from "@/lib/everything-billable";
import { LangProvider } from "@/components/lang-provider";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERYTHING BILLABLE (cn-v1181; it was Left to Bill, W1-19): on a job billed by its contract the
 * Overview leads with ONE figure, the WHOLE billable amount ("Everything Billable $X": the estimates,
 * approved change orders, less discounts given, before tax), Billed | Still to Bill under it, and ONE
 * button that the server takes: Part of the Estimate while the estimate has a part to take, Bill the
 * Change Orders when only change orders are left, none when nothing is. A job on a payment schedule keeps
 * the schedule's own figures, drawn the same way, and Request Next Payment. The reasoning waits in a Why?
 * fold (a <details>, so it is in the server's HTML and toContain still reaches it). English and Spanish.
 * Stand-ins only: Q-900, INV-900 and on, CO-900.
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

type Props = Parameters<typeof LeftToBillCard>[0];
const NEW_INVOICE = { jobId: "j-900", hasEstimate: true };
const CONTRACT = leftToBill({ estimate: 0, invoiced: 0 }, null); // a contract job: only its kind is read
const fold = (html: string) => html.slice(html.indexOf("<details"), html.indexOf("</details>") + "</details>".length);
const render = (p: Partial<Props> & { view?: Props["view"] }, lang?: "es") => {
  const card = createElement(LeftToBillCard, { jobId: "j-900", newInvoice: NEW_INVOICE, view: CONTRACT, ...p });
  return renderToStaticMarkup(lang ? createElement(LangProvider, { lang, children: card }) : card);
};
const q = (o: Record<string, unknown> = {}) => ({ quote_number: "Q-900", status: "accepted", created_at: "2026-10-01T00:00:00Z", subtotal: 20000, tax: 0, total: 20000, ...o });
const inv = (o: Partial<BillableInvoice> = {}): BillableInvoice => ({ id: "i1", invoice_number: "INV-900", status: "sent", invoice_kind: "standard", subtotal: 5000, tax: 0, total: 5000, ...o });
const co = (amount: number) => ({ id: "co-1", co_number: "CO-900", description: "Add two receptacles", amount, status: "approved" });

describe("a fixed-price contract: Everything Billable", () => {
  const billable = everythingBillable({ quotes: [q()], invoices: [inv()] });

  it("THE ONE NUMBER is the whole; Billed | Still to Bill under it; the button is Part of the Estimate, with no figure on it", () => {
    const html = render({ billable });
    expect(html).toContain("Contract");
    expect(html).toContain("Everything Billable $20,000.00");
    expect(html).not.toContain("Left to Bill");
    expect(html).toContain("Billed $5,000.00");
    expect(html).toContain("Still to Bill $15,000.00");
    expect(html).toContain('aria-label="$5,000.00 billed, $15,000.00 still to bill"');
    expect(html).toContain("width:25%");
    expect(html).toMatch(/data-new-invoice="part"[^>]*>Part of the Estimate</);
    expect(html).not.toMatch(/<button[^>]*>[^<]*\$15,000\.00/);
  });

  it("the fold names the estimate at its before-tax price and each bill that went out", () => {
    const f = fold(render({ billable }));
    expect(f).toContain(">Why?<");
    expect(f).toContain("Accepted estimate Q-900 · $20,000.00");
    expect(f).toContain("INV-900 · $5,000.00 · went out");
  });

  it("a draft open: named, never counted, and the button says it opens it", () => {
    const html = render({
      billable,
      draft: { id: "i2", number: "INV-901", total: 2000 },
      openDraft: { id: "i2", number: "INV-901", refreshable: false },
    });
    expect(html).toContain("INV-901 ($2,000.00) is a draft.");
    expect(html).toContain("Still to Bill $15,000.00");
    expect(html).toMatch(/data-new-invoice="part"[^>]*>Open INV-901</);
    expect(fold(html)).toContain("draft, not counted until it goes out");
  });

  it("a payment request for the whole price: all billed, so no Part of the Estimate though no bill carries the work (cn-v1181, lane S)", () => {
    const e = everythingBillable({ quotes: [q()], invoices: [inv({ invoice_kind: "prepayment", subtotal: 20000, total: 20000 })] })!;
    // The two figures differ: money asked ahead counts as billed, a part is measured by work.
    expect(e.left).toBe(0);
    expect(e.partLeftGross).toBe(20000);
    const html = render({ billable: e });
    expect(html).not.toContain("data-new-invoice");
    expect(html).not.toContain("Part of the Estimate");
    // ...and the same with a draft open: the button does not open it as a part.
    expect(render({ billable: e, openDraft: { id: "i2", number: "INV-901", refreshable: false } })).not.toContain('data-new-invoice="part"');
  });

  it("money asked ahead is said: the whole price requested ahead does not just read all billed (cn-v1181 fixer, F15)", () => {
    const e = everythingBillable({ quotes: [q()], invoices: [inv({ invoice_kind: "prepayment", subtotal: 20000, total: 20000 })] })!;
    expect(e.requestsToComeOff).toBe(20000);
    const html = render({ billable: e });
    expect(html).toContain("$20,000.00 of this was asked ahead on a payment request: it comes off the next bill.");
    expect(html).not.toMatch(/amber/);
    expect(render({ billable: e }, "es")).toContain("$20,000.00 de esto se pidió por adelantado en una solicitud de pago: se descuenta de la próxima factura.");
    // A request a bill already took off is not said again; nothing asked ahead, nothing said.
    expect(render({ billable })).not.toContain("asked ahead");
  });

  it("billed in full: said in a few words, and no button", () => {
    const html = render({ billable: everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 20000, total: 20000 })] }) });
    expect(html).toContain("Everything Billable $20,000.00");
    expect(html).toContain("all billed");
    expect(html).not.toContain("<button");
  });

  it("an estimate not accepted yet is called an estimate, not a contract", () => {
    const html = render({ billable: everythingBillable({ quotes: [q({ status: "sent" })] }) });
    expect(html).toContain("Estimate");
    expect(html).not.toContain("Contract");
    expect(fold(html)).toContain("Estimate Q-900, not accepted yet · $20,000.00");
  });

  it("an approved add never billed: in the whole, still to bill, and the button is Bill the Change Orders (never a part the estimate no longer has)", () => {
    const b = everythingBillable({ quotes: [q()], changeOrders: [co(1000)], invoices: [inv({ subtotal: 20000, total: 20000 })] });
    const html = render({ billable: b, newInvoice: { ...NEW_INVOICE, changeOrdersToBill: 1 } });
    expect(html).toContain("Everything Billable $21,000.00");
    expect(html).toContain("Still to Bill $1,000.00");
    expect(html).toMatch(/data-new-invoice="none"[^>]*>Bill the Change Orders</);
    expect(fold(html)).toContain("Approved change order CO-900 · Add two receptacles · +$1,000.00");
  });

  it("an add left where New Invoice can't bill it (a job billed in draws): no button the server refuses, and a sentence, never a dead end", () => {
    const b = everythingBillable({ quotes: [q()], changeOrders: [co(1000)], invoices: [inv({ subtotal: 20000, total: 20000 })] });
    const html = render({ billable: b, newInvoice: { ...NEW_INVOICE, changeOrdersToBill: 0 } });
    expect(html).not.toContain("<button");
    expect(html).toContain("Nothing on this card bills the $1,000.00 still to bill");
  });

  it("an approved deduct never taken off: billed past what was agreed, said outside the fold", () => {
    const b = everythingBillable({ quotes: [q()], changeOrders: [co(-900)], invoices: [inv({ subtotal: 20000, total: 20000 })] });
    const html = render({ billable: b });
    const words = "The bills that went out come to $900.00 more than what was agreed.";
    expect(html).toContain("Everything Billable $19,100.00");
    expect(html).toContain(words);
    expect(fold(html)).not.toContain(words);
    expect(fold(html)).toContain("−$900.00");
    expect(html).not.toContain("<button");
  });

  it("a discount given on a sent bill is a lower price: in the fold, and the job is all billed", () => {
    const b = everythingBillable({ quotes: [q()], invoices: [inv({ subtotal: 19500, total: 19500, discount: -500 })] });
    const html = render({ billable: b });
    expect(html).toContain("Everything Billable $19,500.00");
    expect(html).toContain("all billed");
    expect(fold(html)).toContain("Discounts given on the bills · −$500.00");
  });

  it("a taxed estimate: 'before tax' said once, the tax billed in the fold, and a bill's count beside its total", () => {
    const b = everythingBillable({ quotes: [q({ subtotal: 20000, tax: 1600, total: 21600 })], invoices: [inv({ subtotal: 10000, tax: 800, total: 10800 })] });
    const html = render({ billable: b });
    expect(html).toContain("Everything Billable $20,000.00");
    expect(html.match(/before tax/g)?.length).toBe(1);
    const f = fold(html);
    expect(f).toContain("INV-900 · $10,800.00 · went out");
    expect(f).toContain("counts $10,000.00");
    expect(f).toContain("Tax billed so far: $800.00");
  });

  it("a read behind the figure failed: said, with no figure and no button", () => {
    const html = render({ billable: null, unread: true });
    expect(html).toContain("couldn&#x27;t be read just now");
    expect(html).not.toContain("$");
    expect(html).not.toContain("<button");
  });

  it("in Spanish: Todo lo Facturable, Facturado, Por Facturar, Parte del Presupuesto, ¿Por qué?", () => {
    const html = render({ billable }, "es");
    expect(html).toContain("Todo lo Facturable $20,000.00");
    expect(html).toContain("Facturado $5,000.00");
    expect(html).toContain("Por Facturar $15,000.00");
    expect(html).toMatch(/data-new-invoice="part"[^>]*>Parte del Presupuesto</);
    expect(html).toContain("¿Por qué?");
    expect(fold(html)).toContain("Presupuesto aceptado Q-900");
    expect(html).not.toContain("Everything Billable");
  });
});

describe("a payment schedule: its own figures, drawn the same way", () => {
  const ms = [
    { sort_order: 0, label: "Deposit", percent: 30, invoice_id: "d1", billed_amount: 3000 },
    { sort_order: 1, label: "Rough-In", percent: 35 },
    { sort_order: 2, label: "Final", percent: 35 },
  ];
  const s = scheduleStatus(ms, 10000);
  const rows = s.rows.map((r) => ({ label: r.label, percent: r.percent, dollars: r.dollars, billed: r.billed, next: s.next?.index === r.index }));

  it("the whole schedule, what is still to bill, and Request Next Payment ($next) on a fixed-price job", () => {
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 3000 }, s), rows });
    expect(html).toContain("Payment Schedule");
    expect(html).toContain("Everything Billable $10,000.00");
    expect(html).toContain("Still to Bill $7,000.00");
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

  it("fully drawn: every payment is billed, no button", () => {
    const done = scheduleStatus(ms.map((m) => ({ ...m, invoice_id: "x", billed_amount: m.billed_amount ?? 3500 })), 10000);
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 10000 }, done), rows: [] });
    expect(html).toContain("Still to Bill $0.00");
    expect(html).toContain("every payment is billed");
    expect(html).not.toContain("<button");
  });

  it("an open draft: the button opens it (the server refuses a second payment beside it)", () => {
    const html = render({
      view: leftToBill({ estimate: 10000, invoiced: 3000 }, s),
      rows,
      draft: { id: "d2", number: "INV-902", total: 3500 },
      openDraft: { id: "d2", number: "INV-902", refreshable: false },
    });
    expect(html).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Open INV-902</);
    expect(html).not.toContain("Request Next Payment");
  });

  it("a schedule that draws less than the contract says so, outside the fold", () => {
    const short = scheduleStatus([{ sort_order: 0, label: "a", percent: 50 }, { sort_order: 1, label: "b", percent: 40 }], 10000);
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 0 }, short), rows: [] });
    const words = "This schedule draws $1,000.00 less than the $10,000.00 contract.";
    expect(html).toContain(words);
    expect(fold(html)).not.toContain(words);
  });

  it("in Spanish: Calendario de Pagos and Pedir el Siguiente Pago", () => {
    const html = render({ view: leftToBill({ estimate: 10000, invoiced: 3000 }, s), rows }, "es");
    expect(html).toContain("Calendario de Pagos");
    expect(html).toContain("Todo lo Facturable $10,000.00");
    expect(html).toContain("Pedir el Siguiente Pago ($3,500.00)");
  });
});

describe("contractEstimates: the fold names the estimate the figure was taken from", () => {
  it("the accepted estimates, or else the newest one alone", () => {
    const qs = [
      { quote_number: "Q-901", total: 100, status: "sent", created_at: "2026-01-01" },
      { quote_number: "Q-902", total: 200, status: "accepted", created_at: "2026-01-02" },
      { quote_number: "Q-903", total: 300, status: "accepted", created_at: "2026-01-03" },
    ];
    expect(contractEstimates(qs).map((e) => e.number)).toEqual(["Q-902", "Q-903"]);
    expect(contractEstimates(qs.slice(0, 1).concat({ quote_number: "Q-904", total: 50, status: "draft", created_at: "2026-02-01" })).map((e) => e.number)).toEqual(["Q-904"]);
  });
});

describe("the job page draws the tile from Everything Billable (a server page: its reads and its mount, by source)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
  it("the estimates are read with their subtotal and tax, the bills' subtotal, tax and discount lines once, and the rule is the shared one", () => {
    expect(page).toContain('from("quotes").select("id, quote_number, status, subtotal, tax, total, doc_type, created_at")');
    expect(page).toContain('.select("id, subtotal, tax, invoice_items(line_kind, line_total, import_source)")');
    // The discount lines AND the lines that took a payment request off (cn-v1181, lane S): without the
    // credit a draw that took one off on a taxed estimate reads as more work than it billed.
    expect(page).toContain('.or(`line_kind.eq.discount,import_source.eq.${PREPAID_CREDIT}`, { referencedTable: "invoice_items" })');
    expect(page).toMatch(/const prepaidCredit = \(r\.invoice_items \?\? \[\]\)\.filter\(\(l\) => l\.import_source === PREPAID_CREDIT\)/);
    expect(page).toContain("billMoney.set(String(r.id), { subtotal: r.subtotal, tax: r.tax, discount, prepaidCredit });");
    expect(page).toContain('import { PREPAID_CREDIT } from "@/lib/prepayments";');
    // The one decision over the page's reads (./billable-view), every read it rests on handed in (S3).
    expect(page).toContain("const billable = jobBillableView({");
    expect(page).toContain("failed: { money: !!billsRead.error, quotes: !!quotesErr, changeOrders: !!changeOrdersErr, invoices: !!invoicesErr },");
    expect(page).toContain("const billableView = billable.tile;");
    expect(page).toContain("const billableUnread = billable.tileUnread;");
  });
  it("the card is handed the figure and the failed-read flag, never the old estimates and sent lists", () => {
    expect(page).toMatch(/<LeftToBillCard[\s\S]{0,200}billable=\{billableView\}\s+unread=\{billableUnread\}/);
    expect(page).not.toContain("contractEstimates(");
  });
});
