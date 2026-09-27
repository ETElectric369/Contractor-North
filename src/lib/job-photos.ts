/**
 * PHOTOS ARE NOT BILLS (Erik, 2026-09-27: "photos should have a distinction between bills and job
 * photos and maybe even keep them separate").
 *
 * The job's Photos tab picked its pictures by file extension, so every receipt snapped on a job (a
 * .jpg in the job's own folder) sat in the grid between the panel shots: ET had 40 Photo and 40
 * Receipt documents on its jobs, all in one grid. Now every picture on a job has one home, by what
 * it IS:
 *
 *   · THE PHOTOS GRID: a picture filed as a Photo (the Photos tab's camera and Upload, the dock's
 *     Photo button, Organize's Job Photo), and a picture nobody filed as anything that no paper
 *     reader ever touched (no organized_items row names it).
 *   · PLANS & OTHER PAPERS, a fold under the grid: a Plan, Permit, Note or Other picture. Not a
 *     job-site photo (Organize files a picture a person called "Something Else" as Other on purpose),
 *     not money either, and for a tech the Photos tab is the only place it shows, so it stays there.
 *   · WITH ITS BILL (the Costs tab, and the bill's row on /bills): a Receipt, a Bill, an Invoice, a
 *     picture tied to a bill, and an unfiled picture a paper reader handled. The tie is the one the
 *     receipt reader, Add Cost and File It already write: organized_items.bill_id (or tied_bill_id,
 *     Same Purchase: Tie Them) beside document_id. A receipt or bill tied to no bill at all is listed
 *     in the Costs tab's Receipts & Papers and says so, beside its Record As Cost, so nothing leaves a
 *     screen silently. An Invoice on no bill is only listed: nothing reads one into a bill, so a flag
 *     on it would have no button to answer it.
 *
 * A TECH'S VIEW DOES NOT MOVE. The page hands a tech only the allow-listed papers (tech-documents:
 * no Receipt, Bill, Invoice or uncategorized paper is ever signed for him) and no ties, so he sees
 * the same pictures as before, the plans in their fold.
 *
 * Pure, so the page, the tab chip, the Costs tab and the tests read one rule.
 */

import { isTechDocument } from "@/lib/tech-documents";
import { COMPANY_PAPER_CATEGORIES, organizeRowIsMoney } from "@/lib/portal/doc-kinds";

/** The money papers (the portal's own list: never shown to a customer either). They live with their
 *  bill, never in the Photos grid. */
export function isMoneyCategory(category: string | null | undefined): boolean {
  return (COMPANY_PAPER_CATEGORIES as readonly string[]).includes(String(category ?? ""));
}

/** The papers the receipt reader turns into a bill: a Receipt or a Bill. The Costs tab's upload
 *  reads these and Record As Cost is offered on these, so these alone can be "Not On A Bill Yet"
 *  (an Invoice is money paper too, but nothing reads it into a bill: the flag would be a dead end). */
export function isCostableCategory(category: string | null | undefined): boolean {
  return category === "Receipt" || category === "Bill";
}

const IMAGE_FILE = /\.(jpe?g|png|webp|gif|heic)($|\?)/i;
const PDF_FILE = /\.pdf($|\?)/i;

/** A documents row, as much of it as the sorting needs. */
export type JobPaperRow = {
  id: string;
  name: string | null;
  category: string | null;
  file_url: string | null;
  signedUrl?: string | null;
};

/** An organized_items row that names a paper: the reader's, Add Cost's or File It's link. */
export type PaperTie = {
  id?: string | null;
  kind?: string | null;
  document_id: string | null;
  bill_id: string | null;
  tied_bill_id?: string | null;
  /** Tied to a supplier's document, or to petty cash: on the books, just not as a bill here. */
  tied_supplier_invoice_id?: string | null;
  petty_cash_id?: string | null;
  file_url: string | null;
  /** The category it was filed under (Receipt, Bill, Invoice, Fuel…), when the row says. */
  category?: string | null;
};

/** The file's own name says picture: the signed URL (which carries the stored path), else the
 *  stored path, else the name a person gave it. */
export function isImageDoc(d: Pick<JobPaperRow, "name" | "file_url" | "signedUrl">): boolean {
  return IMAGE_FILE.test(String(d.signedUrl ?? d.file_url ?? d.name ?? ""));
}

function isPdfPath(...paths: (string | null | undefined)[]): boolean {
  return paths.some((p) => PDF_FILE.test(String(p ?? "")));
}

/** The bill a tie puts its paper on, if any. */
export function billOfTie(t: PaperTie): string | null {
  return t.bill_id ?? t.tied_bill_id ?? null;
}

/** The paper is on the books through this tie: a bill, a supplier's document or petty cash. */
function accountedBy(t: PaperTie): boolean {
  return !!(billOfTie(t) || t.tied_supplier_invoice_id || t.petty_cash_id);
}

export type SortedJobPapers<D extends JobPaperRow> = {
  /** The Photos grid. */
  photos: D[];
  /** Plans & Other Papers: the fold under the grid. */
  pictures: D[];
  /** How many pictures on this job live on the Costs tab instead (the Photos tab says where). */
  moneyPictures: number;
  /** Bill id (a bill on this job) → its papers among this job's documents, picture or PDF. */
  byBill: Record<string, D[]>;
  /** Receipts and bills on the books through nothing (no bill anywhere, no supplier's document, no
   *  petty cash): "Not On A Bill Yet", beside Record As Cost. Never an Invoice (isCostableCategory).
   *  null = the ties couldn't be read, so nothing is claimed. */
  loose: D[] | null;
  /** The documents the Photos tab holds (grid and fold), for the Costs tab's own list. */
  photoTabIds: Set<string>;
};

