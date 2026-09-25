import { describe, it, expect } from "vitest";
import { customerLineWords, customerLines, mergeSuppliesAndTax, supplierKey, supplierNameSet } from "@/lib/invoice-math";
import { billItemisation } from "@/lib/bill-itemisation";
import { returnCreditRows } from "@/lib/supplier-returns";
import { buildJobLedger } from "@/lib/portal/stretch-ledger";
import { shapePortalJob, type PortalJobRaw } from "@/lib/portal/job-view-shape";

/**
 * A CUSTOMER NEVER READS A SUPPLIER'S NAME (audit v994 PL1; the sanitize-on-read law).
 *
 * The rows the importer writes keep the office's words ("Materials — CED (bill #8802-…)"); every
 * customer door reads them through customerLineWords. The live cases are real ET rows.
 */
const CED = "Consolidated Electrical Distributors, Inc. (CED)";
const SUPPLIERS = supplierNameSet([CED, "The Home Depot", "Swigard's Hardware", "Consolidated Electrical Dist.", null, "  "]);
const costs = (description: string, extra: { import_key?: string | null; edited?: boolean } = {}) => ({
  description,
  import_source: "costs",
  ...extra,
});

describe("customerLineWords: the importer's own shapes lose the supplier", () => {
  it("a whole receipt billed as one amount, as the importer wrote it (untouched, keyed bill:<id>)", () => {
    expect(customerLineWords(costs(`Materials — ${CED} (bill #8802-1101363)`, { import_key: "bill:abc" }))).toBe("Materials");
    // Even with no supplier list and no bill number: the key says it is the lump.
    expect(customerLineWords(costs("Materials — Some New Supplier", { import_key: "bill:abc" }))).toBe("Materials");
  });

  it("an order (PO row) drops the vendor and the PO number", () => {
    expect(customerLineWords(costs("Materials — Home Depot (PO 1042)", { import_key: "po:9" }))).toBe("Materials");
    expect(customerLineWords(costs("Materials — Home Depot (PO 1042)", { import_key: null, edited: true }))).toBe("Materials");
  });

  it("the live legacy rows with no key (INV-00028) are caught by the org's supplier names", () => {
    expect(customerLineWords(costs("Materials — The Home Depot", { import_key: null, edited: true }), SUPPLIERS)).toBe("Materials");
    expect(customerLineWords(costs(`Materials — ${CED}`, { import_key: null, edited: true }), SUPPLIERS)).toBe("Materials");
    expect(customerLineWords(costs("Materials —   the  home depot ", { import_key: null }), SUPPLIERS)).toBe("Materials");
  });

  it("a receipt's remainder row is always Supplies & Tax (INV-074)", () => {
    expect(customerLineWords(costs(`Supplies & tax — ${CED}`, { import_key: "bill:abc:remainder" }))).toBe("Supplies & Tax");
    expect(customerLineWords(costs("Supplies & tax —"))).toBe("Supplies & Tax");
  });

  it("both return shapes lose the supplier too; a line-by-line return keeps its part", () => {
    expect(customerLineWords(costs(`Returned: other items — ${CED}`))).toBe("Returned: Other Items");
    expect(customerLineWords(costs(`Returned: materials — ${CED} (bill #8802-1)`, { import_key: "bill:r1" }))).toBe("Returned: Materials");
    expect(customerLineWords(costs("Returned: tax"))).toBe("Returned: tax");
    expect(customerLineWords(costs("Returned: 4 in LED Shallow IC HSG"))).toBe("Returned: 4 in LED Shallow IC HSG");
  });
});

describe("customerLineWords: the office's own words print as written", () => {
  it("a hand-typed line that happens to start with Materials is item text, not a supplier", () => {
    expect(customerLineWords({ description: "Materials — Ground rod", import_source: null }, SUPPLIERS)).toBe("Materials — Ground rod");
    expect(customerLineWords(costs("Materials — new dimmer switch", { import_key: null, edited: true }), SUPPLIERS)).toBe("Materials — new dimmer switch");
  });

  it("INV-060: the lump the office rewrote into the list of what was in the box keeps its list", () => {
    const list = "Materials — Assorted light bulbs, Signal wire - 100', 3A furnace fuses, New thermostat";
    expect(customerLineWords(costs(list, { import_key: "bill:5e1b", edited: true }), SUPPLIERS)).toBe(list);
  });

  it("labor and receipt parts are never touched", () => {
    expect(customerLineWords({ description: "Labor - Brian Taylor", import_source: "labor" }, SUPPLIERS)).toBe("Labor - Brian Taylor");
    expect(customerLineWords(costs("PANIS FV0511VF1 110CFM Fan", { import_key: "bli:1" }), SUPPLIERS)).toBe("PANIS FV0511VF1 110CFM Fan");
  });

  it("supplierKey is the SQL twin's expression: collapse, trim, lower", () => {
    expect(supplierKey("  The   Home\tDepot ")).toBe("the home depot");
    expect(supplierNameSet(["", null, " x "]).has("x")).toBe(true);
    expect(supplierNameSet(["", null]).size).toBe(0);
  });
});

