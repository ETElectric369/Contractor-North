import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// reportError writes to error_events through the service client; here it only records.
const reported: string[] = [];
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void reported.push(where) }));

import {
  INVOICE_DOC_COLS,
  PUBLIC_INVOICE_STATUSES,
  readInvoiceDocumentProps,
  resolvePublicInvoice,
  type InvoiceDocRead,
} from "@/lib/invoice-document-props";
import { InvoiceDocument } from "@/components/invoice-document";
import { ProgressReportCard } from "@/components/progress-report-card";
import { accentHex } from "@/lib/org-settings";
import { progressBalanceRow } from "@/lib/invoice-math";

/**
 * ONE ASSEMBLY, THREE SURFACES (Erik, INV-080, 2026-09-25: "the preview pdf is formatted better, are
 * there two systems there?"). The print page reads as the signed-in office (RLS narrows every read
 * to the org); /i and the portal read as the service role, which sees EVERY org, pinned by hand to
 * the invoice's own. Given the same rows, both must hand InvoiceDocument the identical props, and
 * the service path must never pick up another org's row.
 *
 * The fixture is INV-080's shape (J-002, Time & Material, final, estimate $17,325, $16,527.30
 * received before it, this request $3,189.34), with a second org beside it holding rows that would
 * change the answer if any read leaked across.
 */

const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const OTHER = "99999999-9999-4999-8999-999999999999";
const INV = "332ec51f-2d97-478c-914a-cc5d5531bbdb";
const PRIOR = "11111111-1111-4111-8111-111111111111";
const JOB = "c71b250a-b2b8-449f-8368-32d5beb94ef2";
const CUST = "e3eb358b-975d-4df9-8368-b2a682ec25ed";
const ERIK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Rows = Record<string, Record<string, unknown>[]>;

