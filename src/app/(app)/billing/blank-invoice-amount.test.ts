import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "I COULD NOT ADD AN AMOUNT TO A NEW BLANK INVOICE" — Erik's own report 44aeec9c, /billing,
 * 2026-09-22, and INV-073 the same day.
 *
 * A new blank invoice has no lines at all, so the only thing on the card is the add row:
 * [Add a line item…] [Qty] [unit] × [Price] [Add]. He typed the amount into Price and tapped Add.
 * ADD WAS DISABLED until the description had something in it, so the tap did nothing — and the one
 * control that could have told him what was missing was the one he could not press. (The first fix,
 * 2026-09-23, added an amber line under the row; the button stayed unpressable.)
 *
 * So: the Add button on a live invoice is always pressable, and the rule for what is still missing is
 * one function both the press and the line read.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer: vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({ emailQuote: vi.fn(), textQuote: vi.fn() }));
vi.mock("@/app/(app)/billing/actions", () => ({
  ...Object.fromEntries(
    [
      "importCostsIntoInvoice", "addInvoiceItem", "updateInvoiceItem", "reorderInvoiceItems", "parkInvoice",
      "deleteInvoiceItem", "setInvoiceStatus", "setInvoiceTaxRate", "setInvoiceDescription", "setInvoiceTitle",
      "setInvoiceDueDate", "setInvoiceCustomerJob", "recordPayment", "importQuoteItemsIntoInvoice",
      "importLaborIntoInvoice", "reimportFromScratch", "importChangeOrdersIntoInvoice", "updatePayment",
      "deletePayment", "emailInvoice", "textInvoice",
    ].map((k) => [k, vi.fn()]),
  ),
}));

import { InvoiceDetail, addLineAsk } from "./[id]/invoice-detail";

/** What createBlankInvoice makes from /billing → New Invoice → a customer: a draft, no lines. */
const blank = {
  id: "2b1c0000-0000-4000-8000-000000000090",
  invoice_number: "INV-090",
  status: "draft",
  invoice_kind: "standard",
  job_id: null,
  customer_id: "cust-rita",
  total: 0,
  subtotal: 0,
  amount_paid: 0,
  tax_rate: 0,
  tax_amount: 0,
} as any;

const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(InvoiceDetail, { invoice: { ...blank, ...over }, items: [], payments: [], customerName: "Rita Moss", importMode: "standard" } as any),
  );

/** The <button> that holds the Add label, with its class list taken off (Tailwind writes the word
 *  "disabled:" into class names, which would make any search for the ATTRIBUTE a false positive). */
const addButton = (html: string) => {
  const at = html.indexOf(" Add</button>");
  expect(at, "the add row must be drawn").toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), at).replace(/ class="[^"]*"/g, "");
};

describe("a brand new blank invoice can take an amount", () => {
  it("Add is PRESSABLE with the row empty — it used to be greyed out, so the tap did nothing", () => {
    const btn = addButton(render());
    expect(btn).not.toContain("disabled");
  });

  it("the price box is there to type into, and the empty card says what to do", () => {
    const html = render();
    expect(html).toContain('placeholder="Price"');
    expect(html).toContain("No line items yet. Type one in the row below, with its price, then tap Add.");
  });

  it("a VOID invoice still has no add row at all (its lines are set)", () => {
    const html = render({ status: "void" });
    expect(html).not.toContain('placeholder="Price"');
    expect(html).toContain("This invoice is void, so its lines are set.");
  });
});

describe("what a new line is still missing (the one rule the press and the line both read)", () => {
  it("no words: the ask, in the words the row says", () => {
    expect(addLineAsk("")).toBe("Type what this charge is for in the box above, then tap Add.");
    expect(addLineAsk("   ")).toBe("Type what this charge is for in the box above, then tap Add.");
  });

  it("words: nothing missing — the amount goes on, whatever it is", () => {
    expect(addLineAsk("Service call")).toBeNull();
    expect(addLineAsk(" Referral fee ")).toBeNull();
  });
});
