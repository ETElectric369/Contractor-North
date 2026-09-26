import type { ComponentProps } from "react";
import type { InvoiceDocument } from "@/components/invoice-document";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { getOrgSettings } from "@/lib/org-settings";
import { customerLines, invoiceTypeLabel, isDrawKind } from "@/lib/invoice-math";
import { jobProgressFinancials, receivedBeforeThisInvoice, type JobProgressFinancials } from "@/lib/job-financials";
import { readSupplierNames } from "@/lib/supplier-names";
import { pickSite, SITE_COLS } from "@/lib/site-address";
import { reportError } from "@/lib/observe";
import type { Organization } from "@/lib/types";

/**
 * THE ONE ASSEMBLY OF AN INVOICE DOCUMENT (Erik, INV-080, 2026-09-25: "the preview pdf is
 * formatted better, are there two systems there?").
 *
 * There was one document component (InvoiceDocument) fed by two different prop sets: the print
 * page (the PDF) read the invoice itself, and the customer's /i link and portal bill mapped the
 * public projection (invoice_document_projection). The projection had drifted: no org tint (the
 * header fell back to the platform green), no customer phone or email, no Progress Summary. Every
 * surface now calls THIS, so there is no second mapping left to drift:
 *   - /print/invoice/<id> (the PDF, and so /api/share-pdf): the signed-in office's own client,
 *     RLS scoping every read (access: staff);
 *   - /i/<token> and the portal's bill: the service role, pinned by hand to THIS invoice's own org
 *     (and, from the portal, its job), after the link's own gate already ran (access: service).
 *
 * What it reads is what the customer's copy prints and nothing more: never a cost, a pay rate, a
 * payment's note, an invoice's internal hold reason, or the org's settings object (only the four
 * things the document takes from it: the tint, the layout knobs, the terms and the footer). The
 * supplier scrub is InvoiceDocument's own (customerLines with the org's supplier names), the same on
 * every surface.
 *
 * A READ THAT FAILS DEGRADES HONESTLY. The invoice, its lines, its org and its supplier names are
 * the document: without any of them there is no document (kind "error"), never a bill with the
 * wrong lines, the wrong letterhead or a supplier's name on it. The rest are pieces, each logged
 * and left off: a failed payments read prints no payment list (Amount Paid still comes from the
 * invoice row), a failed customer read prints no Bill To, a failed job read prints no job site and
 * no Progress Summary, and a failed progress read prints no Progress Summary.
 */
export type InvoiceDocumentProps = Omit<ComponentProps<typeof InvoiceDocument>, "groupByKind">;

export type InvoiceDocRead =
  | { kind: "ok"; props: InvoiceDocumentProps }
  /** No such invoice for this reader (RLS, or not in the pinned org/job). */
  | { kind: "missing" }
  /** A read the document cannot be drawn without failed. Logged. */
  | { kind: "error" };

/**
 * Who is reading. `staff`: a signed-in office client; RLS scopes the reads. `service`: the service
 * role, which RLS does not narrow; the invoice read is pinned to `orgId` (and `jobId` when given),
 * and every later read to the invoice's own org.
 */
export type InvoiceDocAccess = { kind: "staff" } | { kind: "service"; orgId: string; jobId?: string | null };

/** Minimal client shape: a supabase-js client (session or service role). */
type Db = { from: (table: string) => any };

/** What public_invoice has always shown a customer: a bill that was sent (0012/0247). A draft, a
 *  void bill or a held one never opens through a /i link. */
export const PUBLIC_INVOICE_STATUSES = ["sent", "partial", "paid", "overdue"] as const;

export const INVOICE_DOC_COLS = {
  invoice:
    "id, org_id, job_id, customer_id, invoice_number, status, title, description, notes, created_at, due_date, subtotal, tax_rate, tax, total, amount_paid, invoice_kind",
  // import_key + edited: customerLineWords needs them to know an importer's untouched lump.
  // line_kind (0342): what the line was said to be, which the Cost Breakdown reads first.
  items: "id, description, quantity, unit, unit_price, line_total, import_source, import_key, edited, line_kind",
  // Never `note` (the office's), never a Stripe id or processor fee.
  payments: "id, amount, paid_at, method",
  customer: `name, company_name, email, phone, ${SITE_COLS}`,
  job: `billing_type, ${SITE_COLS}`,
  // `settings` is read, never passed on: see assembleInvoiceDocumentProps.
  org: "name, logo_url, address_line1, address_line2, city, state, zip, phone, email, license, doc_template, doc_templates, settings",
} as const;