/**
 * Sort a job's documents by what they are. `ties` null means the organized_items read failed: the
 * category still decides (a Receipt is never a photo), an unfiled picture stays in the grid, and no
 * paper is called loose, because saying a receipt is on no bill when it may be would offer a second
 * bill for the same money.
 */
export function sortJobPapers<D extends JobPaperRow>(
  docs: readonly D[],
  ties: readonly PaperTie[] | null,
  jobBillIds: Iterable<string>,
): SortedJobPapers<D> {
  const bills = new Set(Array.from(jobBillIds, String));
  const byDoc = new Map<string, PaperTie[]>();
  const byPath = new Map<string, PaperTie[]>();
  for (const t of ties ?? []) {
    // A tie names its document; one with no document (a paper filed from Organize with no row on
    // the job) is matched by its file.
    const key = t.document_id ? String(t.document_id) : null;
    if (key) byDoc.set(key, [...(byDoc.get(key) ?? []), t]);
    else if (t.file_url) byPath.set(t.file_url, [...(byPath.get(t.file_url) ?? []), t]);
  }

  const photos: D[] = [];
  const pictures: D[] = [];
  const byBill: Record<string, D[]> = {};
  const loose: D[] = [];
  let moneyPictures = 0;

  for (const d of docs) {
    const mine = [...(byDoc.get(String(d.id)) ?? []), ...(d.file_url ? (byPath.get(d.file_url) ?? []) : [])];
    const here = mine.map(billOfTie).find((b) => !!b && bills.has(String(b)));
    if (here) (byBill[here] ??= []).push(d);

    const category = d.category || null;
    if (isCostableCategory(category) && !mine.some(accountedBy)) loose.push(d);

    if (!isImageDoc(d)) continue;
    // A person or a door said Photo: a photo, whatever else it is tied to.
    if (category === "Photo") photos.push(d);
    // Filed as nothing: a photo, unless a paper reader handled it (then it is paperwork).
    else if (!category && mine.length === 0) photos.push(d);
    // A plan, permit, note or other paper: the fold under the grid, unless it is tied to money.
    else if (category && isTechDocument(d) && !mine.some(organizeRowIsMoney)) pictures.push(d);
    // A receipt, a bill, an invoice, money paper by its tie, or a category nobody allowed yet.
    else moneyPictures++;
  }

  return {
    photos,
    pictures,
    moneyPictures,
    byBill,
    loose: ties ? loose : null,
    photoTabIds: new Set([...photos, ...pictures].map((d) => String(d.id))),
  };
}

/** Ties that put a paper on one of this job's bills when the paper is not one of this job's
 *  documents (a bill moved here from another job keeps its receipt on the old one; a paper filed
 *  from Organize may have no row at all). Their own file is signed so the bill still opens it. */
export function papersOffThisJob(ties: readonly PaperTie[] | null, docs: readonly JobPaperRow[], jobBillIds: Iterable<string>): PaperTie[] {
  const bills = new Set(Array.from(jobBillIds, String));
  const ids = new Set(docs.map((d) => String(d.id)));
  const paths = new Set(docs.map((d) => d.file_url).filter(Boolean) as string[]);
  return (ties ?? []).filter((t) => {
    const b = billOfTie(t);
    if (!b || !bills.has(String(b)) || !t.file_url) return false;
    return !(t.document_id && ids.has(String(t.document_id))) && !paths.has(t.file_url);
  });
}

/** A bill's paper, as its door needs it. */
export type BillPaper = {
  id: string;
  name: string;
  url: string | null;
  kind: "image" | "pdf" | "file";
  /** The door's word: Receipt, Bill, Invoice, Photo, or Paper. */
  label: string;
};

function labelOf(category: string | null | undefined, tieKind?: string | null): string {
  const c = String(category ?? "");
  if (isMoneyCategory(c) || c === "Photo") return c;
  if (tieKind === "receipt") return "Receipt";
  return "Paper";
}

/** One paper, from a documents row (signed) or from a tie's own file. */
export function billPaperOf(d: JobPaperRow): BillPaper {
  const url = d.signedUrl ?? null;
  return {
    id: String(d.id),
    name: String(d.name ?? "Paper"),
    url,
    kind: isImageDoc(d) ? "image" : isPdfPath(url, d.file_url, d.name) ? "pdf" : "file",
    label: labelOf(d.category),
  };
}

/**
 * Each bill's papers, for its door: the bill's documents on this job, then any tie whose file is off
 * this job (signed by the caller, `urls` path → signed URL). One door per file per bill. Keyed by
 * bill id; a bill with no paper has no key and draws no door.
 */
export function billPapers(
  byBill: Record<string, readonly JobPaperRow[]>,
  offJob: readonly PaperTie[],
  urls: ReadonlyMap<string, string>,
  nameOfBill: (billId: string) => string = () => "Paper",
): Record<string, BillPaper[]> {
  const out: Record<string, BillPaper[]> = {};
  const seen = new Set<string>();
  const add = (billId: string, path: string | null, paper: BillPaper) => {
    const key = `${billId}|${path ?? paper.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    (out[billId] ??= []).push(paper);
  };
  for (const [billId, docs] of Object.entries(byBill)) for (const d of docs) add(billId, d.file_url, billPaperOf(d));
  for (const t of offJob) {
    const billId = billOfTie(t);
    if (!billId || !t.file_url) continue;
    add(billId, t.file_url, {
      id: String(t.id ?? t.file_url),
      name: nameOfBill(billId),
      url: urls.get(t.file_url) ?? null,
      kind: IMAGE_FILE.test(t.file_url) ? "image" : isPdfPath(t.file_url) ? "pdf" : "file",
      label: labelOf(t.category, t.kind ?? "receipt"),
    });
  }
  return out;
}