const ROWS: Rows = {
  invoices: [
    {
      id: INV, org_id: ORG, job_id: JOB, customer_id: CUST, invoice_number: "INV-080", status: "sent", title: "Final invoice",
      description: "Patio heater project is complete.", notes: null, created_at: "2026-09-26T03:33:48Z", due_date: "2026-10-09",
      subtotal: 3189.34, tax_rate: 0, tax: 0, total: 3189.34, amount_paid: 0, invoice_kind: "final", public_token: "t".repeat(32),
      hold_reason: "INTERNAL HOLD NOTE",
    },
    { id: PRIOR, org_id: ORG, job_id: JOB, customer_id: CUST, invoice_number: "INV-079", status: "paid", total: 16527.3, amount_paid: 16527.3, invoice_kind: "progress" },
    // Another org's invoice on another job: a leak would change "Received to date".
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", org_id: OTHER, job_id: OTHER_JOB, customer_id: "x", invoice_number: "INV-001", status: "paid", total: 999, amount_paid: 999 },
  ],
  invoice_items: [
    { id: "i1", invoice_id: INV, org_id: ORG, sort_order: 0, description: "Labor - Erik Taylor", quantity: 13, unit: "hr", unit_price: 150, line_total: 1950, import_source: "labor", import_key: "labor:x", edited: false, line_kind: null, source_ids: ["secret-entry"] },
    { id: "i2", invoice_id: INV, org_id: ORG, sort_order: 1, description: "Materials — Consolidated Electrical Distributors", quantity: 1, unit: "lot", unit_price: 1229.69, line_total: 1229.69, import_source: "costs", import_key: "hand", edited: true, line_kind: null },
    // A name that is only ANOTHER org's supplier: it is the office's own words here and prints as written.
    { id: "i3", invoice_id: INV, org_id: ORG, sort_order: 2, description: "Materials — Acme Supply", quantity: 1, unit: "lot", unit_price: 9.65, line_total: 9.65, import_source: "costs", import_key: "hand", edited: true, line_kind: null },
  ],
  payments: [
    { id: "p0", invoice_id: PRIOR, org_id: ORG, amount: 16527.3, paid_at: "2026-09-20T18:00:00Z", method: "check", note: "check #1044 — call before depositing" },
  ],
  customers: [
    { id: CUST, org_id: ORG, name: "Tao Zhu", company_name: null, email: "tao@example.com", phone: "(708) 555-0100", address: "235 Timbercreek Ct", unit: null, city: "Reno", state: "NV", zip: "89511", notes: "INTERNAL CUSTOMER NOTE" },
  ],
  jobs: [
    {
      id: JOB, org_id: ORG, billing_type: "tm", address: "235 Timbercreek Court", unit: null, city: "Reno", state: "NV", zip: "89511",
      notes: "INTERNAL JOB NOTE", customers: { pricing_levels: null },
    },
    { id: OTHER_JOB, org_id: OTHER, billing_type: "fixed", customers: { pricing_levels: null } },
  ],
  organizations: [
    {
      id: ORG, name: "ET Electric", logo_url: null, address_line1: "PO Box 132", address_line2: null, city: "Chilcoot", state: "CA", zip: "96105",
      phone: "(530) 555-0199", email: "office@example.com", license: "CA C-10", doc_template: "classic", doc_templates: { invoice: "modern" },
      settings: {
        glass_tint: "#006d8f",
        doc_style: { density: "airy", col_gap: 12, margin_x: 0.5, margin_y: 0.5 },
        invoice_terms: "Payment Methods: Card, Check, Cash",
        document_footer: "",
        default_labor_rate: 95,
        material_markup_percent: 10,
        stripe_secret_hint: "NEVER ON A PAGE",
      },
    },
    { id: OTHER, name: "Another Org", settings: { glass_tint: "#ff0000", default_labor_rate: 1, material_markup_percent: 90 } },
  ],
  quotes: [
    { id: "q1", org_id: ORG, job_id: JOB, total: 17325, status: "accepted", created_at: "2026-08-01T00:00:00Z" },
    { id: "q2", org_id: OTHER, job_id: OTHER_JOB, total: 5, status: "accepted", created_at: "2026-08-01T00:00:00Z" },
  ],
  time_entries: [
    {
      id: "te1", org_id: ORG, job_id: JOB, status: "closed", clock_in: "2026-09-22T16:00:00Z", clock_out: "2026-09-22T18:00:00Z",
      lunch_minutes: 0, job_code: "SVC", profiles: { id: ERIK, full_name: "Erik Taylor" },
    },
  ],
  job_codes: [
    { org_id: ORG, code: "SHOP", billable: false },
    { org_id: OTHER, code: "SVC", billable: false },
  ],
  // The service role reads the table (customerRateRow drops the pay figure); the office reads the view.
  profiles: [
    { id: ERIK, org_id: ORG, role: "tech", hourly_rate: 40, bill_rate: 150 },
    { id: "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz", org_id: OTHER, role: "tech", hourly_rate: 1, bill_rate: 1 },
  ],
  profile_pay: [{ id: ERIK, org_id: ORG, hourly_rate: 40, bill_rate: 150 }],
  purchase_orders: [
    { id: "po1", org_id: ORG, job_id: JOB, total: 1000, status: "sent", vendor: "Consolidated Electrical Distributors" },
    { id: "po2", org_id: OTHER, job_id: OTHER_JOB, total: 1, status: "sent", vendor: "Acme Supply" },
  ],
  bills: [
    { id: "b1", org_id: ORG, job_id: JOB, amount: 200, po_id: null, created_at: "2026-09-10T00:00:00Z", supplier: "CED", superseded_by_bill_id: null, bill_line_items: [{ id: "bl1", description: "Wire", quantity: 1, unit_price: 200, amount: 200, category: null, billable: true, billed_amount: null }] },
    { id: "b2", org_id: OTHER, job_id: OTHER_JOB, amount: 1, po_id: null, supplier: "Acme Supply", superseded_by_bill_id: null, bill_line_items: [] },
  ],
  supplier_accounts: [{ org_id: ORG, name: "Consolidated Electrical Distributors" }],
  supplier_aliases: [{ org_id: ORG, alias: "C.E.D." }],
};

type Query = { table: string; select: string; filters: [string, string, unknown][] };

/**
 * A PostgREST-shaped client over plain rows: select / eq / is / in / order / limit / maybeSingle,
 * awaitable. `rls`: the rows a signed-in office member of ORG would see (every table narrowed to its
 * org, the way RLS does). `fail`: tables whose read answers with an error.
 */
