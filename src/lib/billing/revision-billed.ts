import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { claimedSourcesOnJob } from "@/lib/unbilled-work";

/**
 * THE REVISION FAMILY IS BILLED ONCE (0391; audit v1085). A revision's lines carry NEW ids, so the
 * claims on the lines it replaces never carry to it: billing a revision whole beside an invoice cut
 * from what it replaced bills the work twice. The guard walks EVERY estimate this one revises (the
 * chain, bounded) and refuses when any of them is billed — by an invoice cut from it (quote_id), or
 * by an invoice on the job holding its lines (From Estimate: quote_id null, the claim is per line in
 * source_ids / import_key "quote:<line id>"). A read that fails REFUSES (fail closed: a bill is the
 * one thing that must not be guessed). `exceptInvoiceId` leaves the invoice being worked on out.
 * Returns the refusal, or null.
 */
/** The claims reader, injectable so the rule is tested without PostgREST's overlaps/embeds. */
export type ClaimsReader = (
  supabase: SupabaseClient,
  jobId: string | null,
  exceptInvoiceId: string | null,
  candidateIds: Iterable<string>,
) => Promise<{ owner: Map<string, { id: string; invoice_number: string | null }> }>;

export async function revisedOriginalBilled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  quote: { revises_quote_id?: string | null; job_id?: string | null },
  exceptInvoiceId?: string,
  deps: { claims: ClaimsReader } = { claims: (sb, jobId, except, ids) => claimedSourcesOnJob(sb, jobId, except, ids) },
): Promise<string | null> {
  if (!quote.revises_quote_id) return null;
  // The chain upward (a cycle or a gap ends it).
  const ancestors: Array<{ id: string; quote_number: string | null }> = [];
  const seen = new Set<string>();
  let cur: string | null = quote.revises_quote_id;
  for (let hop = 0; cur && !seen.has(cur) && hop < 12; hop++) {
    seen.add(cur);
    const { data, error } = await supabase.from("quotes").select("id, quote_number, revises_quote_id").eq("id", cur).maybeSingle();
    if (error) return `Whether the estimate this revises is billed could not be read (${dbError(error)}) — try again.`;
    const row = data as { id: string; quote_number: string | null; revises_quote_id: string | null } | null;
    if (!row) break;
    ancestors.push({ id: row.id, quote_number: row.quote_number });
    cur = row.revises_quote_id ?? null;
  }
  if (!ancestors.length) return null;
  const ids = ancestors.map((a) => a.id);
  const number = (id: string) => ancestors.find((a) => a.id === id)?.quote_number ?? "The estimate this revises";
  const refusal = (quoteId: string, invoiceNumber: string | null) =>
    `${number(quoteId)} is already billed on ${invoiceNumber ?? "an invoice"} — add the change to that invoice instead.`;

  // (a) An invoice cut from one of them.
  const { data: byQuote, error: qErr } = await supabase.from("invoices").select("id, invoice_number, quote_id").in("quote_id", ids).neq("status", "void");
  if (qErr) return `Whether the estimate this revises is billed could not be read (${dbError(qErr)}) — try again.`;
  const hit = ((byQuote ?? []) as Array<{ id: string; invoice_number: string | null; quote_id: string }>).find((r) => r.id !== exceptInvoiceId);
  if (hit) return refusal(hit.quote_id, hit.invoice_number);

  // (b) An invoice holding one of their LINES (From Estimate: quote_id null, the claim is per line in
  // source_ids / import_key). THE canonical reader (unbilled-work claimedSourcesOnJob): by id across
  // the company (an invoice that moved jobs still counts), chunked past the row cap, the job's own
  // invoices too when the revision has a job. A revision born before the original had a job (job_id
  // null) is covered by the by-id read. A throw is a refusal (fail closed).
  const { data: lines, error: lErr } = await supabase.from("quote_line_items").select("id, quote_id").in("quote_id", ids);
  if (lErr) return `Whether the estimate this revises is billed could not be read (${dbError(lErr)}) — try again.`;
  const lineQuote = new Map(((lines ?? []) as Array<{ id: string; quote_id: string }>).map((l) => [String(l.id), l.quote_id]));
  if (!lineQuote.size) return null;
  try {
    const claims = await deps.claims(supabase, quote.job_id ?? null, exceptInvoiceId ?? null, lineQuote.keys());
    for (const [lineId, quoteId] of lineQuote) {
      const inv = claims.owner.get(lineId);
      if (inv && inv.id !== exceptInvoiceId) return refusal(quoteId, inv.invoice_number ?? null);
    }
  } catch (e) {
    return `Whether the estimate this revises is billed could not be read (${e instanceof Error ? e.message : String(e)}) — try again.`;
  }
  return null;
}

