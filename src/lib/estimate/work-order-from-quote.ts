import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";

/**
 * THE WORK ORDER AN ACCEPTED ESTIMATE BECOMES — one rule, called by two doors (W3, cn-v1075).
 *
 * It lived in work-orders/actions.ts as createWorkOrderFromQuote behind requireStaff, so the
 * customer's own Accept link made a job with no work order. The body is here, taking the client it
 * is given: the staff door hands it the user's client; finishPublicAcceptance hands it the service
 * client with the company's id (number_work_orders stamps org_id from the JWT, and a service-role
 * write has none, so it is sent).
 *
 * The scope/description is built from the quote's line items (quantity + description, no prices —
 * a WO is the field crew's instruction sheet, not a price sheet). Inherits job + customer.
 * Idempotent: one work order per quote — re-running opens the existing one.
 */
export interface WorkOrderWho {
  quoteId: string;
  userId: string | null;
  orgId: string | null;
}

export type WorkOrderResult = { ok: boolean; error?: string; id?: string; jobId?: string | null };

export async function workOrderFromQuote(supabase: SupabaseClient, who: WorkOrderWho): Promise<WorkOrderResult> {
  const { quoteId, orgId } = who;
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, quote_number, title, job_id, customer_id, notes")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr) return { ok: false, error: qErr.message };
  if (!quote) return { ok: false, error: "Quote not found." };

  const { data: existing } = await supabase
    .from("work_orders")
    .select("id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, id: existing.id, jobId: quote.job_id ?? null };

  let linesQ = supabase.from("quote_line_items").select("description, quantity, unit, sort_order").eq("quote_id", quoteId);
  if (orgId) linesQ = linesQ.eq("org_id", orgId);
  const { data: items, error: iErr } = await linesQ.order("sort_order");
  if (iErr) return { ok: false, error: iErr.message };

  const scope = (items ?? [])
    .map((it: any) => `• ${Number(it.quantity) || 1} ${it.unit || "ea"} — ${it.description}`)
    .join("\n");
  const description = [
    `Scope from ${quote.quote_number}:`,
    scope || "(no line items)",
    quote.notes ? `\nNotes:\n${quote.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { data, error } = await supabase
    .from("work_orders")
    .insert({
      ...(orgId ? { org_id: orgId } : {}),
      title: quote.title?.trim() || `Work order for ${quote.quote_number}`,
      description,
      job_id: quote.job_id,
      customer_id: quote.customer_id,
      quote_id: quote.id,
      status: "draft",
      created_by: who.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  return { ok: true, id: data.id, jobId: quote.job_id ?? null };
}
