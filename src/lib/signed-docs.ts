import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * ONE ROUND TRIP FOR A LIST OF DOCUMENTS (2026-09-08 — the phone-lag sweep).
 *
 * Five list pages each signed their attachments with `Promise.all(rows.map(createSignedUrl))`:
 * concurrent, but still one HTTP request to Storage PER ROW, and every one of them has to finish
 * before the page can render. A job hub with twenty documents opened twenty connections to sign
 * URLs the visitor may never click — on the /jobs/<id>?tab=materials view, none of them.
 *
 * storage-js already has the batch verb. This wraps it so every list page shares the same
 * behaviour: rows with no file (an Organize note filed to a job is a documents row with
 * file_url null) map to null without being sent, an unsignable path maps to null rather than
 * throwing, and the result is a plain path → url map the caller reads by row.
 */
export async function signDocumentUrls(
  supabase: SupabaseClient,
  paths: (string | null | undefined)[],
  expiresIn = 3600,
  bucket = "documents",
): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(paths.filter((p): p is string => !!p)));
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  try {
    const { data } = await supabase.storage.from(bucket).createSignedUrls(wanted, expiresIn);
    for (const row of data ?? []) {
      // Per-path failure is reported IN the row (row.error), not thrown — a single missing
      // object must not blank every other document's link.
      if (row?.path && row?.signedUrl) out.set(row.path, row.signedUrl);
    }
  } catch {
    // Storage unreachable → every link renders as "not available" rather than the page 500ing.
  }
  return out;
}