describe("what the importer writes today never reaches a customer with the supplier's name", () => {
  const bill = { id: "b1", supplier: CED, bill_number: "8802-1101363", amount: 100 };

  it("a bill with no readable lines: the lump", () => {
    const rows = billItemisation(bill, [], 25);
    expect(rows.map((r) => r.description)).toEqual([`Materials — ${CED} (bill #8802-1101363)`]);
    const shown = customerLines(rows.map((r) => ({ ...r, import_source: "costs", edited: false })));
    expect(shown.map((r) => r.description)).toEqual(["Materials"]);
  });

  it("a supplier return credited as one amount, and as other items", () => {
    const ret = { id: "r1", supplier: CED, bill_number: "8802-1", amount: -50 };
    const rows = returnCreditRows(ret, [], 25);
    expect(rows.length).toBeGreaterThan(0);
    const shown = customerLines(rows.map((r) => ({ ...r, import_source: "costs", edited: false })));
    for (const r of shown) {
      expect(r.description).not.toMatch(/Consolidated|CED|8802/);
    }
  });

  it("the customer's copy keeps every cent: only words change", () => {
    const items = [
      { ...costs(`Materials — ${CED} (bill #1)`, { import_key: "bill:1" }), line_total: 125, quantity: 1, unit_price: 125 },
      { ...costs(`Supplies & tax — ${CED}`, { import_key: "bill:2:remainder" }), line_total: 7.5, quantity: 1, unit_price: 7.5 },
      { ...costs(`Supplies & tax — The Home Depot`, { import_key: "bill:3:remainder" }), line_total: 2.25, quantity: 1, unit_price: 2.25 },
    ];
    const shown = mergeSuppliesAndTax(customerLines(items, SUPPLIERS));
    expect(shown.map((r) => r.description)).toEqual(["Materials", "Supplies & Tax"]);
    expect(shown.reduce((s, r) => s + r.line_total * 100, 0)).toBe(items.reduce((s, r) => s + r.line_total * 100, 0));
  });
});

describe("the portal: ledger and bill both read the customer's words", () => {
  const raw = (): PortalJobRaw => ({
    scope: { org_id: "o", job_id: "j", customer_id: "c" },
    org: { name: "ET", logo_url: null, phone: null, email: null, license: null, brand_color: null, glass_tint: null, timezone: "America/Los_Angeles" },
    customer: { name: "J-002", company_name: null },
    job: { id: "j", name: "J-002", job_number: "J-002", status: "in_progress", address: null, unit: null, city: null, state: null, zip: null },
    billing: { billing_type: "tm", quote_statuses: [], milestones: 0 },
    stretches: [],
    invoices: [
      {
        id: "i1", invoice_number: "INV-00028", status: "draft", subtotal: 30, tax: 0, total: 30, amount_paid: 0,
        created_at: "2026-09-01T18:00:00Z", sent_at: null, public_token: null,
        doc: { invoice: {}, items: [{ description: `Materials — ${CED}`, import_source: "costs", line_total: 10 }, { description: `Returned: other items — ${CED}`, import_source: "costs", line_total: -2 }], payments: [], customer: null, site_candidates: [], org: null },
      } as never,
    ],
    lines: [
      { invoice_id: "i1", sort_order: 1, description: `Materials — ${CED}`, quantity: 1, unit: "lot", unit_price: 10, line_total: 10, import_source: "costs", sources: [] },
      { invoice_id: "i1", sort_order: 2, description: "Materials — Home Depot (PO 7)", quantity: 1, unit: "lot", unit_price: 22, line_total: 22, import_source: "costs", sources: [] },
      { invoice_id: "i1", sort_order: 3, description: `Returned: other items — ${CED}`, quantity: 1, unit: "ea", unit_price: -2, line_total: -2, import_source: "costs", sources: [] },
    ],
    payments: [],
    picks: [],
    photos: [],
  });

  it("with the org's names, no ledger row and no bill line names a supplier", () => {
    const v = shapePortalJob(raw(), { signed: new Map(), unbilled: null, now: new Date("2026-09-24T20:00:00Z"), suppliers: SUPPLIERS });
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/Consolidated|CED|Home Depot|PO 7/);
    expect(v.invoices[0].doc?.items.map((i) => i.description)).toEqual(["Materials", "Returned: Other Items"]);
  });

  it("the ledger alone (no names to hand) still scrubs every shape it can know by its words", () => {
    const r = raw();
    const ledger = buildJobLedger({ stretches: [], invoices: r.invoices as never, lines: [r.lines![1], r.lines![2]], payments: [], tz: "America/Los_Angeles" });
    expect(JSON.stringify(ledger)).not.toMatch(/Consolidated|CED|Home Depot|PO 7/);
  });
});
