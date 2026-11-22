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
 *
 * TWO EXPORTS, ONE READ (cn-v1168). findRevisedOriginalBilled is the read: WHICH estimate this one
 * revises is billed, and on which invoice (or that a read failed). revisedOriginalBilled is the billing
 * doors' refusal made from it, word for word what it was. Keep Both (quotes/actions keepBothEstimates)
 * reads the first: clearing a revision's pointer takes this guard off it, so that door says the
 * invoice by name before the person bills beside it.
 */
/** The claims reader, injectable so the rule is tested without PostgREST's overlaps/embeds. */
export type ClaimsReader = (
  supabase: SupabaseClient,
  jobId: string | null,
  exceptInvoiceId: string | null,
  candidateIds: Iterable<string>,
) => Promise<{ owner: Map<string, { id: string; invoice_number: string | null }> }>;

/** What the read found: the estimate (one this one revises) that is billed and the invoice that bills
 *  it, each by its number when it has one; or `unread`, a read that failed, with the database's words. */
export type RevisedBilled = { quoteNumber: string | null; invoiceNumber: string | null } | { unread: string };

export async function findRevisedOriginalBilled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  quote: { revises_quote_id?: string | null; job_id?: string | null },
  exceptInvoiceId?: string,
  deps: { claims: ClaimsReader } = { claims: (sb, jobId, except, ids) => claimedSourcesOnJob(sb, jobId, except, ids) },
): Promise<RevisedBilled | null> {
  if (!quote.revises_quote_id) return null;
  // The chain upward (a cycle or a gap ends it).
  const ancestors: Array<{ id: string; quote_number: string | null }> = [];
  const seen = new Set<string>();
  let cur: string | null = quote.revises_quote_id;
  for (let hop = 0; cur && !seen.has(cur) && hop < 12; hop++) {
    seen.add(cur);
    const { data, error } = await supabase.from("quotes").select("id, quote_number, revises_quote_id").eq("id", cur).maybeSingle();
    if (error) return { unread: dbError(error) };
    const row = data as { id: string; quote_number: string | null; revises_quote_id: string | null } | null;
    if (!row) break;
    ancestors.push({ id: row.id, quote_number: row.quote_number });
    cur = row.revises_quote_id ?? null;
  }
  if (!ancestors.length) return null;
  const ids = ancestors.map((a) => a.id);
  const billed = (quoteId: string, invoiceNumber: string | null): RevisedBilled => ({
    quoteNumber: ancestors.find((a) => a.id === quoteId)?.quote_number ?? null,
    invoiceNumber,
  });

  // (a) An invoice cut from one of them.
  // A deposit request (cn-v1177) names its estimate too, and bills none of its work: never "billed".
  const { data: byQuote, error: qErr } = await supabase.from("invoices").select("id, invoice_number, quote_id").in("quote_id", ids).neq("status", "void").neq("invoice_kind", "prepayment");
  if (qErr) return { unread: dbError(qErr) };
  const hit = ((byQuote ?? []) as Array<{ id: string; invoice_number: string | null; quote_id: string }>).find((r) => r.id !== exceptInvoiceId);
  if (hit) return billed(hit.quote_id, hit.invoice_number);

  // (b) An invoice holding one of their LINES (From Estimate: quote_id null, the claim is per line in
  // source_ids / import_key). THE canonical reader (unbilled-work claimedSourcesOnJob): by id across
  // the company (an invoice that moved jobs still counts), chunked past the row cap, the job's own
  // invoices too when the revision has a job. A revision born before the original had a job (job_id
  // null) is covered by the by-id read. A throw is a refusal (fail closed).
  const { data: lines, error: lErr } = await supabase.from("quote_line_items").select("id, quote_id").in("quote_id", ids);
  if (lErr) return { unread: dbError(lErr) };
  const lineQuote = new Map(((lines ?? []) as Array<{ id: string; quote_id: string }>).map((l) => [String(l.id), l.quote_id]));
  if (!lineQuote.size) return null;
  try {
    const claims = await deps.claims(supabase, quote.job_id ?? null, exceptInvoiceId ?? null, lineQuote.keys());
    for (const [lineId, quoteId] of lineQuote) {
      const inv = claims.owner.get(lineId);
      if (inv && inv.id !== exceptInvoiceId) return billed(quoteId, inv.invoice_number ?? null);
    }
  } catch (e) {
    return { unread: e instanceof Error ? e.message : String(e) };
  }
  return null;
}

/** THE BILLING DOORS' REFUSAL, from the read above: the sentence, or null. Word for word what it was. */
export async function revisedOriginalBilled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  quote: { revises_quote_id?: string | null; job_id?: string | null },
  exceptInvoiceId?: string,
  deps?: { claims: ClaimsReader },
): Promise<string | null> {
  const found = await findRevisedOriginalBilled(supabase, quote, exceptInvoiceId, deps);
  if (!found) return null;
  if ("unread" in found) return `Whether the estimate this revises is billed could not be read (${found.unread}) — try again.`;
  return `${found.quoteNumber ?? "The estimate this revises"} is already billed on ${found.invoiceNumber ?? "an invoice"} — add the change to that invoice instead.`;
}

