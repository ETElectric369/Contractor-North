import { formatDateShort } from "@/lib/utils";
import { isCostableCategory, sortJobPapers, type JobPaperRow, type PaperTie } from "@/lib/job-photos";
import { firstNameOf, jobWords } from "./words";

/**
 * RECEIPTS NOT ON A BILL (Wave 1, NY-feeders; closes lane 3's tech-photo path).
 *
 * A crew member's photo from Snap Or Note is filed on the job for the office, unread (the reader
 * never runs for a tech), and a staff snap whose read failed sits on the job the same way: a receipt
 * or a bill on the job that no bill, supplier document or petty cash accounts for. The job's Costs
 * tab lists it as Not On A Bill Yet beside Record As Cost, but nothing brought it to anyone: a cost
 * nobody recorded is a cost no invoice bills. Now it comes to Needs You, by lib/job-photos' OWN rule
 * (sortJobPapers(...).loose): never a second copy of what "on a bill" means.
 *
 *   · Receipt or Bill papers only (isCostableCategory): an Invoice is money paper too, but nothing
 *     reads one into a bill, so a row for it would have no button to answer it;
 *   · on a job, dated on or after the books start (the caller's read);
 *   · a failed read of the ties claims NOTHING (loose is null): saying a receipt is on no bill when it
 *     may be would offer a second bill for the same money. The build draws one line instead,
 *     "Receipts · Couldn't Check".
 *
 * No amount on the row: nothing has read the paper. Staff only, like every money feeder.
 */

/** The most receipts one build reads (newest first); a capped read says "200+", never a short count. */
export const RECEIPTS_READ_CAP = 200;

/** The papers the reader turns into bills: the categories the documents read asks for. */
export const RECEIPT_CATEGORIES = ["Receipt", "Bill"] as const;

/** The ties' columns: exactly what sortJobPapers reads (the job page asks for the same). */
export const RECEIPT_TIE_COLUMNS = "id, kind, category, document_id, bill_id, tied_bill_id, tied_supplier_invoice_id, petty_cash_id, file_url";

/** How many papers one tie read names, so no request's address grows past what a server takes. */
export const TIE_READ_CHUNK = 60;

export type ReceiptDoc = JobPaperRow & {
  job_id: string | null;
  uploaded_by?: string | null;
  created_at?: string | null;
  jobs?: { job_number?: string | null; name?: string | null } | { job_number?: string | null; name?: string | null }[] | null;
};

/** The receipts on a job that nothing accounts for; null when the ties couldn't be read. */
export function receiptsNotOnABill<D extends ReceiptDoc>(docs: readonly D[], ties: readonly PaperTie[] | null): D[] | null {
  const onJobs = (docs ?? []).filter((d) => !!d?.job_id && isCostableCategory(d.category));
  return sortJobPapers(onJobs, ties, []).loose;
}

/** A PostgREST `in` list, each value quoted (a file name may hold a comma or a parenthesis). */
export function postgrestIn(values: readonly string[]): string {
  return `(${values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

/**
 * The `.or()` filters that read these papers' ties: a tie names its document, or (filed from
 * Organize with no row on the job) its file. In chunks of TIE_READ_CHUNK papers, read side by side.
 */
export function tieReadFilters(docs: readonly ReceiptDoc[], chunk = TIE_READ_CHUNK): string[] {
  const out: string[] = [];
  const list = (docs ?? []).filter((d) => !!d?.id);
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk);
    const ids = part.map((d) => String(d.id));
    const paths = part.map((d) => d.file_url).filter((p): p is string => !!p);
    out.push([`document_id.in.${postgrestIn(ids)}`, ...(paths.length ? [`file_url.in.${postgrestIn(paths)}`] : [])].join(","));
  }
  return out;
}

/** "Receipt from Brian · Sep 27": what it is, who snapped it (when known), the day. */
export function receiptRowTitle(doc: Pick<ReceiptDoc, "category" | "created_at">, uploader: string | null | undefined, tz?: string): string {
  const what = doc.category === "Bill" ? "Bill" : "Receipt";
  const who = firstNameOf(uploader);
  const day = doc.created_at ? formatDateShort(doc.created_at, tz) : null;
  return [who ? `${what} from ${who}` : what, day && day !== "—" ? day : null].filter(Boolean).join(" · ");
}

/** The job it is on, name first ("Herringbone · J-011"). */
export function receiptRowJob(doc: Pick<ReceiptDoc, "jobs">): string {
  const j = Array.isArray(doc.jobs) ? doc.jobs[0] : doc.jobs;
  return jobWords(j ?? null);
}
