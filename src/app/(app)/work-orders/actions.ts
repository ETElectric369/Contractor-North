"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string; id?: string };

export async function createWorkOrder(formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  const jobId = emptyToNull(formData.get("job_id"));
  const scheduled = String(formData.get("scheduled_for") ?? "");

  // Inherit the customer from the chosen job, if any.
  let customerId: string | null = null;
  if (jobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id")
      .eq("id", jobId)
      .maybeSingle();
    customerId = job?.customer_id ?? null;
  }

  const { data, error } = await supabase
    .from("work_orders")
    .insert({
      title,
      description: emptyToNull(formData.get("description")),
      job_id: jobId,
      customer_id: customerId,
      status: String(formData.get("status") ?? "draft"),
      assigned_to: emptyToNull(formData.get("assigned_to")),
      scheduled_for: scheduled ? new Date(scheduled).toISOString() : null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/work-orders");
  return { ok: true, id: data.id };
}

/** Generate a work order straight from a quote: the scope/description is built
 *  from the quote's line items (quantity + description, no prices — a WO is the
 *  field crew's instruction sheet, not a price sheet). Inherits job + customer. */
export async function createWorkOrderFromQuote(quoteId: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, quote_number, title, job_id, customer_id, notes")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr) return { ok: false, error: qErr.message };
  if (!quote) return { ok: false, error: "Quote not found." };

  // Idempotent: one work order per quote — re-running opens the existing one
  // instead of minting a duplicate WO (mirrors createInvoiceFromQuote).
  const { data: existing } = await supabase
    .from("work_orders")
    .select("id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, id: existing.id };

  const { data: items, error: iErr } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order");
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
      title: quote.title?.trim() || `Work order for ${quote.quote_number}`,
      description,
      job_id: quote.job_id,
      customer_id: quote.customer_id,
      quote_id: quote.id,
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/work-orders");
  if (quote.job_id) revalidatePath(`/jobs/${quote.job_id}`);
  return { ok: true, id: data.id };
}

/** Edit a work order's core fields; customer follows the linked job.
 *  PATCH semantics: only the fields present in the FormData are written — an absent key
 *  never touches its column (it used to null the description/assignee/schedule on any
 *  partial edit). The edit form submits every field, so the UI is unchanged. */
export async function updateWorkOrder(id: string, formData: FormData): Promise<Result> {
  const supabase = await createClient();
  const clean: Record<string, unknown> = {};

  if (formData.has("title")) {
    const title = String(formData.get("title") ?? "").trim();
    if (!title) return { ok: false, error: "Title is required." };
    clean.title = title;
  }
  if (formData.has("description")) clean.description = emptyToNull(formData.get("description"));
  if (formData.has("job_id")) {
    const jobId = emptyToNull(formData.get("job_id"));
    let customerId: string | null = null;
    if (jobId) {
      const { data: job } = await supabase
        .from("jobs")
        .select("customer_id")
        .eq("id", jobId)
        .maybeSingle();
      customerId = job?.customer_id ?? null;
    }
    clean.job_id = jobId;
    clean.customer_id = customerId; // customer follows the job (null job → no customer)
  }
  if (formData.has("assigned_to")) clean.assigned_to = emptyToNull(formData.get("assigned_to"));
  if (formData.has("scheduled_for")) {
    const scheduled = String(formData.get("scheduled_for") ?? "");
    clean.scheduled_for = scheduled ? new Date(scheduled).toISOString() : null;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };

  const { error } = await supabase.from("work_orders").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/work-orders");
  revalidatePath(`/work-orders/${id}`);
  return { ok: true };
}

export async function deleteWorkOrder(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("work_orders").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work-orders");
  return { ok: true };
}

export async function setWorkOrderStatus(
  id: string,
  status: string,
): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("work_orders")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work-orders");
  revalidatePath(`/work-orders/${id}`);
  return { ok: true };
}

