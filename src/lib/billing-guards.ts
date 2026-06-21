/** H4 ("one billing path per job") — the REVERSE-direction guard.
 *
 *  The forward guard lives in billing/actions.ts (activeDrawOnJob + the import/create
 *  chokepoints): it blocks putting STANDARD content on a job that already has a draw.
 *  This module guards the opposite order — block creating a progress DRAW on a job
 *  that is already being billed on a standard invoice carrying content. Without it,
 *  the sequence "standard invoice with imported labor/materials → then a deposit /
 *  progress / final draw" bills the same work twice (the draw re-imports the actuals,
 *  or bills a % of the estimate, independent of the standard invoice).
 *
 *  It's a separate module (not a billing/actions.ts export) because both draw-creation
 *  paths need it — createProgressReportInvoice (billing/actions.ts) and
 *  createProgressInvoice (recurring/actions.ts) — and "use server" files can only
 *  export async server actions. */

import { isStandardBillingBlocker } from "@/lib/invoice-math";

type BlockerInvoice = { id: string; status: string; invoice_number: string | null };

/** The job's non-void STANDARD invoice that already carries billable content
 *  (line items / a non-zero total), or null. The mirror of activeDrawOnJob — the
 *  signal that the job is on the STANDARD billing path. invoice_kind is NOT NULL
 *  DEFAULT 'standard' (migration 0063), so a plain `.eq("invoice_kind","standard")`
 *  catches every non-draw invoice, including those created without an explicit kind. */
export async function standardBillingBlockerOnJob(
  supabase: any,
  jobId: string | null | undefined,
): Promise<BlockerInvoice | null> {
  if (!jobId) return null;

  const { data: invs } = await supabase
    .from("invoices")
    .select("id, status, invoice_number, total, invoice_kind")
    .eq("job_id", jobId)
    .eq("invoice_kind", "standard")
    .neq("status", "void");
  const rows = (invs ?? []) as Array<BlockerInvoice & { total: number | null; invoice_kind: string }>;
  if (!rows.length) return null;

  // Count line items per candidate in one batched query, so a $0-total standard
  // invoice that still carries lines (e.g. not-yet-recalced, or net-zero edits) is
  // caught too — not just the common positive-total case.
  const { data: items } = await supabase
    .from("invoice_items")
    .select("invoice_id")
    .in("invoice_id", rows.map((r) => r.id));
  const counts = new Map<string, number>();
  for (const it of (items ?? []) as Array<{ invoice_id: string }>) {
    counts.set(it.invoice_id, (counts.get(it.invoice_id) ?? 0) + 1);
  }

  const hit = rows.find((r) =>
    isStandardBillingBlocker(r.invoice_kind, Number(r.total ?? 0), counts.get(r.id) ?? 0),
  );
  return hit ? { id: hit.id, status: hit.status, invoice_number: hit.invoice_number } : null;
}

/** The block message when a draw would double-bill work already on a standard invoice
 *  — points the user at the existing invoice instead of silently re-billing. */
export function standardBillingConflictError(inv: BlockerInvoice): { ok: false; error: string } {
  const label = inv.invoice_number ? `Invoice ${inv.invoice_number}` : "A standard invoice";
  return {
    ok: false,
    error: `${label} on this job is already billing labor/materials — bill the rest there, or void it before switching this job to progress draws.`,
  };
}
