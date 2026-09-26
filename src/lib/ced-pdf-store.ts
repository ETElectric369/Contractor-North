import { isPdfBytes } from "@/lib/pdf-text";
import { sha256Hex } from "@/lib/content-hash";

/**
 * THE CED PDF ITSELF, KEPT (Erik, 2026-09-26: Open Bill said "The PDF itself isn't kept here").
 *
 * The CED import used to keep only the file's NAME in supplier_invoices.source_file. Now the bytes
 * go to the PRIVATE documents bucket, under the staff-only `organize` prefix (docs_path_is_staff_only,
 * 0213/0247/0300: supplier costs, and a tech never sees a price), at a path named by the file's
 * SHA-256:
 *
 *   <org_id>/organize/ced/<sha256>.pdf
 *
 * THE CONTENT IS THE KEY. One PDF that holds four invoices is stored once and all four rows name the
 * same path. The same PDF chosen again next month, renamed or not, lands on the same path, so it is
 * never stored twice: the upload is upsert:false and "already there" is the answer we wanted.
 *
 * source_file then holds that PATH (0326 already reads source_file as a stored file). A row whose
 * source_file is still a bare name came in before this, or its upload failed: Open Bill says the
 * PDF wasn't saved, and choosing the same PDF again fills the path in.
 */

/** A CED PDF bigger than this is not stored (the drop box's own ceiling is 15 MB). */
export const CED_PDF_MAX_BYTES = 15 * 1024 * 1024;

export const cedPdfPath = (orgId: string, sha256: string) => `${orgId}/organize/ced/${sha256}.pdf`;

/** A path in this org's documents bucket, as opposed to a bare file name ("invoice_8802-1107139.pdf"). */
export function isStoredPaperPath(value: string | null | undefined, orgId: string | null | undefined): boolean {
  const v = String(value ?? "");
  return !!orgId && v.startsWith(`${orgId}/`) && v.length > orgId.length + 1;
}

/** Storage's "that object is already there" (upsert:false on a path that exists), and nothing else. */
function alreadyThere(error: unknown): boolean {
  const e = error as { message?: unknown; statusCode?: unknown; status?: unknown } | null;
  return String(e?.statusCode ?? "") === "409" || Number(e?.status) === 409 || /already exists|duplicate/i.test(String(e?.message ?? ""));
}

/** Bytes as a server action or a download hands them over, as one Uint8Array. */
export function pdfBytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export type KeptPdf = { ok: true; path: string; uploaded: boolean } | { ok: false; error: string };

/**
 * Store one CED PDF, or say in words why it wasn't. Never throws: a PDF that did not save never
 * blocks the documents inside it from landing. `known` is paths this org's rows already name (the
 * importer reads them in one query), so a PDF already stored is not even sent again.
 */
export async function keepCedPdf(
  supabase: any,
  orgId: string,
  bytes: Uint8Array,
  known: ReadonlySet<string> = new Set(),
): Promise<KeptPdf> {
  if (!isPdfBytes(bytes)) return { ok: false, error: "it isn't a PDF inside" };
  if (bytes.byteLength > CED_PDF_MAX_BYTES) return { ok: false, error: "it is over 15 MB" };
  let path: string;
  try {
    path = cedPdfPath(orgId, await sha256Hex(bytes));
  } catch {
    return { ok: false, error: "it couldn't be fingerprinted" };
  }
  if (known.has(path)) return { ok: true, path, uploaded: false };
  try {
    const { error } = await supabase.storage.from("documents").upload(path, bytes, { contentType: "application/pdf", upsert: false });
    if (!error) return { ok: true, path, uploaded: true };
    if (alreadyThere(error)) return { ok: true, path, uploaded: false };
    return { ok: false, error: `the upload failed (${String((error as { message?: unknown })?.message ?? "no reason given")})` };
  } catch (e) {
    return { ok: false, error: `the upload failed (${(e as Error)?.message ?? "no reason given"})` };
  }
}
