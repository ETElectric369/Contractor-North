/**
 * THE CUSTOMER'S JOB PAGE, AS DATA: the one place the portal's raw read becomes what the page may
 * render. Pure (no I/O), so the allowlist is a unit test, not a promise.
 *
 * portal_job_view (0301) returns building blocks: the gate already ran inside it (the link is on,
 * the job is this customer's in this org), and it never selected a cost, a pay rate, a note, GPS, a
 * supplier's paper or another customer's anything. But it also returns what the SERVER needs and
 * the customer does not: the org/job/customer ids, the storage paths of the files, the labor
 * entries behind each line, the invoice ids that tie lines to bills. This module keeps the page to
 * an explicit list of fields, built field by field (never a spread of a database row), so a column
 * added to a table or to the function later cannot reach a customer by default. The test pins the
 * keys.
 *
 * Files: a pick's picture or PDF and a shared photo leave here only as the short-lived signed URL
 * the server minted for exactly that path; the path itself never does. A path that is not where
 * that kind of file must live (a pick outside <org>/picks/<job>/, a photo outside <org>/<job>/) is
 * dropped even though the database already refuses to store one, because this is the last door.
 */
import { buildJobLedger, type JobLedger, type LedgerInvoiceIn, type LedgerLineIn, type LedgerPaymentIn, type LedgerStretchIn } from "./stretch-ledger";
import { accentHex, getOrgSettings } from "@/lib/org-settings";
import { customerLineWords, invoiceBalance } from "@/lib/invoice-math";
import { todayStrInTz } from "@/lib/tz";
import type { CustomerUnbilled } from "@/lib/unbilled-work";
import { docFormat, isPortalDocKind, kindLabel, kindRank, type DocFormat, type PortalDocKind } from "./doc-kinds";
import { normalizePortalPanels, type DirectoryPanel } from "@/lib/panel/directory";
import type { InvoiceDocRead, InvoiceDocumentProps } from "@/lib/invoice-document-props";

