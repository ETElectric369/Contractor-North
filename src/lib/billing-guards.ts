/** H4 ("one billing path per job") — the REVERSE-direction guard, narrowed (0255).
 *
 *  The forward guard lives in billing/actions.ts (activeDrawOnJob + the import/create
 *  chokepoints): it blocks putting STANDARD content on a job that already has a draw.
 *  This module guards the opposite order — a progress DRAW on a job that has a standard
 *  invoice still OPEN AS A DRAFT with content on it.
 *
 *  Why only a draft (Erik, 2026-09-11, 85 Whitney): the old guard treated ANY content-carrying
 *  standard invoice as "the job is on the standard path" and refused every draw for the rest of
 *  the job's life — "Invoice INV-061 … bill the rest there, or void it", where INV-061 was PAID
 *  and line-locked, so neither instruction could be followed. It had to be that blunt because a
 *  labor line carried no record of WHICH hours it billed. Now it does (invoice_items.source_ids),
 *  a draw imports only unclaimed rows, and a sent/paid invoice is finished business. What remains
 *  worth blocking is an open draft: the office already has a document in progress for this job,
 *  and the honest door is to finish that one.
 *
 *  It's a separate module (not a billing/actions.ts export) because both draw-creation
 *  paths need it — createProgressReportInvoice (billing/actions.ts) and
 *  createProgressInvoice (recurring/actions.ts) — and "use server" files can only
 *  export async server actions. */

import { isStandardBillingBlocker } from "@/lib/invoice-math";

type BlockerInvoice = { id: string; status: string; invoice_number: string | null };

/** The job's DRAFT standard invoice that already carries billable content (line items / a
 *  non-zero total), or null. invoice_kind is NOT NULL DEFAULT 'standard' (migration 0063), so a
 *  plain `.eq("invoice_kind","standard")` catches every non-draw invoice, including those created
 *  without an explicit kind. Sent / partial / paid invoices are read and then rejected by the
 *  pure predicate — the DECISION stays in isStandardBillingBlocker, where it is unit-tested. */
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
    isStandardBillingBlocker(r.invoice_kind, r.status, Number(r.total ?? 0), counts.get(r.id) ?? 0),
  );
  return hit ? { id: hit.id, status: hit.status, invoice_number: hit.invoice_number } : null;
}

/** The block message when a draw would open a second document beside a draft that is already
 *  billing this job. Names the door that works: finish the draft (send it or delete it) — never
 *  "void it", which is the sentence that dead-ended Erik on a paid invoice. */
export function standardBillingConflictError(inv: BlockerInvoice): { ok: false; error: string } {
  const label = inv.invoice_number ? `Draft ${inv.invoice_number}` : "A draft invoice";
  return {
    ok: false,
    error: `${label} is still open on this job — finish it first (send it, or delete it), then request the next payment. New time and bills go on that draft when you pull them in.`,
  };
}
