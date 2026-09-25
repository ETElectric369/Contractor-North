import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE INVOICE PAGE SEEDS ITS % BOX FROM WHAT THE LINES ARE PRICED AT (2026-09-25), rendered through
 * the real InvoiceDetail. INV-078 was moved to 11%; the box read 15 (Andrew's level), and touching
 * it sent the 15 back. Here the page's seed (markupBoxSeed over readInvoiceMarkup) reaches the box.
 */

const { importCostsIntoInvoice } = vi.hoisted(() => ({ importCostsIntoInvoice: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer: vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({ emailQuote: vi.fn(), textQuote: vi.fn() }));
vi.mock("@/app/(app)/billing/actions", () => ({
  importCostsIntoInvoice,
  ...Object.fromEntries(
    [
      "addInvoiceItem", "updateInvoiceItem", "reorderInvoiceItems", "parkInvoice", "deleteInvoiceItem", "setInvoiceStatus",
      "setInvoiceTaxRate", "setInvoiceDescription", "setInvoiceTitle", "setInvoiceDueDate", "setInvoiceCustomerJob",
      "recordPayment", "importQuoteItemsIntoInvoice", "importLaborIntoInvoice", "reimportFromScratch",
      "importChangeOrdersIntoInvoice", "updatePayment", "deletePayment", "emailInvoice", "textInvoice",
    ].map((k) => [k, vi.fn()]),
  ),
}));

import { InvoiceDetail } from "./invoice-detail";
import { markupBoxSeed } from "@/lib/invoice-markup";

const invoice = {
  id: "09ff65de-2ec8-4884-a31f-583a8943b09a",
  invoice_number: "INV-078",
  status: "draft",
  invoice_kind: "standard",
  job_id: "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1",
  customer_id: "c-1",
  total: 3318.62,
  subtotal: 3318.62,
  amount_paid: 0,
  tax_rate: 0,
  tax_amount: 0,
} as any;
const items = [
  { id: "ii-1", invoice_id: invoice.id, description: "Flexbox", quantity: 1, unit: "ea", unit_price: 221.42, line_total: 221.42, import_source: "costs", import_key: "bill:11e96fc3", source_ids: ["11e96fc3"], edited: false, sort_order: 1 },
] as any[];

function render(seed: ReturnType<typeof markupBoxSeed>, levelMarkupPct: number | null = 15) {
  return renderToStaticMarkup(
    createElement(InvoiceDetail, { invoice, items, payments: [], markupSeed: seed, levelMarkupPct, customerName: "Andrew Cohen", importMode: "standard" }),
  );
}

function box(html: string) {
  const at = html.indexOf('aria-label="Material markup percent"');
  return html.slice(html.lastIndexOf("<input", at), html.indexOf(">", at) + 1);
}

describe("InvoiceDetail's % box", () => {
  it("INV-078 at 11%: the box reads 11 and says so, with Andrew's usual beside it", () => {
    const html = render(markupBoxSeed({ kind: "one", pct: 11 }, 15));
    expect(box(html)).toContain('value="11"');
    expect(html).toContain("Priced at 11%");
    expect(html).toContain("Andrew Cohen&#x27;s usual is 15%");
    expect(html).not.toContain(">Apply<");
    expect(importCostsIntoInvoice).not.toHaveBeenCalled();
  });

  it("lines at different markups: the usual figure, and the sentence that stops anyone assuming", () => {
    const html = render(markupBoxSeed({ kind: "mixed" }, 15));
    expect(box(html)).toContain('value="15"');
    expect(html).toContain("Lines are at different markups");
  });

  it("no pricing level: the org default is named as the default, not as the customer's", () => {
    const html = render(markupBoxSeed({ kind: "one", pct: 11 }, 20), null);
    expect(html).toContain("Your default is 20%");
  });
});