/** What portal_job_view returns (0301), as the server reads it. */
export type PortalJobRaw = {
  scope: { org_id: string; job_id: string; customer_id: string };
  org: {
    name: string | null;
    logo_url: string | null;
    phone: string | null;
    email: string | null;
    license: string | null;
    brand_color: string | null;
    glass_tint: string | null;
    timezone: string | null;
  } | null;
  customer: { name: string | null; company_name: string | null } | null;
  job: {
    id: string;
    name: string | null;
    job_number: string | null;
    status: string | null;
    address: string | null;
    unit: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  billing: { billing_type: string | null; quote_statuses: (string | null)[]; milestones: number } | null;
  stretches: LedgerStretchIn[] | null;
  invoices: (LedgerInvoiceIn & { invoice_kind?: string | null; public_token: string | null; doc: PublicInvoiceDoc | null })[] | null;
  lines: LedgerLineIn[] | null;
  payments: LedgerPaymentIn[] | null;
  picks: RawPick[] | null;
  photos: { id: string; file_path: string | null; added_at: string | null }[] | null;
  /** 0326: the plans and drawings (absent before 0326 is applied: no section, never an error). */
  documents?: RawDocument[] | null;
  /** 0335: the panels the office shows on this job (absent before 0335: no section, never an error).
   *  Read field by field by normalizePortalPanels; never spread onto the page. */
  panels?: unknown;
};

/** One shared paper as portal_job_view returns it (0326): already only the newest of its chain. */
type RawDocument = {
  id: string;
  kind: string | null;
  title: string | null;
  file_path: string | null;
  added_at: string | null;
  shown_at: string | null;
  is_update: boolean | null;
};

/** The invoice document as portal_job_view returns it (invoice_document_projection). Its presence
 *  is the gate's word that the customer may see this bill; the page draws the bill from
 *  readInvoiceDocumentProps (the PDF's own props), never from these fields. */
export type PublicInvoiceDoc = {
  invoice: Record<string, unknown>;
  items: Record<string, unknown>[];
  payments: { amount: number; paid_at: string; method: string | null }[];
  customer: Record<string, unknown> | null;
  site_candidates: unknown[];
  org: Record<string, unknown> | null;
};

type RawPick = {
  id: string;
  category: string | null;
  brand: string | null;
  name: string | null;
  code: string | null;
  location: string | null;
  note: string | null;
  color_hex: string | null;
  link_url: string | null;
  file_path: string | null;
  file_kind: string | null;
  updated_at: string | null;
};

export type PortalInvoice = {
  number: string | null;
  status: string;
  isDraft: boolean;
  total: number;
  amountPaid: number;
  balance: number;
  /** The /i/<token> pay door: only for a bill that was sent. A draft has none (no Pay button). */
  payToken: string | null;
  /** The bill as the PDF draws it (readInvoiceDocumentProps): null when the customer is not shown
   *  one, or when its read failed (docFailed). */
  doc: InvoiceDocumentProps | null;
  /** The gate returned this bill, but its document could not be read: the page says so. */
  docFailed: boolean;
};
export type PortalPick = {
  id: string;
  category: string;
  brand: string | null;
  name: string | null;
  code: string | null;
  location: string | null;
  note: string | null;
  colorHex: string | null;
  linkUrl: string | null;
  file: { url: string; kind: "image" | "pdf" } | null;
};
/** addedOn: the day the photo was filed (documents.created_at), which is not always the day it was
 *  taken (a picture pulled from the library days later), so the page never calls it "taken". */
export type PortalPhoto = { id: string; url: string; addedOn: string | null };
/**
 * A plan, permit, circuit map, drawing, rendering or scan on the customer's page (0326). `format`
 * says how the page shows the file (a picture inline, a PDF in its viewer, anything else as a
 * plain link); `isUpdate`: it replaced an older version, so the page says "Updated" with its day.
 */
export type PortalDocument = {
  id: string;
  kind: PortalDocKind;
  kindLabel: string;
  title: string;
  format: DocFormat;
  url: string;
  /** The day the file was added (documents.created_at) in the org's time zone. */
  addedOn: string | null;
  isUpdate: boolean;
};

export type PortalJobView = {
  /** accent: the org's ink (accentHex, readable text on white). tint: the org's own glass color as
   *  "#rrggbb", the sea-glass skin's fill (the same lever the app dock reads). */
  org: { name: string; logoUrl: string | null; phone: string | null; email: string | null; license: string | null; accent: string; tint: string };
  customer: { name: string | null; companyName: string | null };
  job: {
    id: string;
    name: string;
    number: string | null;
    status: string;
    site: { address: string | null; unit: string | null; city: string | null; state: string | null; zip: string | null };
  };
  /** When this was read, and the org's day for it: the page says "as of". */
  asOf: string;
  asOfDay: string;
  timezone: string;
  /** A bill on the job is still a draft: "Running total, not a bill yet", and no Pay button for it. */
  running: boolean;
  ledger: JobLedger;
  invoices: PortalInvoice[];
  picks: PortalPick[];
  photos: PortalPhoto[];
  /** 0326: the plans and drawings, grouped by kind in PORTAL_DOC_KINDS order, newest first within. */
  documents: PortalDocument[];
  /** 0335: "Your Panel", once the office turns it on for the job: each shown panel and its kept
   *  circuits in space order, customer-safe fields only (lib/panel/directory). Empty when off. */
  panels: DirectoryPanel[];
  /** The work not on a bill yet, at the customer's price. null on a job that bills a contract or draws. */
  unbilled: CustomerUnbilled | null;
};

/** The default sea-glass teal (org-settings DEFAULT_SETTINGS.glass_tint). */
const DEFAULT_TINT = "#1b9488";
/** The job statuses a customer is shown (customer_portal and portal_job_view, 0301): the same
 *  fail-closed allowlist, so the office can say when a job is not on the customer's page. */
export const CUSTOMER_SHOWN_JOB_STATUSES: readonly string[] = ["to_be_scheduled", "scheduled", "in_progress", "on_hold", "complete", "invoiced"];
const SENT = new Set(["sent", "partial", "paid", "overdue"]);
const HEX = /^#[0-9a-f]{6}$/i;
const HTTPS = /^https:\/\/[^\s]+$/i;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Is this pick file where a pick file for this job must live? */
export function isPickPath(path: string | null | undefined, orgId: string, jobId: string): path is string {
  return typeof path === "string" && path.startsWith(`${orgId}/picks/${jobId}/`) && !path.includes("..");
}
/** Is this photo filed under this job's own folder? */
export function isJobPhotoPath(path: string | null | undefined, orgId: string, jobId: string): path is string {
  return typeof path === "string" && path.startsWith(`${orgId}/${jobId}/`) && !path.includes("..");
}

/**
 * Does a pick say anything yet? There is no publish step, so "Add Pick" is on the customer's page
 * the moment the office presses it. A pick with only its category (the office still typing) would
 * be a card titled "Paint Color" that opens to nothing: it stays off the page until it has a
 * name, a code, a brand, a swatch, a file or a link. A note or a room alone does not say what the
 * pick IS, so it waits too.
 */
export function pickHasContent(p: Pick<RawPick, "name" | "code" | "brand" | "color_hex" | "link_url" | "file_path" | "file_kind">): boolean {
  const has = (v: string | null | undefined) => typeof v === "string" && v.trim() !== "";
  return (
    has(p.name) ||
    has(p.code) ||
    has(p.brand) ||
    (typeof p.color_hex === "string" && HEX.test(p.color_hex)) ||
    (typeof p.link_url === "string" && HTTPS.test(p.link_url)) ||
    (has(p.file_path) && (p.file_kind === "image" || p.file_kind === "pdf"))
  );
}

/** The storage paths the server has to sign for this page, and nothing else. */
export function portalPathsToSign(raw: PortalJobRaw): string[] {
  const { org_id: orgId, job_id: jobId } = raw.scope;
  const out: string[] = [];
  for (const p of raw.picks ?? []) if (pickHasContent(p) && isPickPath(p.file_path, orgId, jobId) && (p.file_kind === "image" || p.file_kind === "pdf")) out.push(p.file_path);
  for (const p of raw.photos ?? []) if (isJobPhotoPath(p.file_path, orgId, jobId)) out.push(p.file_path);
  for (const d of raw.documents ?? []) if (isJobPhotoPath(d.file_path, orgId, jobId)) out.push(d.file_path);
  return out;
}

export function shapePortalJob(
  raw: PortalJobRaw,
  extra: {
    signed: ReadonlyMap<string, string>;
    unbilled: CustomerUnbilled | null;
    now: Date;
    /** The org's supplier names (fetchSupplierNames, pinned to the scope's org). */
    suppliers?: ReadonlySet<string>;
    /** Each bill's document, by invoice id (readInvoiceDocumentProps, pinned to this org and job). */
    docs?: ReadonlyMap<string, InvoiceDocRead>;
  },
): PortalJobView {
  const { org_id: orgId, job_id: jobId } = raw.scope;
  const tz = getOrgSettings({ timezone: raw.org?.timezone ?? undefined }).timezone;
  // NO LINE NAMES A SUPPLIER, on the ledger or on the bill (audit v994 PL1, scrub on read). 0315
  // makes portal_job_view and the invoice projection do this themselves; this is the last door,
  // and the one that holds before 0315 is applied. Same rule, same words (customerLineWords).
  const words = (l: { description?: unknown; import_source?: unknown }) =>
    customerLineWords({ description: typeof l.description === "string" ? l.description : null, import_source: typeof l.import_source === "string" ? l.import_source : null }, extra.suppliers);
  // The bills themselves are drawn from readInvoiceDocumentProps (extra.docs), whose lines are the
  // customer's words already; the projection's own document is only the gate's word that it shows.
  const invoicesRaw = raw.invoices ?? [];
  const lines = (raw.lines ?? []).map((l) => ({ ...l, description: words(l) }));

  const ledger = buildJobLedger({
    stretches: raw.stretches ?? [],
    invoices: invoicesRaw,
    lines,
    payments: raw.payments ?? [],
    tz,
  });

  const invoices: PortalInvoice[] = invoicesRaw.map((i) => {
    const sent = SENT.has(i.status);
    const read = i.doc ? extra.docs?.get(String(i.id)) : undefined;
    return {
      number: i.invoice_number ?? null,
      status: i.status,
      isDraft: i.status === "draft",
      total: num(i.total),
      amountPaid: num(i.amount_paid),
      balance: invoiceBalance(num(i.total), num(i.amount_paid)),
      payToken: sent ? str(i.public_token) : null,
      doc: read?.kind === "ok" ? read.props : null,
      docFailed: !!i.doc && read?.kind !== "ok",
    };
  });

  const picks: PortalPick[] = (raw.picks ?? []).filter(pickHasContent).map((p) => {
    const kind = p.file_kind === "image" || p.file_kind === "pdf" ? p.file_kind : null;
    const url = kind && isPickPath(p.file_path, orgId, jobId) ? extra.signed.get(p.file_path) : undefined;
    return {
      id: p.id,
      category: str(p.category) ?? "Pick",
      brand: str(p.brand),
      name: str(p.name),
      code: str(p.code),
      location: str(p.location),
      note: str(p.note),
      colorHex: p.color_hex && HEX.test(p.color_hex) ? p.color_hex : null,
      linkUrl: p.link_url && HTTPS.test(p.link_url) ? p.link_url : null,
      file: url && kind ? { url, kind } : null,
    };
  });

  const photos: PortalPhoto[] = [];
  for (const p of raw.photos ?? []) {
    if (!isJobPhotoPath(p.file_path, orgId, jobId)) continue;
    const url = extra.signed.get(p.file_path);
    if (!url) continue;
    photos.push({ id: p.id, url, addedOn: p.added_at ? todayStrInTz(tz, new Date(p.added_at)) : null });
  }

  // THE PLANS AND DRAWINGS (0326). The database already chose them (the office showed them, the
  // category is allowed, nothing ties them to money, only the newest of each chain); this door
  // keeps the page to the job's own folder and the signed URL, as for the photos. A kind this build
  // does not know shows as a Document rather than vanishing.
  const documents: PortalDocument[] = [];
  for (const d of raw.documents ?? []) {
    if (!isJobPhotoPath(d.file_path, orgId, jobId)) continue;
    const url = extra.signed.get(d.file_path);
    if (!url) continue;
    const kind: PortalDocKind = isPortalDocKind(d.kind) ? d.kind : "document";
    documents.push({
      id: d.id,
      kind,
      kindLabel: kindLabel(kind),
      title: str(d.title) ?? kindLabel(kind),
      format: docFormat(d.file_path),
      url,
      addedOn: d.added_at ? todayStrInTz(tz, new Date(d.added_at)) : null,
      isUpdate: d.is_update === true,
    });
  }
  // Stable sort: the database's order (newest shown first) holds inside each kind.
  documents.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));

  const org = raw.org;
  return {
    org: {
      name: str(org?.name) ?? "Your contractor",
      logoUrl: str(org?.logo_url),
      phone: str(org?.phone),
      email: str(org?.email),
      license: str(org?.license),
      accent: accentHex(str(org?.glass_tint)),
      tint: org?.glass_tint && HEX.test(org.glass_tint) ? org.glass_tint.toLowerCase() : DEFAULT_TINT,
    },
    customer: { name: str(raw.customer?.name), companyName: str(raw.customer?.company_name) },
    job: {
      id: raw.job.id,
      name: str(raw.job.name) ?? "Your job",
      number: str(raw.job.job_number),
      status: str(raw.job.status) ?? "in_progress",
      site: {
        address: str(raw.job.address),
        unit: str(raw.job.unit),
        city: str(raw.job.city),
        state: str(raw.job.state),
        zip: str(raw.job.zip),
      },
    },
    asOf: extra.now.toISOString(),
    asOfDay: todayStrInTz(tz, extra.now),
    timezone: tz,
    running: invoices.some((i) => i.isDraft),
    ledger,
    invoices,
    picks,
    photos,
    documents,
    panels: normalizePortalPanels(raw.panels),
    unbilled: extra.unbilled,
  };
}