type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything the document is built from, as read. Pure input to assembleInvoiceDocumentProps. */
export type InvoiceDocInputs = {
  invoice: Row;
  items: Row[];
  /** null: the payments read failed (the list is left off). */
  payments: Row[] | null;
  /** null: no customer, or the read failed (Bill To shows a dash). */
  customer: Row | null;
  /** The job's row; `failed`: the read failed (no site, no progress). */
  job: { row: Row | null; failed: boolean };
  org: Row;
  supplierNames: ReadonlySet<string>;
  /** The job's progress figures, for a draw on a job; null when not one or the read failed. */
  progress: JobProgressFinancials | null;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * THE PROPS, FROM THE INPUTS. Pure: the unit test holds the print path and the public path to the
 * same answer on the same rows. No settings object, no org id, no customer id leaves here.
 */
export function assembleInvoiceDocumentProps(inp: InvoiceDocInputs): InvoiceDocumentProps {
  const inv = inp.invoice;
  const org = inp.org as Organization & Row;
  const settings = getOrgSettings(org.settings);
  const kind = (inv.invoice_kind as string | null | undefined) ?? null;
  const jobRow = inp.job.failed ? null : inp.job.row;
  const fin = inp.progress;
  const c = inp.customer;
  return {
    // The org's own tint (settings.glass_tint): the header band and accent rules (companyFromOrg).
    co: companyFromOrg(org),
    template: templateFor(org, "invoice"),
    number: String(inv.invoice_number ?? ""),
    createdAt: inv.created_at,
    dueDate: inv.due_date ?? null,
    title: inv.title ?? null,
    // A clear "Time & Material vs Fixed-Price" statement from the job's billing model. A job read
    // that failed says only the stage (never a guessed model).
    billingLabel: invoiceTypeLabel(jobRow?.billing_type ?? null, kind),
    description: inv.description ?? null,
    customer: c
      ? {
          name: c.name ?? null,
          company_name: c.company_name ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          address: c.address ?? null,
          unit: c.unit ?? null,
          city: c.city ?? null,
          state: c.state ?? null,
          zip: c.zip ?? null,
        }
      : null,
    // An invoice owns no site: the job's, else the customer's (pickSite). A job read that failed
    // prints no site rather than the customer's address under a "Job site" heading.
    site: inp.job.failed
      ? null
      : pickSite([
          { source: "job", parts: (jobRow ?? null) as never },
          { source: "customer", parts: (c ?? null) as never },
        ]),
    // THE CUSTOMER'S WORDS, HERE (audit v994 PL1): the props never hold a supplier's name, so no
    // surface that carries them (the portal's view object) can leak one. InvoiceDocument applies the
    // same rule again as it draws, which changes nothing on words already scrubbed. The importer's
    // key and edited flag are what the rule reads; once it has, they stay behind.
    items: customerLines(
      inp.items.map((it) => ({
        id: it.id ?? undefined,
        description: String(it.description ?? ""),
        quantity: num(it.quantity),
        unit: it.unit ?? null,
        unit_price: num(it.unit_price),
        line_total: num(it.line_total),
        import_source: it.import_source ?? null,
        import_key: it.import_key ?? null,
        edited: it.edited ?? null,
        line_kind: it.line_kind ?? null,
      })),
      inp.supplierNames,
    ).map(({ import_key: _key, edited: _edited, ...line }) => line),
    subtotal: num(inv.subtotal),
    taxRate: inv.tax_rate == null ? null : num(inv.tax_rate),
    tax: num(inv.tax),
    total: num(inv.total),
    amountPaid: num(inv.amount_paid),
    payments: (inp.payments ?? []).map((p) => ({
      id: p.id ?? undefined,
      paid_at: p.paid_at,
      method: p.method ?? null,
      amount: num(p.amount),
    })),
    notes: inv.notes ?? null,
    terms: settings.invoice_terms || null,
    documentFooter: settings.document_footer || null,
    docStyle: settings.doc_style,
    supplierNames: inp.supplierNames,
    invoiceKind: kind,
    // Nothing to measure against, nothing to print: a progress bill on a T&M job with no quote
    // printed "Estimate $0.00" beside its Balance Due (INV-078).
    progress:
      fin && fin.estimate > 0
        ? {
            estimate: fin.estimate,
            workToDate: fin.workToDate,
            received: receivedBeforeThisInvoice(fin, inv.amount_paid),
            thisAmount: num(inv.total),
            billingType: fin.billingType,
          }
        : null,
  };
}

/** Reads shared across several bills in one page load (the portal draws every bill on a job). */
export type InvoiceDocCache = {
  supplierNames: Map<string, Promise<{ names: ReadonlySet<string>; failed: boolean }>>;
  progress: Map<string, Promise<JobProgressFinancials | null>>;
};
export function newInvoiceDocCache(): InvoiceDocCache {
  return { supplierNames: new Map(), progress: new Map() };
}

/**
 * THE ONE READ. Every invoice document surface calls this and renders
 * <InvoiceDocument {...props} /> (plus its own chrome, and the portal's groupByKind).
 */
export async function readInvoiceDocumentProps(
  db: Db,
  invoiceId: string,
  access: InvoiceDocAccess,
  opts?: { cache?: InvoiceDocCache },
): Promise<InvoiceDocRead> {
  const ctx = { invoiceId };
  // Not an id at all (a mistyped /print URL): no such invoice, never a database error.
  if (typeof invoiceId !== "string" || !UUID.test(invoiceId)) return { kind: "missing" };
  let invQ = db.from("invoices").select(INVOICE_DOC_COLS.invoice).eq("id", invoiceId);
  if (access.kind === "service") {
    invQ = invQ.eq("org_id", access.orgId);
    if (access.jobId) invQ = invQ.eq("job_id", access.jobId);
  }
  const { data: invoice, error: invErr } = await invQ.maybeSingle();
  if (invErr) {
    reportError("invoiceDoc.invoice", invErr, ctx);
    return { kind: "error" };
  }
  if (!invoice) return { kind: "missing" };
  const inv = invoice as Row;
  const orgId = String(inv.org_id ?? "");
  if (!orgId || (access.kind === "service" && orgId !== access.orgId)) return { kind: "missing" };
  const jobId = inv.job_id ? String(inv.job_id) : null;
  const customerId = inv.customer_id ? String(inv.customer_id) : null;
  const cache = opts?.cache;

  const namesP = (() => {
    const hit = cache?.supplierNames.get(orgId);
    if (hit) return hit;
    const p = readSupplierNames(db, orgId);
    cache?.supplierNames.set(orgId, p);
    return p;
  })();

  // A draw on a job carries the job's progress figures. The service role pins them to the org.
  const progressP: Promise<JobProgressFinancials | null> =
    jobId && isDrawKind(inv.invoice_kind)
      ? (() => {
          const hit = cache?.progress.get(jobId);
          if (hit) return hit;
          const p = jobProgressFinancials(db, jobId, access.kind === "service" ? { orgId } : undefined).catch((e: unknown) => {
            reportError("invoiceDoc.progress", e, { ...ctx, jobId });
            return null;
          });
          cache?.progress.set(jobId, p);
          return p;
        })()
      : Promise.resolve(null);

  const [itemsR, paymentsR, customerR, jobR, orgR, names, progress] = await Promise.all([
    db.from("invoice_items").select(INVOICE_DOC_COLS.items).eq("invoice_id", invoiceId).eq("org_id", orgId).order("sort_order"),
    // Oldest first, the order the statement's running balance reads in.
    db.from("payments").select(INVOICE_DOC_COLS.payments).eq("invoice_id", invoiceId).eq("org_id", orgId).order("paid_at", { ascending: true }),
    customerId
      ? db.from("customers").select(INVOICE_DOC_COLS.customer).eq("id", customerId).eq("org_id", orgId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    jobId
      ? db.from("jobs").select(INVOICE_DOC_COLS.job).eq("id", jobId).eq("org_id", orgId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("organizations").select(INVOICE_DOC_COLS.org).eq("id", orgId).maybeSingle(),
    namesP,
    progressP,
  ]);

  if (itemsR.error) {
    reportError("invoiceDoc.items", itemsR.error, ctx);
    return { kind: "error" };
  }
  if (orgR.error || !orgR.data) {
    reportError("invoiceDoc.org", orgR.error ?? new Error("organization row not readable"), ctx);
    return { kind: "error" };
  }
  if (names.failed) {
    // Without the names, a line the office typed as "Materials — <supplier>" would print the name.
    reportError("invoiceDoc.supplierNames", new Error("supplier names read failed"), ctx);
    return { kind: "error" };
  }
  if (paymentsR.error) reportError("invoiceDoc.payments", paymentsR.error, ctx);
  if (customerR.error) reportError("invoiceDoc.customer", customerR.error, ctx);
  if (jobR.error) reportError("invoiceDoc.job", jobR.error, ctx);

  const jobFailed = !!jobR.error;
  return {
    kind: "ok",
    props: assembleInvoiceDocumentProps({
      invoice: inv,
      items: (itemsR.data ?? []) as Row[],
      payments: paymentsR.error ? null : ((paymentsR.data ?? []) as Row[]),
      customer: customerR.error ? null : ((customerR.data ?? null) as Row | null),
      job: { row: jobFailed ? null : ((jobR.data ?? null) as Row | null), failed: jobFailed },
      org: orgR.data as Row,
      supplierNames: names.names,
      progress: jobFailed ? null : progress,
    }),
  };
}

/**
 * THE CUSTOMER'S /i LINK: which invoice the token names, if it is one a customer may open
 * (PUBLIC_INVOICE_STATUSES, the same gate public_invoice holds), and its org, read as the service
 * role. The token is the credential; the caller then reads the document with
 * readInvoiceDocumentProps(svc, invoiceId, { kind: "service", orgId }).
 */
export async function resolvePublicInvoice(
  svc: Db,
  token: string,
): Promise<{ kind: "ok"; invoiceId: string; orgId: string } | { kind: "missing" } | { kind: "error" }> {
  if (typeof token !== "string" || !token || token.length > 200) return { kind: "missing" };
  const { data, error } = await svc
    .from("invoices")
    .select("id, org_id")
    .eq("public_token", token)
    .in("status", [...PUBLIC_INVOICE_STATUSES])
    .maybeSingle();
  if (error) {
    reportError("invoiceDoc.token", error);
    return { kind: "error" };
  }
  const row = data as { id?: string | null; org_id?: string | null } | null;
  if (!row?.id || !row.org_id) return { kind: "missing" };
  return { kind: "ok", invoiceId: String(row.id), orgId: String(row.org_id) };
}
