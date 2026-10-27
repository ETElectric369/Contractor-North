import type { SupabaseClient } from "@supabase/supabase-js";
import { isLiveQuote } from "@/lib/invoice-import-rule";
import { revisionOf } from "@/lib/estimate/revision";
import { dbError } from "@/lib/db-error";

/**
 * THE ESTIMATE A VISIT ALREADY BECAME (cn-v1132, S1). saveQuote stamps the estimate's id inside the
 * visit's capture (capture.quote_id); the Inspector reads it to offer Open The Estimate instead of
 * Start The Estimate. The new-estimate page itself never asked, so a second open of
 * /quotes/new?capture=<id> — a stale link, a second tab, a Back — rendered an unsaved editor whose
 * first save birthed a TWIN and overwrote the backlink (last writer wins). This is the one answer
 * both doors read: the id to OPEN, or null when the visit has no estimate standing.
 *
 *   · null id → null (the visit never became an estimate).
 *   · a row this company cannot read → null (RLS: not ours, or gone) — a fresh estimate is right.
 *   · superseded → its standing revision (revisionOf), which is the paper for this work now; a
 *     superseded estimate with no revision standing is his again, and is opened.
 *   · declined / expired → null: the visit's estimate is over, and Start The Estimate is honest.
 *   · a failed read THROWS (dbError's words): an estimate is never started over a visit this page
 *     could not read, the same rule the capture read above it follows.
 */
export async function liveEstimateBehindVisit(sb: SupabaseClient, quoteId: string | null): Promise<string | null> {
  if (!quoteId) return null;
  const { data, error } = await sb.from("quotes").select("id, status").eq("id", quoteId).maybeSingle();
  if (error) throw new Error(dbError(error));
  const q = data as { id: string; status: string | null } | null;
  if (!q) return null;
  if (q.status === "superseded") {
    const rev = await revisionOf(sb, { quoteId: q.id, orgId: null });
    return rev?.id ?? q.id;
  }
  return isLiveQuote(q.status) ? q.id : null;
}
