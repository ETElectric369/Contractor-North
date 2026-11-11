import type { ComponentProps } from "react";
import type { InvoiceDocument } from "@/components/invoice-document";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { getOrgSettings } from "@/lib/org-settings";
import { customerLines, invoiceTypeLabel, isDrawKind } from "@/lib/invoice-math";
import { jobProgressFinancials, receivedBeforeThisInvoice, type JobProgressFinancials } from "@/lib/job-financials";
import { readSupplierNames } from "@/lib/supplier-names";
import { pickSite, SITE_COLS, type ResolvedSite, type SiteParts } from "@/lib/site-address";
import { bornFromEstimateCandidates, sitePartsOf } from "@/lib/quote-site";
import { CUSTOMER_VISIBLE_STATUSES } from "@/lib/customer-visible-docs";
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
 *
 * THE JOB SITE OF A BILL MADE FROM AN ESTIMATE (cn-v1160, skeptic #61). An invoice owns no address.
 * It prints its job's; with no job it used to print the customer's own address under "Job site",
 * while the estimate it was made from printed the building the work is in. The order is one rule
 * now (lib/quote-site bornFromEstimateCandidates): the job's site, then the source estimate's own,
 * then that estimate's lead's, then the customer's. The estimate is read by the invoice's quote_id,
 * its five address columns and its lead's five and nothing else. A failed read of it is filed, and
 * it costs the bill something only when the job gave no address: then NO site is printed, never
 * the customer's address in the place of one that could not be read, and the read is `degraded`
 * (piece "estimate"). When the job gave the site, the bill is whole without it.
 *
 * LEFT OFF IS FOR THE LIVE PAGES ONLY. A read with a piece missing says so (`degraded`, naming the
 * pieces). The /i page and the portal redraw on every open, so they draw what they have and say,
 * above the sheet, that part of the bill couldn't load (audit v1018): a partial bill is never passed
 * off as the whole one. A failed progress read is any of jobProgressFinancials' reads (the job, its
 * quotes, invoices, orders, receipts, stock, org), each of which throws rather than read as empty.
 * The print page is the PDF, and /api/pdf stores what it renders as the customer's copy with nothing on it
 * saying a piece is missing, so the print page refuses a degraded read (a non-200 is never stored).
 */
export type InvoiceDocumentProps = Omit<ComponentProps<typeof InvoiceDocument>, "groupByKind">;

/** A piece of the document whose read failed and was left off (see the header). `estimate`: the
 *  estimate the bill was made from could not be read and the job gave no address, so the job site
 *  was left off. */
export type InvoiceDocPiece = "payments" | "customer" | "job" | "estimate" | "progress";

export type InvoiceDocRead =
  /** `degraded`: the pieces left off because their read failed (empty when whole). */
  | { kind: "ok"; props: InvoiceDocumentProps; degraded: InvoiceDocPiece[] }
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

// WHICH BILLS A CUSTOMER MAY OPEN is lib/customer-visible-docs, shared with the stored-PDF door and
// the portal's job page (W3). It used to be a list of its own here, named PUBLIC_INVOICE_STATUSES.

