/**
 * THE JOB PAPERS A CUSTOMER CAN BE SHOWN, AND HOW THE PORTAL SHOWS EACH (0326).
 *
 * Erik, 2026-09-24: "ill have a new circuit map to update the one made from the plan scans that
 * should post on the portal too" and "Lidar scans and renderingings will go there too when we
 * build that". Pure and client-safe: the office's share sheet, the server's checks and the
 * customer's page all read these lists, so they cannot disagree about what a paper is.
 *
 * TWO SEPARATE QUESTIONS:
 *   - KIND: what the paper IS to the customer (a plan, a circuit map, a 3D scan). The office picks
 *     it when it shows the paper; the portal groups and labels by it. The database holds the same
 *     list (job_shared_documents_kind_known).
 *   - FORMAT: what the FILE is, read from its name: a picture the page draws inline, a PDF it opens
 *     in its viewer, a 3D model, or anything else. THE SEAM for LiDAR scans and 3D renderings: a
 *     format the portal cannot draw today (a .glb, an .e57, a .usdz) is shown with its title and
 *     date and a plain Open The File link, never dropped. A 3D viewer later plugs in at "model".
 */

export const PORTAL_DOC_KINDS = [
  { key: "plan", label: "Plan", plural: "Plans" },
  { key: "circuit_map", label: "Circuit Map", plural: "Circuit Maps" },
  { key: "drawing", label: "Drawing", plural: "Drawings" },
  { key: "permit", label: "Permit", plural: "Permits" },
  { key: "rendering", label: "Rendering", plural: "Renderings" },
  { key: "scan_3d", label: "3D Scan", plural: "3D Scans" },
  { key: "document", label: "Document", plural: "Documents" },
  // Last: a photo shows in the Photos grid, not with the plans.
  { key: "photo", label: "Photo", plural: "Photos" },
] as const;

export type PortalDocKind = (typeof PORTAL_DOC_KINDS)[number]["key"];

export function isPortalDocKind(v: unknown): v is PortalDocKind {
  return typeof v === "string" && PORTAL_DOC_KINDS.some((k) => k.key === v);
}

export function kindLabel(kind: string | null | undefined): string {
  return PORTAL_DOC_KINDS.find((k) => k.key === kind)?.label ?? "Document";
}

/** Where a kind sorts on the customer's page: the order of PORTAL_DOC_KINDS. */
export function kindRank(kind: string | null | undefined): number {
  const i = PORTAL_DOC_KINDS.findIndex((k) => k.key === kind);
  return i < 0 ? PORTAL_DOC_KINDS.length : i;
}

/**
 * The document categories a customer may be shown: an ALLOW-list, the job papers a tech may see
 * too (tech-documents, less Note, which has no file). Twin of document_category_is_showable (0326).
 */
export const PORTAL_SHOWABLE_CATEGORIES = ["Photo", "Plan", "Permit", "Other"] as const;
/** The company's own money paper. Never shown, and said so by name. */
export const COMPANY_PAPER_CATEGORIES = ["Receipt", "Bill", "Invoice"] as const;

export function categoryIsShowable(category: string | null | undefined): boolean {
  return (PORTAL_SHOWABLE_CATEGORIES as readonly string[]).includes(String(category ?? ""));
}

/** Organize's categories for money paper (organized_items.category). */
const ORGANIZE_MONEY_CATEGORIES = ["Receipt", "Bill", "Invoice", "Materials", "Fuel", "Tools & Supplies", "Petty cash"];

/**
 * Is a paper money paper by what Organize tied it to, whatever its own category says now? Twin of
 * the organized_items half of document_is_money_paper (0326), for the office's sentence before the
 * round trip; the database also checks supplier invoices' source files, which only it reads.
 */
export function organizeRowIsMoney(r: {
  bill_id?: string | null;
  tied_bill_id?: string | null;
  tied_supplier_invoice_id?: string | null;
  petty_cash_id?: string | null;
  category?: string | null;
}): boolean {
  return !!(r.bill_id || r.tied_bill_id || r.tied_supplier_invoice_id || r.petty_cash_id) || ORGANIZE_MONEY_CATEGORIES.includes(String(r.category ?? ""));
}

export const MONEY_PAPER_REFUSAL = "This paper is tied to a bill, a supplier invoice or petty cash, so it is never shown to the customer.";

/** The kind a paper starts as when the office shows it, from how it is filed. */
export function defaultKindFor(category: string | null | undefined): PortalDocKind {
  switch (category) {
    case "Photo":
      return "photo";
    case "Plan":
      return "plan";
    case "Permit":
      return "permit";
    default:
      return "document";
  }
}

export type DocFormat = "image" | "pdf" | "model" | "file";

const IMAGE = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;
const PDF = /\.pdf$/i;
/** 3D models and point clouds: renderings and LiDAR scans. Shown as a link until a viewer exists. */
const MODEL = /\.(glb|gltf|usdz|obj|fbx|stl|ply|las|laz|e57|pts|xyz|3dm|skp)$/i;

/** What a file is, by its stored name (the path; a signed URL's query string is ignored). */
export function docFormat(pathOrName: string | null | undefined): DocFormat {
  const p = String(pathOrName ?? "").split("?")[0];
  if (IMAGE.test(p)) return "image";
  if (PDF.test(p)) return "pdf";
  if (MODEL.test(p)) return "model";
  return "file";
}

/** A title from a file's name: the extension off, the spaces tidied. */
export function titleFromName(name: string | null | undefined): string {
  const t = String(name ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.slice(0, 120);
}