function client(opts: { rls?: boolean; fail?: string[] } = {}) {
  const queries: Query[] = [];
  const from = (table: string) => {
    const q: Query = { table, select: "", filters: [] };
    queries.push(q);
    const rows = () => {
      let r = [...(ROWS[table] ?? [])];
      if (opts.rls) r = r.filter((x) => (table === "organizations" ? x.id === ORG : !("org_id" in x) || x.org_id === ORG));
      for (const [op, col, val] of q.filters) {
        if (op === "eq") r = r.filter((x) => x[col] === val);
        if (op === "is") r = r.filter((x) => (x[col] ?? null) === val);
        if (op === "in") r = r.filter((x) => (val as unknown[]).includes(x[col]));
      }
      // PostgREST returns the columns named, no more (an embed returns its row whole here).
      const cols = q.select.split(",").map((c) => c.trim()).filter(Boolean);
      if (!q.select.includes("(") && !cols.includes("*")) r = r.map((x) => Object.fromEntries(cols.filter((c) => c in x).map((c) => [c, x[c]])));
      return r;
    };
    // "table" fails every read of it; "table:words" only the read whose select names those words.
    const failed = () =>
      (opts.fail ?? []).some((f) => {
        const [t, words] = f.split(":");
        return t === table && (!words || q.select.includes(words));
      });
    const b: any = {
      select: (cols: string) => ((q.select = cols), b),
      eq: (col: string, val: unknown) => (q.filters.push(["eq", col, val]), b),
      is: (col: string, val: unknown) => (q.filters.push(["is", col, val]), b),
      in: (col: string, val: unknown[]) => (q.filters.push(["in", col, val]), b),
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        if (failed()) return { data: null, error: { message: `${table} read failed` } };
        const r = rows();
        return r.length > 1 ? { data: null, error: { message: "multiple rows" } } : { data: r[0] ?? null, error: null };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(failed() ? { data: null, error: { message: `${table} read failed` } } : { data: rows(), error: null }).then(ok, bad),
    };
    return b;
  };
  return { from, queries };
}

const ok = (r: InvoiceDocRead) => {
  if (r.kind !== "ok") throw new Error(`expected a document, got ${r.kind}`);
  return r.props;
};

beforeEach(() => {
  reported.length = 0;
});

describe("the print path and the public path build the same props", () => {
  it("the office (RLS) and the service role (pinned by hand, every org visible) agree exactly", async () => {
    const staff = ok(await readInvoiceDocumentProps(client({ rls: true }), INV, { kind: "staff" }));
    const pub = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    const portal = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG, jobId: JOB }));
    expect(pub).toEqual(staff);
    expect(portal).toEqual(staff);
    expect(reported).toEqual([]);
  });

  it("every service read is pinned to the invoice's own org", async () => {
    const db = client();
    ok(await readInvoiceDocumentProps(db, INV, { kind: "service", orgId: ORG }));
    for (const q of db.queries) {
      // The two pricing-level lookups read ONE job by its id, which the invoice read already
      // proved is this org's (the same as unbilledWorkForJob's service path).
      if (/pricing_levels/.test(q.select)) {
        expect(q.filters).toContainEqual(["eq", "id", JOB]);
        continue;
      }
      const pinned = q.filters.some(([op, col, val]) => op === "eq" && ((col === "org_id" && val === ORG) || (q.table === "organizations" && col === "id" && val === ORG)));
      expect(pinned, `${q.table} (${q.select})`).toBe(true);
    }
  });

  it("the office's read is the same shape (org-pinned where the invoice names its org)", async () => {
    const db = client({ rls: true });
    ok(await readInvoiceDocumentProps(db, INV, { kind: "staff" }));
    const tables = new Set(db.queries.map((q) => q.table));
    for (const t of ["invoices", "invoice_items", "payments", "customers", "jobs", "organizations", "quotes", "time_entries", "profile_pay", "bills", "purchase_orders"]) {
      expect(tables.has(t), t).toBe(true);
    }
    // The office reads the rates view, never the table (its hourly column is revoked).
    expect(tables.has("profiles")).toBe(false);
  });
});

