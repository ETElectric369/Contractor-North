/**
 * WHICH INVOICE HOLDS A COST — read BY THE COST, never by the job (task 4 fork #2, 2026-10-09).
 *
 * Three screens asked "what do this receipt's jobs' invoices claim?" (invoice_items joined through
 * invoices.job_id). A claim is per ROW, not per job (unbilled-work.ts, claimedSourcesOnJob): a
 * receipt billed on job A and moved to job B afterwards is still billed, and a read scoped to B's
 * invoices called it unclaimed — offering its lines to a second invoice. This is the one read those
 * screens share now: org-wide (RLS scopes it), by the two claim shapes a line can carry, the
 * `source_ids` array (0255) and the `bill:<id>` import key older invoices carry.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type CostClaimRow = {
  import_key: string | null;
  source_ids: string[] | null;
  invoices: { invoice_number: string | null; status: string; created_at: string | null; job_id: string | null } | null;
};

/** One PostgREST request's worth of ids. */
export const COST_CLAIM_CHUNK = 100;

/**
 * The filter for one chunk: a line whose source_ids overlap these ids, or whose import key names
 * one of them (`bill:<id>`, and `po:<id>` when asked). Ids are uuids, so the array literal needs no
 * quoting; the keys are quoted because PostgREST's `in` list is comma-split.
 */
export function costClaimFilter(ids: readonly string[], keyed: readonly string[] = ["bill"]): string {
  const ov = `source_ids.ov.{${ids.join(",")}}`;
  const keys = keyed.flatMap((p) => ids.map((id) => `"${p}:${id}"`));
  return keys.length ? `${ov},import_key.in.(${keys.join(",")})` : ov;
}

/**
 * Every non-void invoice line that claims one of these costs, with its invoice. `drafts` false
 * leaves draft invoices out (a draft's lines are still editable, so some screens do not call that
 * "held"). A failed chunk stops the read and is returned; the caller decides what a lost read means
 * on its screen (usually: the switches stay live, never a false "already billed").
 */
export async function readClaimsOnCosts(
  supabase: SupabaseClient,
  ids: Iterable<string>,
  opts: { drafts: boolean; keyed?: readonly string[] },
): Promise<{ rows: CostClaimRow[]; error: unknown | null }> {
  const all = [...new Set([...ids].map((x) => String(x ?? "")).filter(Boolean))];
  const rows: CostClaimRow[] = [];
  for (let i = 0; i < all.length; i += COST_CLAIM_CHUNK) {
    let q = supabase
      .from("invoice_items")
      .select("import_key, source_ids, invoices!inner(invoice_number, status, created_at, job_id)")
      .or(costClaimFilter(all.slice(i, i + COST_CLAIM_CHUNK), opts.keyed))
      .neq("invoices.status", "void");
    if (!opts.drafts) q = q.neq("invoices.status", "draft");
    const { data, error } = await q.limit(5000);
    if (error) return { rows, error };
    rows.push(...((data ?? []) as unknown as CostClaimRow[]));
  }
  return { rows, error: null };
}
