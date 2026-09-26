import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SALES TAX, THE SWITCH (0352, rule g), on the two estimate screens.
 *
 *  - The new-estimate builder: no switches stored / on renders exactly as before (the default rate
 *    seeds it, the tax field and the Tax row are drawn). Off: no default seeds it, no tax field and
 *    no "Tax $0.00" row. An adopted draft that already carries tax keeps its rate, field and row.
 *  - A saved estimate: an untaxed one shows no tax row and no tax field while off; a taxed one keeps
 *    both, so its total still reads whole.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/quotes/new",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: () => null,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("./actions", () => ({
  saveQuote: vi.fn(),
  generateQuoteDraft: vi.fn(),
  generateQuoteDraftFromLeadPlans: vi.fn(),
  generateQuoteDraftFromPlan: vi.fn(),
  generateQuoteDraftFromSupplier: vi.fn(),
  addQuoteItem: vi.fn(),
  updateQuoteItem: vi.fn(),
  deleteQuoteItem: vi.fn(),
  updateQuoteMeta: vi.fn(),
}));
vi.mock("../price-list/actions", () => ({ applyPriceBookReview: vi.fn() }));
vi.mock("@/components/new-customer-inline", () => ({ NewCustomerInline: () => null }));

const { QuoteBuilder } = await import("./new/quote-builder");
const { QuoteItemsEditor } = await import("./[id]/quote-items-editor");

const RATES = [{ id: "r1", name: "County", rate: 8.25, is_default: true }];
const builder = (p: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(QuoteBuilder as any, { customers: [], taxRates: RATES, seededLines: [{ description: "Panel", quantity: 1, unit: "ea", unit_price: 1000 }], ...p }));
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the new-estimate builder", () => {
  it("no switches stored / on: exactly today's builder, seeded with the default rate", () => {
    const today = builder();
    expect(builder({ salesTax: true })).toBe(today);
    expect(today).toContain('id="tax"');
    expect(today).toMatch(/<option value="r1" selected="">County/);
    // $1,000 at 8.25%.
    expect(text(today)).toContain("Tax $82.50");
  });

  it("off: no default seeds it, no tax field, no Tax row; the total is the subtotal", () => {
    const off = builder({ salesTax: false });
    expect(off).not.toContain('id="tax"');
    expect(text(off)).not.toMatch(/\bTax \$/);
    expect(text(off)).toContain("Total $1,000.00");
  });

  it("off, adopting a draft that already carries tax: its rate, its field and its Tax row stay", () => {
    const off = builder({ salesTax: false, adoptedSeed: { taxRate: 0.05, items: [{ description: "Panel", quantity: 1, unit: "ea", unit_price: 1000 }] } });
    expect(off).toMatch(/<input[^>]*id="tax"[^>]*value="5"/);
    expect(text(off)).toContain("Tax $50.00");
  });
});

describe("a saved estimate", () => {
  const quote = { id: "q1", title: "Panel upgrade", notes: "", tax_rate: 0, tax: 0, subtotal: 1000, total: 1000, valid_until: null } as any;
  const editor = (q: any, p: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(QuoteItemsEditor, { quote: q, items: [], ...p }));

  it("no switches stored / on: exactly today's page, Tax row and Tax rate field", () => {
    const today = editor(quote);
    expect(editor(quote, { salesTax: true })).toBe(today);
    expect(text(today)).toContain("Tax (0.00%)");
    expect(today).toContain('id="qd-tax"');
  });

  it("off, untaxed: no Tax row and no tax field", () => {
    const off = editor(quote, { salesTax: false });
    expect(text(off)).not.toContain("Tax (");
    expect(off).not.toContain('id="qd-tax"');
    expect(off).toContain('id="qd-valid"');
  });

  it("off, already taxed: the Tax row and the field stay, the total is untouched", () => {
    const taxed = { ...quote, tax_rate: 0.0825, tax: 82.5, total: 1082.5 };
    const off = editor(taxed, { salesTax: false });
    expect(off).toBe(editor(taxed));
    expect(text(off)).toContain("Tax (8.25%)");
    expect(text(off)).toContain("$1,082.50");
  });
});