describe("what INV-080 now carries on every surface", () => {
  it("the org's tint, the layout knobs, the customer's phone and email, the Progress Summary", async () => {
    const p = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    expect(p.co.brand).toBe(accentHex("#006d8f"));
    expect(p.co.brand).not.toBe(accentHex(null));
    expect(p.template).toBe("modern");
    expect(p.docStyle).toMatchObject({ density: "airy", col_gap: 12 });
    expect(p.customer).toMatchObject({ name: "Tao Zhu", phone: "(708) 555-0100", email: "tao@example.com" });
    expect(p.billingLabel).toBe("Time & Material · Final Payment");
    expect(p.site).toMatchObject({ address: "235 Timbercreek Court", source: "job" });
    expect(p.terms).toBe("Payment Methods: Card, Check, Cash");
    expect(p.documentFooter).toBeNull();
    expect(p.invoiceKind).toBe("final");
    expect(p.progress).toMatchObject({ estimate: 17325, received: 16527.3, thisAmount: 3189.34, billingType: "tm" });
    // Work to date: 2 h × $150 + the $200 receipt and the $1,000 order, each marked up 10%, all ORG's.
    expect(p.progress!.workToDate).toBe(1620);
  });

  it("never carries a settings object, a note, a pay rate, an internal id or another org's row", async () => {
    const p = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    const json = JSON.stringify(p, (_k, v) => (v instanceof Set ? [...v] : v));
    for (const banned of ["stripe_secret_hint", "NEVER ON A PAGE", "INTERNAL", "check #1044", "source_ids", "secret-entry", "hourly", "import_key", ORG, OTHER, CUST, JOB, "Another Org", "#ff0000"]) {
      expect(json, banned).not.toContain(banned);
    }
    // The payment list is this invoice's own (none yet); the prior bill's payment is in Received.
    expect(p.payments).toEqual([]);
  });

  it("the lines are already the customer's words: this org's supplier scrubbed, another org's name left as typed", async () => {
    const p = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    expect(p.items.map((i) => i.description)).toEqual(["Labor - Erik Taylor", "Materials", "Materials — Acme Supply"]);
  });

  it("renders as the PDF does: tinted header, contact under Bill To, and 'Billed over the estimate' in words", async () => {
    const p = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    const html = renderToStaticMarkup(createElement(InvoiceDocument, p));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    expect(html).toContain(accentHex("#006d8f"));
    expect(text).toContain("(708) 555-0100");
    expect(text).toContain("tao@example.com");
    expect(text).toContain("Progress summary");
    // 17,325 − 16,527.30 − 3,189.34 = −2,391.64: said in words, never as a negative.
    expect(text).toContain("Billed over the estimate $2,391.64");
    expect(text).not.toContain("-$2,391.64");
    expect(text).not.toContain("Balance to estimate");
    expect(text).not.toMatch(/Consolidated/);
    // Airy rows (py-3) and the 12px column gap from the org's doc_style.
    expect(html).toContain("py-3 pr-2");
    expect(html).toContain("padding-left:12px");
  });
});

describe("a read that fails degrades honestly", () => {
  it("the lines, the org or the supplier names: no document at all, logged", async () => {
    for (const [table, where] of [
      ["invoice_items", "invoiceDoc.items"],
      ["organizations", "invoiceDoc.org"],
      ["supplier_aliases", "invoiceDoc.supplierNames"],
    ] as const) {
      reported.length = 0;
      const r = await readInvoiceDocumentProps(client({ fail: [table] }), INV, { kind: "service", orgId: ORG });
      expect(r.kind, table).toBe("error");
      expect(reported).toContain(where);
    }
  });

  it("payments: the list is left off, Amount Paid still from the invoice row", async () => {
    const p = ok(await readInvoiceDocumentProps(client({ fail: ["payments"] }), INV, { kind: "service", orgId: ORG }));
    expect(p.payments).toEqual([]);
    expect(p.amountPaid).toBe(0);
    expect(reported).toContain("invoiceDoc.payments");
  });

  it("the customer: no Bill To contact, never someone else's", async () => {
    const p = ok(await readInvoiceDocumentProps(client({ fail: ["customers"] }), INV, { kind: "service", orgId: ORG }));
    expect(p.customer).toBeNull();
    expect(reported).toContain("invoiceDoc.customer");
  });

  it("the job: no site and no progress (never the customer's address as the job site), the stage alone", async () => {
    const p = ok(await readInvoiceDocumentProps(client({ fail: ["jobs"] }), INV, { kind: "service", orgId: ORG }));
    expect(p.site).toBeNull();
    expect(p.progress).toBeNull();
    expect(p.billingLabel).toBe("Final Payment");
    expect(reported).toContain("invoiceDoc.job");
  });

  it("the progress figures: the summary is left off, the bill is whole", async () => {
    // readJobBillsWithLines' error throws inside jobProgressFinancials by design.
    const p = ok(await readInvoiceDocumentProps(client({ fail: ["bills:bill_line_items"] }), INV, { kind: "service", orgId: ORG }));
    expect(p.progress).toBeNull();
    expect(p.items).toHaveLength(3);
    expect(reported).toContain("invoiceDoc.progress");
  });

  it("a piece left off is named (degraded), so the stored PDF can refuse it; a whole read names none", async () => {
    const whole = await readInvoiceDocumentProps(client(), INV, { kind: "staff" });
    expect(whole.kind === "ok" && whole.degraded).toEqual([]);
    for (const [fail, piece] of [
      ["payments", "payments"],
      ["customers", "customer"],
      ["jobs", "job"],
      ["bills:bill_line_items", "progress"],
    ] as const) {
      const r = await readInvoiceDocumentProps(client({ fail: [fail] }), INV, { kind: "staff" });
      expect(r.kind === "ok" && r.degraded, fail).toEqual([piece]);
    }
  });

  it("the print page (the stored customer copy) throws on a degraded read, so /api/pdf stores nothing", () => {
    const src = readFileSync(join(process.cwd(), "src/app/print/invoice/[id]/page.tsx"), "utf8");
    expect(src).toMatch(/if \(read\.degraded\.length > 0\) \{\s*throw new Error/);
  });

  it("another org's invoice, a job the portal did not name, or a non-id is simply not there", async () => {
    expect((await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: OTHER })).kind).toBe("missing");
    expect((await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG, jobId: OTHER_JOB })).kind).toBe("missing");
    expect((await readInvoiceDocumentProps(client(), "../etc", { kind: "staff" })).kind).toBe("missing");
  });
});

