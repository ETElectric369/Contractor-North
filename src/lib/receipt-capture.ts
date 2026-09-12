/**
 * ONE RECEIPT UPLOADER — every door that takes a bill's paper on a job runs THIS pipeline.
 *
 * Three doors take a receipt: the Costs tab's Snap the Bill / Upload (job-cost-capture), the
 * Receipts & Documents uploader (job-documents) and the Add Cost sheet's photo (quick-cost-button).
 * Each carried its own copy of prep → path → upload → file → read, and the copies drifted: one
 * gated at 15 MB where the reader refuses at 8, one handed the reader raw HEICs it could only
 * refuse, one swallowed the reader's sentence. The steps and the numbers now live here once; a
 * door only renders the outcome in its own furniture.
 *
 * The pipeline: prepareImageForUpload (HEIC → JPEG, big phone shots downscaled, EXIF stripped)
 * → a storage path under the org and the job → the private `documents` bucket → a documents row
 * on the job (addDocument; a Receipt unless the door says otherwise) → when asked, billJobReceipt
 * reads the paper and WRITES the itemized bill. Nothing captured is lost on the way and nothing
 * fails silently: a file the reader can't take (over its cap, a name it refuses, no total) is
 * still FILED, and the outcome says so in a sentence that names the retry (Record as Cost under
 * Receipts & Documents) and the typed door (Add Cost).
 */

import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { formatCurrency } from "@/lib/utils";
import { addDocument } from "@/app/(app)/jobs/actions";
import { billJobReceipt } from "@/app/(app)/organize/actions";

/** The reader's ceiling — billJobReceipt refuses anything bigger, so the client gate is the SAME
 *  number, checked after prep (prep is what brings a 12 MB phone shot under it). One constant so
 *  the two can't drift apart again. */
export const RECEIPT_READ_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIPT_READ_MAX_LABEL = "8 MB";

export type ReceiptTone = "ok" | "warn" | "fail";

export type ReceiptOutcome =
  /** The reader wrote the bill. `warning` = its lines didn't add up to its total; the bill is in
   *  and the warning is on its notes — the door should still say it out loud. */
  | {
      kind: "billed";
      docId: string;
      tone: "ok" | "warn";
      sentence: string;
      vendor: string | null;
      amount: number | null;
      lineCount: number;
      warning: string | null;
    }
  /** This file already produced a bill — nothing added twice (organized_items.document_id). */
  | { kind: "already"; docId: string; tone: "ok"; sentence: string }
  /** Filed on the job as a document. The reader wasn't asked (a Plan, a Permit), or the file is
   *  over its cap, or it refused (a name it can't read, no total) — the sentence names which. */
  | { kind: "filed"; docId: string; tone: "ok" | "warn"; why: "not_asked" | "over_cap" | "refused"; sentence: string };

/** Nothing kept — the upload or the filing failed; the sentence says which and what to do. */
export type ReceiptLost = { kind: "lost"; tone: "fail"; sentence: string };

export type CaptureOutcome = ReceiptOutcome | ReceiptLost;

export type FiledReceipt =
  | { ok: true; docId: string; name: string; size: number }
  | { ok: false; error: string };

