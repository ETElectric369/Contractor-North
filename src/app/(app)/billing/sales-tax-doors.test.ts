import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SALES TAX, THE SWITCH (0352, rule g), on the office's screens. What a person sees:
 *
 *  - no switches stored (every company today), or Sales Tax on: every tax field and tax row renders
 *    exactly as before (the render with the switch passed ON equals the render without it);
 *  - off: a NEW document shows no tax field and no "Tax $0.00" row, and the settings stop offering
 *    tax rates and the default rate;
 *  - off, on a document that already carries tax: its tax row and its field stay, so what it charges
 *    is on the screen and can still be changed;
 *  - the mileage rate (the Tax Report's deduction) is NOT sales tax and stays, whatever the switch.
 *
 * Windows are drawn open (Modal below renders its contents) so their fields can be read.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/billing",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: () => null,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("./actions", () => ({ createInvoiceFromQuote: vi.fn(), createBlankInvoice: vi.fn() }));
vi.mock("@/app/(app)/jobs/actions", () => ({ createInvoiceForJob: vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({}));
vi.mock("@/app/(app)/recurring/actions", () => ({ saveRecurring: vi.fn(), deleteRecurring: vi.fn() }));
vi.mock("@/app/(app)/settings/actions", () => ({}));
vi.mock("@/components/new-customer-inline", () => ({ NewCustomerInline: () => null }));

const { NewInvoiceButton, NewInvoicePickBody } = await import("./new-invoice-button");
const { showsTaxRate, routePick } = await import("./new-invoice-pick");
const { RecurringButton } = await import("@/app/(app)/recurring/recurring-button");
const { TaxRatesManager } = await import("@/app/(app)/settings/tax-rates-manager");
const { OrgSettingsForm } = await import("@/app/(app)/settings/org-settings-form");
const { taxFieldShown } = await import("@/lib/sales-tax-switch");
const { getOrgSettings } = await import("@/lib/org-settings");

const html = (el: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(el as any, props));

describe("the one rule (lib/sales-tax-switch)", () => {
  it("on: always shown; off: only on a document that carries tax", () => {
    expect(taxFieldShown(true)).toBe(true);
    expect(taxFieldShown(true, { tax_rate: 0, tax: 0 })).toBe(true);
    expect(taxFieldShown(false)).toBe(false);
    expect(taxFieldShown(false, { tax_rate: 0, tax: 0 })).toBe(false);
    expect(taxFieldShown(false, { tax_rate: 0.0825 })).toBe(true);
    expect(taxFieldShown(false, { tax_rate: 0, tax: 12.5 })).toBe(true);
    expect(taxFieldShown(false, { tax_rate: null, tax: null })).toBe(false);
  });
});

describe("New Invoice on /billing (W1-28: one question, Which Job Or Customer?)", () => {
  const props = { customers: [{ id: "c-tess", name: "Tess Zane" }], jobs: [{ id: "j-011", job_number: "J-011", name: "Thistlewood", customer_id: "c-tess", customer_name: "Tess Zane" }] };
  const body = (pick: { kind: "job" | "customer"; id: string; label: string } | null, salesTax: boolean) =>
    html(NewInvoicePickBody, {
      query: "",
      onQuery: () => {},
      rows: [],
      pick,
      onPick: () => {},
      onCustomerCreated: () => {},
      salesTax,
      taxRate: 0.0825,
      onTaxRate: () => {},
      refusal: null,
      onStartBlank: () => {},
    });
  const JOB = { kind: "job" as const, id: "j-011", label: "J-011 · Thistlewood · Tess Zane" };
  const CUSTOMER = { kind: "customer" as const, id: "c-tess", label: "Tess Zane" };

  it("no switches stored / on: the same form, and nothing to tax until something is picked", () => {
    const today = html(NewInvoiceButton, props);
    expect(html(NewInvoiceButton, { ...props, salesTax: true })).toBe(today);
    expect(today).toContain('id="inv-pick"');
    expect(today).not.toContain('id="inv-tax"');
  });

  it("a job pick with Sales Tax on shows the rate (seeded from the default); a customer pick too", () => {
    expect(showsTaxRate(JOB, true)).toBe(true);
    const job = body(JOB, true);
    expect(job).toContain('id="inv-tax"');
    expect(job).toContain('value="8.25"');
    expect(body(CUSTOMER, true)).toContain('id="inv-tax"');
    // The rate goes to the job's door only as the rate a NEW invoice starts at.
    expect(routePick(JOB, { salesTax: true, taxRate: 0.0825 })).toEqual({ action: "job", jobId: "j-011", taxRate: 0.0825 });
  });

  it("off: no tax field for either pick (so nothing seeds one: the invoice starts untaxed)", () => {
    expect(showsTaxRate(JOB, false)).toBe(false);
    for (const pick of [JOB, CUSTOMER]) {
      const off = body(pick, false);
      expect(off).not.toContain('id="inv-tax"');
      expect(off).not.toContain("Tax Rate");
    }
    expect(routePick(JOB, { salesTax: false, taxRate: 0.0825 })).toEqual({ action: "job", jobId: "j-011" });
    expect(routePick(CUSTOMER, { salesTax: false, taxRate: 0.0825 })).toEqual({ action: "customer", customerId: "c-tess", taxRate: 0 });
  });
});

describe("A repeat invoice", () => {
  const invoice = { id: "t1", kind: "invoice", title: "Service", frequency: "monthly", next_date: "2026-10-01", customer_id: null, description: null, amount: 100, category: null, vendor: null, line_items: null };
  const open = (p: Record<string, unknown>) => html(RecurringButton, { customers: [], ...p });
  it("on / not passed: the Tax (%) field, exactly as before", () => {
    expect(open({ template: { ...invoice, tax_rate: 0 }, salesTax: true })).toBe(open({ template: { ...invoice, tax_rate: 0 } }));
    expect(open({ template: { ...invoice, tax_rate: 0 } })).toContain('id="r-itax"');
  });
  it("off: an untaxed repeat invoice has no tax field; one that already carries tax keeps it", () => {
    expect(open({ template: { ...invoice, tax_rate: 0 }, salesTax: false })).not.toContain('id="r-itax"');
    expect(open({ template: { ...invoice, tax_rate: 0.0725 }, salesTax: false })).toContain('id="r-itax"');
  });
});

describe("Settings > Money: tax rates, and the mileage rate that is NOT sales tax", () => {
  const rates = [{ id: "r1", name: "County", rate: 8.25, is_default: true }];
  it("no switches stored: exactly today's card, tax rates and all", () => {
    const today = html(TaxRatesManager, { taxRates: rates, settings: getOrgSettings({}) });
    expect(html(TaxRatesManager, { taxRates: rates, settings: getOrgSettings({ features: { sales_tax: true } }) })).toBe(today);
    expect(today).toContain(">Tax rates<");
    expect(today).toContain("County");
  });
  it("off: no tax rates offered (the rows are kept), and the mileage rate is still there", () => {
    const off = html(TaxRatesManager, { taxRates: rates, settings: getOrgSettings({ features: { sales_tax: false } }) });
    expect(off).not.toContain(">Tax rates<");
    expect(off).not.toContain("County");
    expect(off).toContain('id="fin-mileage"');
    expect(off).toContain("Mileage rate ($/mi)");
  });
  it("Company details: the default tax rate field goes with the switch, and nothing else does", () => {
    const org = { id: "o1", name: "Fixture Co", default_tax_rate: 0.0825, settings: {} };
    const today = html(OrgSettingsForm, { org });
    expect(html(OrgSettingsForm, { org: { ...org, settings: { features: { sales_tax: true } } } })).toBe(today);
    expect(today).toContain('id="default_tax_pct"');
    const off = html(OrgSettingsForm, { org: { ...org, settings: { features: { sales_tax: false } } } });
    expect(off).not.toContain('id="default_tax_pct"');
    // Not drawn means not sent: updateOrganization writes only fields a form carries, so the stored
    // rate is left exactly as it is.
    expect(off).not.toContain('name="default_tax_pct"');
    expect(off).toContain('id="tax_number"');
  });
});