describe("the /i link resolves its invoice the way public_invoice gates it", () => {
  it("a sent bill opens; a draft or void bill's token does not", async () => {
    expect(await resolvePublicInvoice(client(), "t".repeat(32))).toEqual({ kind: "ok", invoiceId: INV, orgId: ORG });
    ROWS.invoices[0].status = "draft";
    try {
      expect((await resolvePublicInvoice(client(), "t".repeat(32))).kind).toBe("missing");
    } finally {
      ROWS.invoices[0].status = "sent";
    }
    expect([...PUBLIC_INVOICE_STATUSES]).toEqual(["sent", "partial", "paid", "overdue"]);
    expect((await resolvePublicInvoice(client(), "")).kind).toBe("missing");
  });

  it("the columns it reads are the customer's copy's and nothing more", () => {
    expect(INVOICE_DOC_COLS.payments).not.toMatch(/note|stripe|fee|recorded/);
    expect(INVOICE_DOC_COLS.items).not.toMatch(/source_ids|cost/);
    expect(INVOICE_DOC_COLS.invoice).not.toMatch(/hold|qbo|token|dismissed/);
    expect(INVOICE_DOC_COLS.customer).not.toMatch(/notes|portal_token|pricing/);
  });
});

describe("a progress balance never prints as a negative", () => {
  it("T&M over the estimate / fixed-price over the contract, each the positive amount", () => {
    expect(progressBalanceRow(-2391.64, "tm")).toEqual({ label: "Billed over the estimate", value: 2391.64 });
    expect(progressBalanceRow(-500, "fixed")).toEqual({ label: "Billed over the contract", value: 500 });
    expect(progressBalanceRow(1325, "tm")).toEqual({ label: "Balance to estimate", value: 1325 });
    expect(progressBalanceRow(1325, "fixed")).toEqual({ label: "Balance remaining", value: 1325 });
    expect(progressBalanceRow(-0.001, "tm")).toEqual({ label: "Balance to estimate", value: 0 });
  });

  it("the card says it in words", () => {
    const fixed = renderToStaticMarkup(createElement(ProgressReportCard, { estimate: 10000, workToDate: 10500, received: 8000, thisAmount: 2500, billingType: "fixed" }));
    expect(fixed).toContain("Billed over the contract");
    expect(fixed).toContain("$500.00");
    expect(fixed).not.toContain("-$");
  });

  it("INV-080: the billed overage is named as billed, so it never reads as a second, different work overage", () => {
    // Estimate 17,325; work to date 18,624.14 (107%, $1,299.14 of work past it); received
    // 16,527.30 + this request 3,189.34 = 19,716.64, which is $2,391.64 BILLED past it.
    const html = renderToStaticMarkup(
      createElement(ProgressReportCard, { estimate: 17325, workToDate: 18624.14, received: 16527.3, thisAmount: 3189.34, billingType: "tm" }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    expect(text).toContain("$18,624.14");
    expect(text).toContain("Billed over the estimate $2,391.64");
    expect(text).not.toMatch(/(^|[^d] )Over the estimate/);
    expect(text).not.toContain("-$");
  });
});
