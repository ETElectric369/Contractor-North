import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SETTINGS CARDS AND THE SWITCH BOARD (0352). A switched-off feature's card (or the fields inside a
 * shared card) is not drawn; what it holds stays stored, and with no switches stored every card is
 * exactly what it was. Sales Tax off never takes the mileage rate (the Tax Report's deduction).
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-key";
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  saveNumbering: vi.fn(),
  updateOrgSettings: vi.fn(),
  updateOrganization: vi.fn(),
  createTaxRate: vi.fn(),
  updateTaxRate: vi.fn(),
  setDefaultTaxRate: vi.fn(),
  deleteTaxRate: vi.fn(),
  createPricingLevel: vi.fn(),
  updatePricingLevel: vi.fn(),
  setDefaultPricingLevel: vi.fn(),
  deletePricingLevel: vi.fn(),
}));
vi.mock("./features-actions", () => ({ setFeature: vi.fn() }));
vi.mock("./push-actions", () => ({
  savePushSubscription: vi.fn(),
  removePushSubscription: vi.fn(),
  savePushPrefs: vi.fn(),
  saveDeviceToken: vi.fn(),
  removeDeviceToken: vi.fn(),
  myNotificationRole: vi.fn(async () => ({ ok: true, role: "owner" })),
}));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => false }));
vi.mock("@/lib/native-push", () => ({ registerForNativePush: vi.fn(), nativePushPermission: vi.fn() }));

import { NumberingSettings } from "./numbering-settings";
import { DocumentSettings } from "./document-settings";
import { TaxRatesManager } from "./tax-rates-manager";
import { SchedulingSettings } from "./scheduling-settings";
import { OrgSettingsForm } from "./org-settings-form";
import { PushSettings } from "./push-settings";
import { getOrgSettings } from "@/lib/org-settings";
import type { Organization } from "@/lib/types";

const r = (c: any, p: any) => renderToStaticMarkup(createElement(c, p));
const withOff = (...keys: string[]) => getOrgSettings({ features: Object.fromEntries(keys.map((k) => [k, false])) });
const ALL = getOrgSettings({});

describe("Numbering", () => {
  const props = { prefixes: {}, counters: null };
  it("everything on: every document type", () => {
    const html = r(NumberingSettings, props);
    for (const l of ["Jobs", "Estimates", "Invoices", "Work orders", "Change orders", "Purchase orders", "Contracts"]) expect(html).toContain(`>${l}<`);
  });
  it("a switched-off document type isn't drawn", () => {
    const html = r(NumberingSettings, { ...props, hiddenKeys: ["quote", "wo", "co", "po", "contract"] });
    for (const l of ["Estimates", "Work orders", "Change orders", "Purchase orders", "Contracts"]) expect(html).not.toContain(`>${l}<`);
    expect(html).toContain(">Jobs<");
    expect(html).toContain(">Invoices<");
  });
});

describe("Estimate & invoice defaults", () => {
  it("everything on: estimate, invoice and contract fields", () => {
    const html = r(DocumentSettings, { settings: ALL });
    expect(html).toContain("Estimate valid for (days)");
    expect(html).toContain("Default estimate terms");
    expect(html).toContain("Default contract terms");
  });
  it("Estimates off hides the estimate fields; Contracts off the contract terms; invoices and deposit stay", () => {
    const html = r(DocumentSettings, { settings: withOff("estimates", "contracts") });
    expect(html).not.toContain("Estimate valid for");
    expect(html).not.toContain("Default estimate terms");
    expect(html).not.toContain("Default contract terms");
    expect(html).toContain("Invoice due in (days)");
    expect(html).toContain("Default deposit (%)");
  });
});

describe("Tax, pricing & financial defaults", () => {
  it("everything on: the tax-rate list is there", () => {
    expect(r(TaxRatesManager, { taxRates: [], settings: ALL })).toContain(">Tax rates<");
  });
  it("Sales Tax off: no tax-rate list, and the mileage rate stays", () => {
    const html = r(TaxRatesManager, { taxRates: [{ id: "t", name: "Truckee", rate: 8.25, is_default: true }], settings: withOff("sales_tax") });
    expect(html).not.toContain(">Tax rates<");
    expect(html).not.toContain("Truckee");
    expect(html).toContain("Mileage rate ($/mi)");
    expect(html).toContain("Default labor rate ($/hr)");
  });
});

describe("Company details", () => {
  const org = { id: "o", name: "Co", default_tax_rate: 0.0825, settings: {} } as unknown as Organization;
  it("everything on: the default tax rate", () => {
    expect(r(OrgSettingsForm, { org })).toContain("Default tax rate %");
  });
  it("Sales Tax off: not drawn, so it isn't sent and the stored rate is kept", () => {
    const html = r(OrgSettingsForm, { org: { ...org, settings: { features: { sales_tax: false } } } });
    expect(html).not.toContain("default_tax_pct");
  });
});

describe("Scheduler & timesheets: the Payroll block", () => {
  it("drawn by default (as before) and gone when Crew & Payroll is off or quiet", () => {
    expect(r(SchedulingSettings, { settings: ALL, isOwner: true })).toContain("Pay period");
    const html = r(SchedulingSettings, { settings: ALL, isOwner: true, payroll: false });
    expect(html).not.toContain("Pay period");
    // The rest of the card, and the Job Codes switch, stay.
    expect(html).toContain("Geofence auto clock-out");
    expect(html).toContain("Ask the crew for job codes");
  });
});

describe("Push notifications", () => {
  it("everything on: the daily report row; Daily Reports off: gone, the rest stay", () => {
    expect(r(PushSettings, { initialPrefs: {}, role: "owner" })).toContain("Daily reports from crew leads");
    const html = r(PushSettings, { initialPrefs: {}, role: "owner", hiddenKeys: ["daily_report"] });
    expect(html).not.toContain("Daily reports from crew leads");
    expect(html).toContain("New inquiries / leads");
    expect(html).toContain("Quotes accepted by a customer");
  });
});