/** "412 KB" / "9.6 MB" — the size as a person reads it, for sentences and the documents list. */
export function prettyBytes(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TYPED_DOOR = "or type it in with Add Cost.";
const RETRY_DOOR = "Filed on the job under Receipts & Documents — Record as Cost there once it's fixed, " + TYPED_DOOR;

/**
 * Prep → upload → file. Returns the documents row's id (what the reader and the bill link need).
 * A failure comes back as a lowercase clause ("didn't upload (…)") so a door can lead with the
 * file's name or with "The receipt" and still read as one sentence.
 */
export async function fileReceiptDocument(o: {
  orgId: string;
  jobId: string;
  file: File;
  /** documents.category — "Receipt" unless the door filed it as something else. */
  category?: string;
}): Promise<FiledReceipt> {
  // Prep is best-effort: it hands back the original when it can't decode, and if it throws the
  // server's own refusal is the honest explanation, so the raw file still goes up.
  let file = o.file;
  try {
    file = await prepareImageForUpload(o.file);
  } catch {
    file = o.file;
  }
  const name = file.name || o.file.name || "receipt.jpg";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${o.orgId}/${o.jobId}/${Date.now()}-${safe}`;
  const { error: upErr } = await createClient().storage.from("documents").upload(path, file, { upsert: false });
  if (upErr) return { ok: false, error: `didn't upload (${upErr.message})` };
  // The filing is what makes the reader's idempotency link (organized_items.document_id) and
  // "Record as Cost" possible — a file in storage with no row is invisible to both.
  const doc = await addDocument({ job_id: o.jobId, name, category: o.category || "Receipt", file_url: path, size_bytes: file.size });
  if (!doc.ok || !doc.id) return { ok: false, error: `uploaded but couldn't be filed on the job (${doc.error ?? "no row came back"})` };
  return { ok: true, docId: doc.id, name, size: file.size };
}

/**
 * Read a receipt that is already filed on the job (a documents row) and write its bill — the
 * Record as Cost verb, and the last step of captureReceipt. The reader's own sentence comes back
 * verbatim when it refuses (it names the reason); every outcome names the next door.
 */
export async function readReceiptDocument(
  docId: string,
  /** What the PERSON stated on the form (paid, category, date) — attestation beats inference. */
  stated?: { paid?: boolean; category?: string | null; billDate?: string | null },
): Promise<ReceiptOutcome> {
  let res: Awaited<ReturnType<typeof billJobReceipt>>;
  try {
    res = await billJobReceipt(docId, stated);
  } catch (e: any) {
    res = { ok: false, error: e?.message ?? "Nort couldn't read it." };
  }
  if (!res.ok) {
    return { kind: "filed", docId, tone: "warn", why: "refused", sentence: `${res.error ?? "Nort couldn't read it."} ${RETRY_DOOR}` };
  }
  if (res.already) {
    return { kind: "already", docId, tone: "ok", sentence: "Already recorded as a cost — nothing added twice." };
  }
  const n = res.lineCount ?? 0;
  const total = res.amount != null ? formatCurrency(res.amount) : "no total read";
  const warning = res.warning ?? null;
  return {
    kind: "billed",
    docId,
    tone: warning ? "warn" : "ok",
    sentence: `Bill created — ${res.vendor ?? "receipt"}, ${total}, ${n} line${n === 1 ? "" : "s"}.${warning ? ` ${warning}` : ""}`,
    vendor: res.vendor ?? null,
    amount: res.amount ?? null,
    lineCount: n,
    warning,
  };
}

/**
 * The whole door in one call: file the paper, then (when `read`) have Nort write the bill.
 * The size gate sits HERE, after prep and before the reader, at the reader's own number: a file
 * over it is filed all the same and the sentence says why it wasn't read — never a dropped file,
 * never a round trip to be told the same thing.
 */
export async function captureReceipt(o: {
  orgId: string;
  jobId: string;
  file: File;
  category?: string;
  /** Ask the reader to write the bill. False for paper that isn't a cost (a Plan, a Permit). */
  read: boolean;
  stated?: { paid?: boolean; category?: string | null; billDate?: string | null };
}): Promise<CaptureOutcome> {
  const filed = await fileReceiptDocument(o);
  if (!filed.ok) return { kind: "lost", tone: "fail", sentence: `${filed.error[0].toUpperCase()}${filed.error.slice(1)} — try again, ${TYPED_DOOR}` };
  if (!o.read) return { kind: "filed", docId: filed.docId, tone: "ok", why: "not_asked", sentence: "Filed on the job." };
  if (filed.size > RECEIPT_READ_MAX_BYTES) {
    return {
      kind: "filed",
      docId: filed.docId,
      tone: "warn",
      why: "over_cap",
      sentence: `Filed on the job, but not read — it's ${prettyBytes(filed.size)} and Nort reads receipts up to ${RECEIPT_READ_MAX_LABEL}. Shrink it and tap Record as Cost under Receipts & Documents, ${TYPED_DOOR}`,
    };
  }
  return readReceiptDocument(filed.docId, o.stated);
}
