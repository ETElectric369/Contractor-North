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
  assembleInvoiceDocumentProps,
  readInvoiceDocumentProps,
  resolvePublicInvoice,
  type InvoiceDocAccess,
  type InvoiceDocInputs,
  type InvoiceDocRead,
} from "@/lib/invoice-document-props";
import { pickSite } from "@/lib/site-address";
import { CUSTOMER_VISIBLE_STATUSES } from "@/lib/customer-visible-docs";
import { InvoiceDocument } from "@/components/invoice-document";
import { ProgressReportCard } from "@/components/progress-report-card";
import { accentHex } from "@/lib/org-settings";
import { progressBalanceRow, totalToEstimateRow } from "@/lib/invoice-math";

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
    { id: PRIOR, org_id: ORG, job_id: JOB, customer_id: CUST, invoice_number: "INV-079", status: "paid", total: 16527.3, amount_paid: 16527.3, invoice_kind: "progress", created_at: "2026-06-30T18:00:00Z" },
    // Another org's invoice on another job: a leak would change "Received to date".
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", org_id: OTHER, job_id: OTHER_JOB, customer_id: "x", invoice_number: "INV-001", status: "paid", total: 999, amount_paid: 999 },
  ],
  invoice_items: [
    { id: "i1", invoice_id: INV, org_id: ORG, sort_order: 0, description: "Labor - Erik Taylor", quantity: 13, unit: "hr", unit_price: 150, line_total: 1950, import_source: "labor", import_key: "labor:x", edited: false, line_kind: null, source_ids: ["secret-entry"] },
    { id: "i2", invoice_id: INV, org_id: ORG, sort_order: 1, description: "Materials — Consolidated Electrical Distributors", quantity: 1, unit: "lot", unit_price: 1229.69, line_total: 1229.69, import_source: "costs", import_key: "hand", edited: true, line_kind: null },
    // A name that is only ANOTHER org's supplier: it is the office's own words here and prints as written.
    { id: "i3", invoice_id: INV, org_id: ORG, sort_order: 2, description: "Materials — Acme Supply", quantity: 1, unit: "lot", unit_price: 9.65, line_total: 9.65, import_source: "costs", import_key: "hand", edited: true, line_kind: null },
    // INV-079's own work, billed at June's prices: work to date counts it at the price it went out at.
    { id: "p1", invoice_id: PRIOR, org_id: ORG, sort_order: 0, description: "Labor - Erik Taylor", quantity: 75.5, unit: "hr", unit_price: 150, line_total: 11325, import_source: "labor", import_key: "labor:x", edited: false, line_kind: null, source_ids: ["june-entry"] },
    { id: "p2", invoice_id: PRIOR, org_id: ORG, sort_order: 1, description: "Materials — Consolidated Electrical Distributors", quantity: 1, unit: "lot", unit_price: 5202.3, line_total: 5202.3, import_source: "costs", import_key: "hand", edited: true, line_kind: null },
  ],
  payments: [
    { id: "p0", invoice_id: PRIOR, org_id: ORG, amount: 16527.3, paid_at: "2026-09-20T18:00:00Z", method: "check", note: "check #1044 — call before depositing" },
  ],
  customers: [
    { id: CUST, org_id: ORG, name: "Tess Zane", company_name: null, email: "tess@example.com", phone: "(708) 555-0100", address: "235 Thistlewood Ct", unit: null, city: "Reno", state: "NV", zip: "89511", notes: "INTERNAL CUSTOMER NOTE" },
  ],
  jobs: [
    {
      id: JOB, org_id: ORG, billing_type: "tm", address: "235 Thistlewood Court", unit: null, city: "Reno", state: "NV", zip: "89511",
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

type Query = { table: string; select: string; filters: [string, string, unknown][]; range?: [number, number] };

/** A row as PostgREST hands it back for a select with one embed: the columns named, of the row and
 *  of the row it embeds, and no others. */
function named(select: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Split on the commas that are not inside the embed's parentheses.
  for (const part of select.split(/,(?![^()]*\))/).map((p) => p.trim()).filter(Boolean)) {
    const embed = /^(\w+)\((.*)\)$/.exec(part);
    if (!embed) {
      if (part in row) out[part] = row[part];
      continue;
    }
    const inner = row[embed[1]] as Record<string, unknown> | null | undefined;
    out[embed[1]] = inner ? Object.fromEntries(embed[2].split(",").map((c) => c.trim()).filter((c) => c in inner).map((c) => [c, inner[c]])) : null;
  }
  return out;
}

/**
 * A PostgREST-shaped client over plain rows: select / eq / is / in / order / limit / maybeSingle,
 * awaitable. `rls`: the rows a signed-in office member of ORG would see (every table narrowed to its
 * org, the way RLS does). `fail`: tables whose read answers with an error. `rows`: another world than
 * ROWS (the bill made from an estimate, cn-v1160). `whole`: the estimate read comes back with every
 * column the rows hold, as if somebody had widened its select.
 */
function client(opts: { rls?: boolean; fail?: string[]; rows?: Rows; whole?: boolean } = {}) {
  const queries: Query[] = [];
  const all = opts.rows ?? ROWS;
  /** What this reader may see of a table: everything for the service role, its own org's rows under RLS. */
  const seen = (t: string) => (x: Record<string, unknown>) =>
    !opts.rls || (t === "organizations" ? x.id === ORG : !("org_id" in x) || x.org_id === ORG);
  const from = (table: string) => {
    const q: Query = { table, select: "", filters: [] };
    queries.push(q);
    const rows = () => {
      let r = [...(all[table] ?? [])].filter(seen(table));
      // The two embeds the money readers use: an invoice's lines, and a line's invoice.
      if (table === "invoices" && q.select.includes("invoice_items(")) {
        r = r.map((x) => ({ ...x, invoice_items: (all.invoice_items ?? []).filter((it) => it.invoice_id === x.id) }));
      }
      if (table === "invoice_items" && q.select.includes("invoices!inner(")) {
        r = r.map((x) => ({ ...x, invoices: (all.invoices ?? []).find((i) => i.id === x.invoice_id) ?? null })).filter((x) => x.invoices);
      }
      // THE ESTIMATE A BILL WAS MADE FROM, WITH ITS LEAD (cn-v1160): embedded the way PostgREST embeds
      // a to-one row. The lead is one this reader may see (RLS for the office; the service role sees
      // every company's), narrowed by any filter on the embedded row itself: "inquiries.org_id" nulls
      // the EMBED when it does not hold, and never drops the estimate.
      const withLead = table === "quotes" && q.select.includes("inquiries(");
      const onLead = (op: string, col: string) => withLead && op === "eq" && col.startsWith("inquiries.");
      if (withLead) {
        const leads = (all.inquiries ?? []).filter(seen("inquiries"));
        const asked = q.filters.filter(([op, col]) => onLead(op, col));
        r = r.map((x) => ({
          ...x,
          inquiries: leads.find((l) => l.id === x.inquiry_id && asked.every(([, col, val]) => l[col.slice("inquiries.".length)] === val)) ?? null,
        }));
      }
      const at = (x: Record<string, unknown>, col: string): unknown =>
        col.includes(".") ? (x[col.split(".")[0]] as Record<string, unknown> | null)?.[col.split(".")[1]] : x[col];
      for (const [op, col, val] of q.filters) {
        if (op === "eq" && !onLead(op, col)) r = r.filter((x) => x[col] === val);
        if (op === "neq") r = r.filter((x) => at(x, col) !== val);
        if (op === "overlaps") r = r.filter((x) => ((x[col] as unknown[] | undefined) ?? []).some((v) => (val as unknown[]).includes(v)));
        if (op === "is") r = r.filter((x) => (x[col] ?? null) === val);
        if (op === "in") r = r.filter((x) => (val as unknown[]).includes(x[col]));
      }
      // PostgREST returns the columns named, no more (an embed returns its row whole here, except
      // the estimate's lead, which is cut to the columns named unless `whole` says otherwise).
      const cols = q.select.split(",").map((c) => c.trim()).filter(Boolean);
      if (withLead && !opts.whole) r = r.map((x) => named(q.select, x));
      else if (!q.select.includes("(") && !cols.includes("*")) r = r.map((x) => Object.fromEntries(cols.filter((c) => c in x).map((c) => [c, x[c]])));
      if (q.range) r = r.slice(q.range[0], q.range[1] + 1);
      return r;
    };
    // "table" fails every read of it; "table:words" only the read whose select names those words;
    // "table=select" only the read whose select is exactly that.
    const failed = () =>
      (opts.fail ?? []).some((f) => {
        if (f.includes("=")) {
          const [t, exact] = f.split("=");
          return t === table && q.select === exact;
        }
        const [t, words] = f.split(":");
        return t === table && (!words || q.select.includes(words));
      });
    const b: any = {
      select: (cols: string) => ((q.select = cols), b),
      eq: (col: string, val: unknown) => (q.filters.push(["eq", col, val]), b),
      is: (col: string, val: unknown) => (q.filters.push(["is", col, val]), b),
      in: (col: string, val: unknown[]) => (q.filters.push(["in", col, val]), b),
      neq: (col: string, val: unknown) => (q.filters.push(["neq", col, val]), b),
      overlaps: (col: string, val: unknown[]) => (q.filters.push(["overlaps", col, val]), b),
      order: () => b,
      range: (from: number, to: number) => ((q.range = [from, to]), b),
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
    expect(p.customer).toMatchObject({ name: "Tess Zane", phone: "(708) 555-0100", email: "tess@example.com" });
    expect(p.billingLabel).toBe("Time & Material · Final Payment");
    expect(p.site).toMatchObject({ address: "235 Thistlewood Court", source: "job" });
    expect(p.terms).toBe("Payment Methods: Card, Check, Cash");
    expect(p.documentFooter).toBeNull();
    expect(p.invoiceKind).toBe("final");
    expect(p.progress).toMatchObject({ estimate: 17325, received: 16527.3, thisAmount: 3189.34, billingType: "tm" });
    // Work to date on Time & Material = what was billed, at the price billed (INV-079's 16,527.30 and
    // this bill's 3,189.34), plus what the next bill would charge: the 2 h no line claims × $150 and
    // the $200 receipt and $1,000 order no line claims, each marked up 10% = 1,620. All ORG's.
    expect(p.progress!.workToDate).toBe(21336.64);
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

  it("renders as the PDF does: tinted header, contact under Bill To, and 'Total to estimate' in words", async () => {
    const p = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    const html = renderToStaticMarkup(createElement(InvoiceDocument, p));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    expect(html).toContain(accentHex("#006d8f"));
    expect(text).toContain("(708) 555-0100");
    expect(text).toContain("tess@example.com");
    expect(text).toContain("Progress summary");
    // Work to date 21,336.64 (billed 19,716.64 + 1,620 not on a bill yet) − 17,325: in words, never a negative.
    expect(text).toContain("Total to estimate $4,011.64 over");
    expect(text).not.toContain("-$");
    expect(text).not.toContain("Balance to estimate");
    expect(text).not.toMatch(/Consolidated/);
    // Airy rows (py-3) and the 12px column gap from the org's doc_style.
    expect(html).toContain("py-3 pr-2");
    expect(html).toContain("padding-left:12px");
  });

  // THE BILLING-TYPE LINE IS THE COMPANY'S CALL (cn-v1152). Erik, 2026-11-07, on a bill he had retitled
  // "Kitchen lighting": the "Time & Material · Progress Payment" line over it "only needs to be there if its
  // carrying new and needed information". doc_style.show_billing_type, on by default, so INV-080 is unchanged;
  // off, the chip is gone and the title takes its place (mt-5, the margin a bill with no label always had).
  it("the billing-type line: drawn by default, left off when the company's doc_style says so, the title moving up", async () => {
    const p = ok(await readInvoiceDocumentProps(client(), INV, { kind: "service", orgId: ORG }));
    const titled = { ...p, title: "Kitchen Lighting" };
    const chip = ">Time &amp; Material · Final Payment</span>";

    const on = renderToStaticMarkup(createElement(InvoiceDocument, titled));
    expect(on).toContain(chip);
    expect(on).toContain('class="mt-3 text-base font-semibold text-slate-900">Kitchen Lighting</div>');

    const style = { ...(p.docStyle as Record<string, unknown>), show_billing_type: false };
    const off = renderToStaticMarkup(createElement(InvoiceDocument, { ...titled, docStyle: style }));
    expect(off).not.toContain(chip);
    expect(off).not.toContain("Final Payment");
    expect(off).toContain('class="mt-5 text-base font-semibold text-slate-900">Kitchen Lighting</div>');
    // Nothing else about the paper moves: same figures, same Progress Summary, same rows.
    const words = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    expect(words(off)).toBe(words(on).replace(" Time & Material · Final Payment", ""));
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

  it("the billed lines behind a T&M work to date: a lost read leaves the summary off, never a figure missing its billed half", async () => {
    const p = ok(await readInvoiceDocumentProps(client({ fail: ["invoices:line_kind"] }), INV, { kind: "service", orgId: ORG }));
    expect(p.progress).toBeNull();
    expect(p.items).toHaveLength(3);
    expect(reported).toContain("invoiceDoc.progress");
  });

  it("any read behind the Progress Summary that fails leaves it off, never a figure built from an empty read (audit v1018 money-1)", async () => {
    // Each of these used to read as empty: "Received to date $0.00" (invoices), a fixed-price
    // contract on a T&M job (the job), no estimate (quotes), no orders, the default rates (org).
    for (const fail of ["jobs=billing_type", "quotes", "invoices:total, status, amount_paid", "purchase_orders:id, total, status", "organizations=settings"]) {
      reported.length = 0;
      for (const access of [{ kind: "staff" } as const, { kind: "service", orgId: ORG } as const]) {
        const r = await readInvoiceDocumentProps(client({ rls: access.kind === "staff", fail: [fail] }), INV, access);
        expect(r.kind, fail).toBe("ok");
        if (r.kind !== "ok") continue;
        expect(r.props.progress, fail).toBeNull();
        expect(r.degraded, fail).toEqual(["progress"]);
        expect(r.props.items, fail).toHaveLength(3);
      }
      expect(reported, fail).toContain("invoiceDoc.progress");
    }
  });

  it("jobProgressFinancials itself throws on each of those reads (the job page and Nort say so too)", async () => {
    const { jobProgressFinancials } = await import("@/lib/job-financials");
    await expect(jobProgressFinancials(client({ rls: true }), JOB)).resolves.toMatchObject({ estimate: 17325, billingType: "tm" });
    for (const fail of ["jobs=billing_type", "quotes", "invoices:total, status, amount_paid", "purchase_orders:id, total, status", "organizations=settings"]) {
      await expect(jobProgressFinancials(client({ rls: true, fail: [fail] }), JOB), fail).rejects.toMatchObject({ message: expect.stringContaining("read failed") });
    }
  });

  it("the /i page says part of the bill couldn't load when a piece was left off, with a 44px Try Again", () => {
    const src = readFileSync(join(process.cwd(), "src/app/i/[token]/page.tsx"), "utf8");
    expect(src).toMatch(/doc\.degraded\.length > 0 &&/);
    expect(src).toContain("Part of this bill couldn&apos;t load just now.");
    expect(src).toMatch(/href=\{`\/i\/\$\{token\}`\} className="inline-flex min-h-\[44px\][^"]*"\s*>\s*Try Again/);
  });

  it("a piece left off is named (degraded), so the stored PDF can refuse it; a whole read names none", async () => {
    // The office reads through RLS (one org row: organizations_select is its own org). Without it the
    // progress read's "the organization" read finds two orgs and, rightly now, says it failed.
    const whole = await readInvoiceDocumentProps(client({ rls: true }), INV, { kind: "staff" });
    expect(whole.kind === "ok" && whole.degraded).toEqual([]);
    for (const [fail, pieces] of [
      ["payments", ["payments"]],
      ["customers", ["customer"]],
      // The progress figures read the job too, so a lost job read names both.
      ["jobs", ["job", "progress"]],
      ["bills:bill_line_items", ["progress"]],
    ] as const) {
      const r = await readInvoiceDocumentProps(client({ rls: true, fail: [fail] }), INV, { kind: "staff" });
      expect(r.kind === "ok" && r.degraded, fail).toEqual(pieces);
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

/**
 * A BILL MADE FROM AN ESTIMATE PRINTS THE PLACE THE ESTIMATE PRINTS (cn-v1160, skeptic #61). An
 * invoice owns no address. It printed its job's, else the customer's own, so a bill made straight
 * from an estimate that never became a job said "Job site: <where the customer lives>" while the
 * estimate it came from said the building the work is in. The order is one rule now
 * (lib/quote-site bornFromEstimateCandidates): the job's, the source estimate's own, that
 * estimate's lead's, the customer's. Every name and street here is invented.
 */
const BILL = "d1111111-1111-4111-8111-111111111111";
const BILL_JOB = "d2222222-2222-4222-8222-222222222222";
const BILL_CUST = "d3333333-3333-4333-8333-333333333333";
const EST = "d4444444-4444-4444-8444-444444444444";
const LEAD = "d5555555-5555-4555-8555-555555555555";

const PLACES = {
  job: { address: "9 Bayberry Lane", unit: null, city: "Testville", state: "CA", zip: "96161" },
  quote: { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" },
  lead: { address: "16 Larkspur Circle", unit: null, city: "Testville", state: "CA", zip: "96161" },
  customer: { address: "12 Thistlewood Way", unit: null, city: "Testville", state: "CA", zip: "96161" },
} as const;
const NOWHERE = { address: null, unit: null, city: null, state: null, zip: null };
type Who = keyof typeof PLACES;
type Has = Record<Who, boolean>;
const ORDER: readonly Who[] = ["job", "quote", "lead", "customer"];
const EVERYWHERE: Has = { job: true, quote: true, lead: true, customer: true };
/** The skeptic's bill: no address on the job, the estimate priced a second building. */
const NO_JOB_ADDRESS: Has = { job: false, quote: true, lead: true, customer: true };

/**
 * One bill (INV-090) made from one estimate (E-040), each of the four records with an address or
 * without one. It is not a draw, so nothing but the estimate's own read asks the quotes table. What
 * the estimate and its lead hold besides an address is planted in capitals: none of it is the
 * bill's to read.
 */
function billWorld(has: Has): Rows {
  const at = (k: Who) => (has[k] ? PLACES[k] : NOWHERE);
  return {
    ...ROWS,
    invoices: [
      {
        id: BILL, org_id: ORG, job_id: BILL_JOB, customer_id: BILL_CUST, quote_id: EST, invoice_number: "INV-090", status: "sent", title: "Unit 14 panel",
        description: null, notes: null, created_at: "2026-11-10T18:00:00Z", due_date: null, subtotal: 100, tax_rate: 0, tax: 0, total: 100, amount_paid: 0,
        invoice_kind: null, public_token: "b".repeat(32),
      },
    ],
    invoice_items: [{ id: "b1", invoice_id: BILL, org_id: ORG, sort_order: 0, description: "Panel swap", quantity: 1, unit: "ea", unit_price: 100, line_total: 100, import_source: null, import_key: null, edited: false, line_kind: null }],
    payments: [],
    jobs: [{ id: BILL_JOB, org_id: ORG, billing_type: "fixed", ...at("job") }],
    customers: [{ id: BILL_CUST, org_id: ORG, name: "Dana Rook", company_name: null, email: "dana@example.com", phone: "(530) 555-0100", ...at("customer") }],
    quotes: [{ id: EST, org_id: ORG, job_id: null, inquiry_id: LEAD, quote_number: "E-040", title: "ESTIMATE TITLE", notes: "ESTIMATE NOTE", total: 4321, status: "accepted", ...at("quote") }],
    inquiries: [{ id: LEAD, org_id: ORG, name: "LEAD NAME", phone: "LEAD PHONE", message: "LEAD MESSAGE", ...at("lead") }],
  };
}

describe("a bill made from an estimate prints the place the estimate prints", () => {
  const STAFF: InvoiceDocAccess = { kind: "staff" };
  const SERVICE: InvoiceDocAccess = { kind: "service", orgId: ORG };
  const estimateReads = (qs: Query[]) => qs.filter((q) => q.table === "quotes" && q.select === INVOICE_DOC_COLS.estimate);
  /** The estimate's own read answers with an error (and no other read does). */
  const ESTIMATE_FAILS = [`quotes=${INVOICE_DOC_COLS.estimate}`];
  const sheet = (r: InvoiceDocRead) =>
    renderToStaticMarkup(createElement(InvoiceDocument, ok(r))).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

  it("THE SKEPTIC'S CASE: the job gave no address and the estimate has a site of its own: the building, not where the customer lives", async () => {
    const r = await readInvoiceDocumentProps(client({ rows: billWorld(NO_JOB_ADDRESS) }), BILL, SERVICE);
    const p = ok(r);
    expect(p.site).toEqual({ address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161", source: "quote", complete: true });
    // Bill To is still the customer's own address: only the Job site moved.
    expect(p.customer).toMatchObject({ name: "Dana Rook", address: "12 Thistlewood Way" });
    expect(sheet(r)).toContain("Job site 40 Snowbell Court Unit 14 Testville, CA 96161");
    expect(r.kind === "ok" && r.degraded).toEqual([]);
    expect(reported).toEqual([]);
  });

  /** Each of the four with an address or without: sixteen bills. */
  const BILLS = Array.from({ length: 16 }, (_, bits): [string, Who | "none", Has] => {
    const has: Has = { job: !!(bits & 8), quote: !!(bits & 4), lead: !!(bits & 2), customer: !!(bits & 1) };
    const there = ORDER.filter((k) => has[k]);
    return [there.length ? there.join(" + ") : "no address anywhere", there[0] ?? "none", has];
  });

  it.each(BILLS)("%s → %s, the same on the print path, the /i link and the portal", async (_name, winner, has) => {
    const rows = billWorld(has);
    const office = await readInvoiceDocumentProps(client({ rls: true, rows }), BILL, STAFF);
    const link = await readInvoiceDocumentProps(client({ rows }), BILL, SERVICE);
    const portal = await readInvoiceDocumentProps(client({ rows }), BILL, { kind: "service", orgId: ORG, jobId: BILL_JOB });
    expect(ok(link)).toEqual(ok(office));
    expect(ok(portal)).toEqual(ok(office));
    // The first record in the order that has an address, whole: its street, its unit and its town.
    expect(ok(office).site ?? null).toEqual(winner === "none" ? null : pickSite([{ source: winner, parts: PLACES[winner] }]));
    for (const r of [office, link, portal]) expect(r.kind === "ok" && r.degraded).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("the table is not vacuous: every record wins somewhere, and one bill has no site at all", () => {
    expect([...new Set(BILLS.map(([, winner]) => winner))].sort()).toEqual(["customer", "job", "lead", "none", "quote"]);
  });

  it("a bill with no job at all reads the same as one whose job has no address", async () => {
    for (const has of [NO_JOB_ADDRESS, { job: false, quote: false, lead: true, customer: true }, { job: false, quote: false, lead: false, customer: true }]) {
      const rows = billWorld(has);
      rows.invoices[0].job_id = null;
      const db = client({ rows });
      const office = ok(await readInvoiceDocumentProps(client({ rls: true, rows }), BILL, STAFF));
      const link = ok(await readInvoiceDocumentProps(db, BILL, SERVICE));
      expect(link).toEqual(office);
      expect(db.queries.filter((q) => q.table === "jobs")).toEqual([]);
      const winner = ORDER.find((k) => has[k])!;
      expect(link.site).toEqual(pickSite([{ source: winner, parts: PLACES[winner] }]));
      // No job, so no billing model to state: the bill says nothing rather than guess one.
      expect(link.billingLabel).toBeNull();
    }
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("A BILL MADE FROM NO ESTIMATE (job address %s, customer address %s) asks for no estimate and prints what it printed before", async (job, customer) => {
    const rows = billWorld({ job, quote: true, lead: true, customer });
    rows.invoices[0].quote_id = null;
    for (const [db, access] of [[client({ rows }), SERVICE], [client({ rls: true, rows }), STAFF]] as const) {
      const p = ok(await readInvoiceDocumentProps(db, BILL, access));
      // The estimate and its lead are on file with addresses of their own; nobody asked them.
      expect(db.queries.filter((q) => q.table === "quotes" || q.table === "inquiries")).toEqual([]);
      // The list this file used to write inline, kept here as the witness.
      const was = pickSite([{ source: "job", parts: rows.jobs[0] as never }, { source: "customer", parts: rows.customers[0] as never }]);
      expect(p.site ?? null).toEqual(was);
    }
    expect(reported).toEqual([]);
  });

  it("the fixture every other test reads (INV-080) names no estimate, and asks for none", async () => {
    const db = client();
    const p = ok(await readInvoiceDocumentProps(db, INV, SERVICE));
    expect(estimateReads(db.queries)).toEqual([]);
    expect(p.site).toMatchObject({ address: "235 Thistlewood Court", source: "job" });
  });

  it("THE ESTIMATE READ NAMES THE INVOICE'S OWN ORG, on the estimate and on the lead it embeds; every read of the bill is pinned", async () => {
    const db = client({ rows: billWorld(EVERYWHERE) });
    ok(await readInvoiceDocumentProps(db, BILL, SERVICE));
    const asked = estimateReads(db.queries);
    expect(asked).toHaveLength(1);
    // The estimate by its id in the invoice's org; its lead is checked against that org in code
    // (never a filter on a to-one embed without !inner, a form this app has never run).
    expect(asked[0].filters).toEqual([
      ["eq", "id", EST],
      ["eq", "org_id", ORG],
    ]);
    // It rode with the other reads, not after them: one read of each piece, the estimate among them.
    expect(db.queries.map((q) => q.table)).toEqual(expect.arrayContaining(["invoices", "invoice_items", "payments", "customers", "jobs", "quotes", "organizations"]));
    for (const q of db.queries) {
      const pinned = q.filters.some(([op, col, val]) => op === "eq" && ((col === "org_id" && val === ORG) || (q.table === "organizations" && col === "id" && val === ORG)));
      expect(pinned, `${q.table} (${q.select})`).toBe(true);
    }
    // The office asks the very same question (RLS narrows it further; it never widens it).
    const office = client({ rls: true, rows: billWorld(EVERYWHERE) });
    ok(await readInvoiceDocumentProps(office, BILL, STAFF));
    expect(estimateReads(office.queries).map((q) => q.filters)).toEqual([asked[0].filters]);
  });

  it("an estimate that is another company's is not there for this bill: nothing of it prints, on either path, and nothing is called a failure", async () => {
    const rows = billWorld(NO_JOB_ADDRESS);
    rows.quotes[0].org_id = OTHER;
    for (const [db, access] of [[client({ rows }), SERVICE], [client({ rls: true, rows }), STAFF]] as const) {
      const r = await readInvoiceDocumentProps(db, BILL, access);
      // Not the other company's building, and not the lead reached through it: the customer's, as before.
      expect(ok(r).site).toMatchObject({ address: "12 Thistlewood Way", source: "customer" });
      expect(r.kind === "ok" && r.degraded).toEqual([]);
    }
    expect(reported).toEqual([]);
  });

  it("a lead that is another company's never prints: the service role is handed it, and the read takes it for no lead", async () => {
    const rows = billWorld({ job: false, quote: false, lead: true, customer: true });
    rows.inquiries[0].org_id = OTHER;
    // The premise: the very read the file makes hands the service role the other company's lead.
    const bare = await client({ rows }).from("quotes").select(INVOICE_DOC_COLS.estimate).eq("id", EST).eq("org_id", ORG).maybeSingle();
    expect(bare.data.inquiries).toMatchObject({ address: "16 Larkspur Circle", org_id: OTHER });
    // The real read: the customer's address on both paths. The office's RLS never showed it that lead,
    // so a /i link that printed it would have parted from the PDF.
    const link = ok(await readInvoiceDocumentProps(client({ rows }), BILL, SERVICE));
    const office = ok(await readInvoiceDocumentProps(client({ rls: true, rows }), BILL, STAFF));
    expect(link.site).toMatchObject({ address: "12 Thistlewood Way", source: "customer" });
    expect(link).toEqual(office);
    expect(reported).toEqual([]);
  });

  it("NOTHING BUT TEN ADDRESS COLUMNS IS ASKED OF THE ESTIMATE AND ITS LEAD (and the lead's company, to check it by), and nothing else of theirs can leave", async () => {
    expect(INVOICE_DOC_COLS.estimate).toBe("address, unit, city, state, zip, inquiries(org_id, address, unit, city, state, zip)");
    // A column you do not select is a column you cannot follow: the invoice read names quote_id.
    expect(INVOICE_DOC_COLS.invoice.split(", ")).toContain("quote_id");
    const src = readFileSync(join(process.cwd(), "src/lib/invoice-document-props.ts"), "utf8");
    // One read of quotes in the file, by that list, by id and org; the lead is reached only inside it.
    expect(src.match(/from\("quotes"\)/g)).toHaveLength(1);
    expect(src).toContain('db.from("quotes").select(INVOICE_DOC_COLS.estimate).eq("id", quoteId).eq("org_id", orgId).maybeSingle()');
    expect(src).not.toContain('"inquiries.org_id"');
    // The lead's company is checked in code, and a lead of another company is no lead.
    expect(src).toContain("lead: sitePartsOf(leadOfThisCompany(estimateRow?.inquiries, orgId))");
    expect(src).not.toMatch(/from\("inquiries"\)/);
    // Even a read that came back WIDER than it was asked (the whole rows) lets nothing else through.
    for (const whole of [false, true]) {
      const p = ok(await readInvoiceDocumentProps(client({ rows: billWorld(NO_JOB_ADDRESS), whole }), BILL, SERVICE));
      const json = JSON.stringify(p, (_k, v) => (v instanceof Set ? [...v] : v));
      for (const banned of ["ESTIMATE TITLE", "ESTIMATE NOTE", "4321", "E-040", "LEAD NAME", "LEAD PHONE", "LEAD MESSAGE", EST, LEAD, BILL_JOB, BILL_CUST, ORG]) {
        expect(json, banned).not.toContain(banned);
      }
      expect(Object.keys(p.site ?? {}).sort()).toEqual(["address", "city", "complete", "source", "state", "unit", "zip"]);
    }
    // …and the lead's, when it is the lead's address that prints.
    const viaLead = ok(await readInvoiceDocumentProps(client({ rows: billWorld({ job: false, quote: false, lead: true, customer: true }), whole: true }), BILL, SERVICE));
    expect(viaLead.site).toEqual({ ...PLACES.lead, source: "lead", complete: true });
    expect(JSON.stringify(viaLead, (_k, v) => (v instanceof Set ? [...v] : v))).not.toMatch(/LEAD (NAME|PHONE|MESSAGE)/);
  });

  it("THE ESTIMATE'S READ FAILS AND THE JOB GAVE NO ADDRESS: no site, never the customer's address under Job site; filed; the read is degraded", async () => {
    // Whatever the estimate would have said: with its own site, or with none at all (when the
    // customer's address would have been the right one, nobody can know it from a read that failed).
    for (const has of [NO_JOB_ADDRESS, { job: false, quote: false, lead: false, customer: true }]) {
      for (const access of [STAFF, SERVICE]) {
        reported.length = 0;
        const r = await readInvoiceDocumentProps(client({ rls: access.kind === "staff", rows: billWorld(has), fail: ESTIMATE_FAILS }), BILL, access);
        expect(r.kind).toBe("ok");
        if (r.kind !== "ok") continue;
        expect(r.props.site).toBeNull();
        expect(r.degraded).toEqual(["estimate"]);
        expect(reported).toEqual(["invoiceDoc.estimate"]);
        // The rest of the bill is whole, and the sheet prints no Job site heading over nothing.
        expect(r.props.customer).toMatchObject({ name: "Dana Rook", address: "12 Thistlewood Way" });
        expect(r.props.items).toHaveLength(1);
        expect(sheet(r)).not.toContain("Job site");
        expect(sheet(r)).toContain("12 Thistlewood Way");
      }
    }
  });

  it("…the same for a bill with no job at all", async () => {
    const rows = billWorld(NO_JOB_ADDRESS);
    rows.invoices[0].job_id = null;
    const r = await readInvoiceDocumentProps(client({ rows, fail: ESTIMATE_FAILS }), BILL, SERVICE);
    expect(ok(r).site).toBeNull();
    expect(r.kind === "ok" && r.degraded).toEqual(["estimate"]);
    expect(reported).toEqual(["invoiceDoc.estimate"]);
  });

  it("THE ESTIMATE'S READ FAILS AND THE JOB GAVE THE SITE: the bill is whole without it, so it is not degraded; the failure is still filed", async () => {
    for (const access of [STAFF, SERVICE]) {
      reported.length = 0;
      const rls = access.kind === "staff";
      const r = await readInvoiceDocumentProps(client({ rls, rows: billWorld(EVERYWHERE), fail: ESTIMATE_FAILS }), BILL, access);
      expect(ok(r).site).toMatchObject({ address: "9 Bayberry Lane", source: "job" });
      expect(r.kind === "ok" && r.degraded).toEqual([]);
      expect(reported).toEqual(["invoiceDoc.estimate"]);
      // Byte for byte the bill a clean read draws: the job outranks the estimate, so nothing was lost.
      expect(ok(r)).toEqual(ok(await readInvoiceDocumentProps(client({ rls, rows: billWorld(EVERYWHERE) }), BILL, access)));
    }
  });

  it("a failed JOB read prints no site whatever the estimate says: the job outranks it, and the job is unknown", async () => {
    const stood = await readInvoiceDocumentProps(client({ rows: billWorld(EVERYWHERE), fail: ["jobs"] }), BILL, SERVICE);
    expect(ok(stood).site).toBeNull();
    expect(stood.kind === "ok" && stood.degraded).toEqual(["job"]);
    expect(reported).toEqual(["invoiceDoc.job"]);
    // Both reads lost: still no site, the job's piece is the one named, and both failures are filed.
    reported.length = 0;
    const both = await readInvoiceDocumentProps(client({ rows: billWorld(EVERYWHERE), fail: ["jobs", ...ESTIMATE_FAILS] }), BILL, SERVICE);
    expect(ok(both).site).toBeNull();
    expect(both.kind === "ok" && both.degraded).toEqual(["job"]);
    expect([...reported].sort()).toEqual(["invoiceDoc.estimate", "invoiceDoc.job"]);
  });

  it("both readers of `degraded` say something true about the new piece", () => {
    // The PDF: any piece left off is refused, by name, so a bill with no site is never stored as the customer's copy.
    const print = readFileSync(join(process.cwd(), "src/app/print/invoice/[id]/page.tsx"), "utf8");
    expect(print).toMatch(/if \(read\.degraded\.length > 0\) \{\s*throw new Error\(`This invoice couldn't be read in full just now \(\$\{read\.degraded\.join\(", "\)\}\)\.`\);/);
    // The /i link: "part of this bill" covers the job site, and it never names a piece it cannot explain.
    const link = readFileSync(join(process.cwd(), "src/app/i/[token]/page.tsx"), "utf8");
    expect(link).toMatch(/\{doc\.degraded\.length > 0 && \(/);
    expect(link).toContain("Part of this bill couldn&apos;t load just now.");
    expect(link).not.toMatch(/degraded\.includes\(/);
  });

  it("THE PURE ASSEMBLY: the estimate is a piece a caller may leave out, and then nothing changed", () => {
    const base: Omit<InvoiceDocInputs, "customer" | "job" | "estimate"> = {
      invoice: { invoice_number: "INV-090", created_at: "2026-11-10T18:00:00Z", subtotal: 100, tax: 0, total: 100, amount_paid: 0 },
      items: [],
      payments: [],
      org: { name: "Testville Electric", settings: {} },
      supplierNames: new Set<string>(),
      progress: null,
    };
    const site = (inp: Pick<InvoiceDocInputs, "job" | "estimate">) => assembleInvoiceDocumentProps({ ...base, customer: { name: "Dana Rook", ...PLACES.customer }, ...inp }).site ?? null;
    const noJob = { row: null, failed: false };
    const onJob = { row: { billing_type: "fixed", ...PLACES.job }, failed: false };
    // No estimate handed in (the portal's and the line-words' own tests call it this way): the job's, else the customer's.
    expect(site({ job: onJob })).toMatchObject({ address: "9 Bayberry Lane", source: "job" });
    expect(site({ job: noJob })).toMatchObject({ address: "12 Thistlewood Way", source: "customer" });
    expect(site({ job: noJob, estimate: null })).toMatchObject({ address: "12 Thistlewood Way", source: "customer" });
    // An estimate handed in: its own site, then its lead's, between the job's and the customer's.
    expect(site({ job: noJob, estimate: { site: PLACES.quote, lead: PLACES.lead, failed: false } })).toMatchObject({ address: "40 Snowbell Court", unit: "14", source: "quote" });
    expect(site({ job: noJob, estimate: { site: null, lead: PLACES.lead, failed: false } })).toMatchObject({ address: "16 Larkspur Circle", source: "lead" });
    expect(site({ job: noJob, estimate: { site: NOWHERE, lead: NOWHERE, failed: false } })).toMatchObject({ address: "12 Thistlewood Way", source: "customer" });
    expect(site({ job: onJob, estimate: { site: PLACES.quote, lead: PLACES.lead, failed: false } })).toMatchObject({ address: "9 Bayberry Lane", source: "job" });
    // A read that failed: only an address ranked above it may stand.
    expect(site({ job: noJob, estimate: { site: null, lead: null, failed: true } })).toBeNull();
    expect(site({ job: onJob, estimate: { site: null, lead: null, failed: true } })).toMatchObject({ address: "9 Bayberry Lane", source: "job" });
    expect(site({ job: { row: null, failed: true }, estimate: { site: PLACES.quote, lead: PLACES.lead, failed: false } })).toBeNull();
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
    // W3: the list itself is lib/customer-visible-docs now, shared with the stored-PDF door and the
    // portal's job page, and customer-visible-docs.test.ts holds it to what the database opens.
    expect([...CUSTOMER_VISIBLE_STATUSES.invoice]).toEqual(["sent", "partial", "paid", "overdue"]);
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

  it("INV-080: the last row is the job's total against the estimate (Erik: 'it should be total to estimate')", () => {
    // Estimate 17,325; work to date 19,716.64 (114%: every line billed, at the price billed - it
    // read 18,624.14 while June's hours were re-priced at today's rates); received 16,527.30 + this
    // request 3,189.34 = 19,716.64, which is $2,391.64 BILLED past it.
    const html = renderToStaticMarkup(
      createElement(ProgressReportCard, { estimate: 17325, workToDate: 19716.64, received: 16527.3, thisAmount: 3189.34, billingType: "tm" }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    expect(text).toContain("$19,716.64");
    expect(text).toContain("114% complete");
    expect(text).toContain("Total to estimate $2,391.64 over");
    expect(text).not.toContain("Balance to estimate");
    expect(text).not.toContain("-$");
  });

  it("totalToEstimateRow: over, under, on the nose", () => {
    expect(totalToEstimateRow(19716.64, 17325)).toEqual({ label: "Total to estimate", value: 2391.64, note: "over" });
    expect(totalToEstimateRow(16825, 17325)).toEqual({ label: "Total to estimate", value: 500, note: "under" });
    expect(totalToEstimateRow(17325, 17325)).toEqual({ label: "Total to estimate", value: 0, note: null });
  });
});