export const INVOICE_DOC_COLS = {
  // quote_id (cn-v1160): the estimate the bill was made from, read below for the job site. A column
  // you do not select is a column you cannot follow: without it here the estimate is never asked.
  invoice:
    "id, org_id, job_id, customer_id, quote_id, invoice_number, status, title, description, notes, created_at, due_date, subtotal, tax_rate, tax, total, amount_paid, invoice_kind",
  // import_key + edited: customerLineWords needs them to know an importer's untouched lump.
  // line_kind (0342): what the line was said to be, which the Cost Breakdown reads first.
  items: "id, description, quantity, unit, unit_price, line_total, import_source, import_key, edited, line_kind",
  // Never `note` (the office's), never a Stripe id or processor fee.
  payments: "id, amount, paid_at, method",
  customer: `name, company_name, email, phone, ${SITE_COLS}`,
  job: `billing_type, ${SITE_COLS}`,
  // THE ESTIMATE THE BILL WAS MADE FROM, FOR ITS PLACE AND NOTHING ELSE: its own five address
  // columns and its lead's five, with the lead's company to check it by (it never leaves this file).
  // Never a price, a title, a note, or the lead's name or phone.
  estimate: `${SITE_COLS}, inquiries(org_id, ${SITE_COLS})`,
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
  /**
   * The estimate the bill was made from (invoices.quote_id), as five address columns each: its own
   * site and its lead's. Left out or null: the bill was made from no estimate, and its site is the
   * job's, else the customer's, as it always was. `failed`: the read failed (see billSite).
   */
  estimate?: { site: SiteParts | null; lead: SiteParts | null; failed: boolean } | null;
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
 * THE BILL'S JOB SITE, AND WHETHER A FAILED ESTIMATE READ COST THE BILL ITS SITE.
 *
 * One order, written once (lib/quote-site bornFromEstimateCandidates): the job's site, the source
 * estimate's own, that estimate's lead's, the customer's. pickSite takes the first record that has
 * an address, whole. Three cases, and in none of them is an address printed in the place of one
 * that could not be read:
 *   · the job's read failed: no site (a lower address under "Job site" would be a guess);
 *   · the estimate's read failed: only the job's address may stand, because it outranks the
 *     estimate's. With none, no site, and the read cost the bill something (`lost`);
 *   · every read stood: the first address in the order.
 * A bill made from no estimate has no estimate to rank, so it prints the job's, else the
 * customer's, exactly as it did before there was an order to follow.
 */
function billSite(inp: InvoiceDocInputs): { site: ResolvedSite | null; lost: boolean } {
  if (inp.job.failed) return { site: null, lost: false };
  const job = (inp.job.row ?? null) as SiteParts | null;
  const est = inp.estimate ?? null;
  if (est?.failed) {
    const fromJob = pickSite(bornFromEstimateCandidates({ job }));
    return { site: fromJob, lost: !fromJob };
  }
  const site = pickSite(
    bornFromEstimateCandidates({ job, quote: est?.site, lead: est?.lead, customer: (inp.customer ?? null) as SiteParts | null }),
  );
  return { site, lost: false };
}

/**
 * THE ESTIMATE'S LEAD, WHEN IT IS THIS COMPANY'S; else no lead. Never an error and never a degraded
 * read: a lead of another company has nothing to say on this bill. Its org_id is read for this check
 * alone and goes no further (sitePartsOf keeps five address columns).
 */
function leadOfThisCompany(embed: unknown, orgId: string): SiteParts | null {
  const one = (Array.isArray(embed) ? embed[0] : embed) as (SiteParts & { org_id?: unknown }) | null | undefined;
  return one && String(one.org_id ?? "") === orgId ? one : null;
}

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
    // An invoice owns no site: the job's, then the estimate's it was made from, that estimate's
    // lead's, the customer's (billSite). A job read that failed prints no site rather than the
    // customer's address under a "Job site" heading, and so does an estimate read that failed
    // when the job gave none.
    site: billSite(inp).site,
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
  progress: Map<string, Promise<{ fin: JobProgressFinancials | null; failed: boolean }>>;
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
  // The estimate the bill was made from (createInvoiceFromQuote stamps it). Read for its place only.
  const quoteId = inv.quote_id ? String(inv.quote_id) : null;
  const cache = opts?.cache;

  const namesP = (() => {
    const hit = cache?.supplierNames.get(orgId);
    if (hit) return hit;
    const p = readSupplierNames(db, orgId);
    cache?.supplierNames.set(orgId, p);
    return p;
  })();

  // A draw on a job carries the job's progress figures. The service role pins them to the org.
  const progressP: Promise<{ fin: JobProgressFinancials | null; failed: boolean }> =
    jobId && isDrawKind(inv.invoice_kind)
      ? (() => {
          const hit = cache?.progress.get(jobId);
          if (hit) return hit;
          const p = jobProgressFinancials(db, jobId, access.kind === "service" ? { orgId } : undefined).then(
            (fin) => ({ fin, failed: false }),
            (e: unknown) => {
              reportError("invoiceDoc.progress", e, { ...ctx, jobId });
              return { fin: null, failed: true };
            },
          );
          cache?.progress.set(jobId, p);
          return p;
        })()
      : Promise.resolve({ fin: null, failed: false });

  const [itemsR, paymentsR, customerR, jobR, estimateR, orgR, names, progress] = await Promise.all([
    db.from("invoice_items").select(INVOICE_DOC_COLS.items).eq("invoice_id", invoiceId).eq("org_id", orgId).order("sort_order"),
    // Oldest first, the order the statement's running balance reads in.
    db.from("payments").select(INVOICE_DOC_COLS.payments).eq("invoice_id", invoiceId).eq("org_id", orgId).order("paid_at", { ascending: true }),
    customerId
      ? db.from("customers").select(INVOICE_DOC_COLS.customer).eq("id", customerId).eq("org_id", orgId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    jobId
      ? db.from("jobs").select(INVOICE_DOC_COLS.job).eq("id", jobId).eq("org_id", orgId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // THE ESTIMATE THE BILL WAS MADE FROM, by its id, for its site and its lead's. Named to the
    // invoice's own org like every read here. The lead it embeds is checked against that org in code
    // below (leadOfThisCompany), never by a filter on the embed: a lead of another company is simply
    // no lead. The service role sees every company, and a lead the office's own read could not see
    // (RLS) must not print on the customer's copy either: the print path and the public path give
    // one answer. An estimate that is not there for this reader is simply no estimate; only a read
    // that ERRORS is a failure.
    quoteId
      ? db.from("quotes").select(INVOICE_DOC_COLS.estimate).eq("id", quoteId).eq("org_id", orgId).maybeSingle()
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
  // Filed whenever it fails, whether or not the bill needed it: a bill whose job gave the site
  // prints whole, and a read that keeps failing would otherwise be met first by a bill with no job.
  if (estimateR.error) reportError("invoiceDoc.estimate", estimateR.error, { ...ctx, quoteId });

  const jobFailed = !!jobR.error;
  const estimateFailed = !!estimateR.error;
  const estimateRow = estimateFailed ? null : ((estimateR.data ?? null) as Row | null);
  const inputs: InvoiceDocInputs = {
    invoice: inv,
    items: (itemsR.data ?? []) as Row[],
    payments: paymentsR.error ? null : ((paymentsR.data ?? []) as Row[]),
    customer: customerR.error ? null : ((customerR.data ?? null) as Row | null),
    job: { row: jobFailed ? null : ((jobR.data ?? null) as Row | null), failed: jobFailed },
    // Five address columns each and nothing else (sitePartsOf), whatever the rows held.
    estimate: quoteId ? { site: sitePartsOf(estimateRow), lead: sitePartsOf(leadOfThisCompany(estimateRow?.inquiries, orgId)), failed: estimateFailed } : null,
    org: orgR.data as Row,
    supplierNames: names.names,
    progress: jobFailed ? null : progress.fin,
  };
  const degraded: InvoiceDocPiece[] = [];
  if (paymentsR.error) degraded.push("payments");
  if (customerR.error) degraded.push("customer");
  if (jobFailed) degraded.push("job");
  // Only when it cost the bill its site (the job gave none): see billSite.
  if (billSite(inputs).lost) degraded.push("estimate");
  if (progress.failed) degraded.push("progress");
  return { kind: "ok", degraded, props: assembleInvoiceDocumentProps(inputs) };
}

/**
 * THE CUSTOMER'S /i LINK: which invoice the token names, if it is one a customer may open
 * (customerMayOpen, the same gate public_invoice holds), and its org, read as the service
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
    .in("status", [...CUSTOMER_VISIBLE_STATUSES.invoice])
    .maybeSingle();
  if (error) {
    reportError("invoiceDoc.token", error);
    return { kind: "error" };
  }
  const row = data as { id?: string | null; org_id?: string | null } | null;
  if (!row?.id || !row.org_id) return { kind: "missing" };
  return { kind: "ok", invoiceId: String(row.id), orgId: String(row.org_id) };
}
