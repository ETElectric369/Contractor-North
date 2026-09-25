"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
import { WORK_ORDER_STATUSES } from "@/lib/statuses";
import { localToInstant, orgTimezone } from "@/lib/org-local-time";

export type Result = { ok: boolean; error?: string; id?: string };

/** "Scheduled for" as the instant to store. The form's datetime-local posts a NAIVE
 *  "2026-09-25T10:00" and `new Date()` on the server read it as UTC, so a 10 AM work order was
 *  stored for 3 AM Pacific (the same bug as Nort's appointments, 2026-09-24). Naive = the org's
 *  wall clock; an explicit offset is kept; blank clears; junk is an error, not a RangeError 500. */
async function scheduledInstant(
  supabase: Parameters<typeof orgTimezone>[0],
  raw: FormDataEntryValue | null,
): Promise<{ iso: string | null } | { error: string }> {
  const v = String(raw ?? "").trim();
  if (!v) return { iso: null };
  const r = localToInstant(v, await orgTimezone(supabase));
  return "error" in r ? { error: r.error } : { iso: r.iso };
}

export async function createWorkOrder(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  const jobId = emptyToNull(formData.get("job_id"));
  const sched = await scheduledInstant(supabase, formData.get("scheduled_for"));
  if ("error" in sched) return { ok: false, error: sched.error };

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
      scheduled_for: sched.iso,
      created_by: userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/work-orders");
  return { ok: true, id: data.id };
}

/** Generate a work order straight from a quote: the scope/description is built
 *  from the quote's line items (quantity + description, no prices — a WO is the
 *  field crew's instruction sheet, not a price sheet). Inherits job + customer. */
export async function createWorkOrderFromQuote(quoteId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

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
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  revalidatePath("/work-orders");
  if (quote.job_id) revalidatePath(`/jobs/${quote.job_id}`);
  return { ok: true, id: data.id };
}

/** Edit a work order's core fields; customer follows the linked job.
 *  PATCH semantics: only the fields present in the FormData are written — an absent key
 *  never touches its column (it used to null the description/assignee/schedule on any
 *  partial edit). The edit form submits every field, so the UI is unchanged. */
export async function updateWorkOrder(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase } = ctx;
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
    const sched = await scheduledInstant(supabase, formData.get("scheduled_for"));
    if ("error" in sched) return { ok: false, error: sched.error };
    clean.scheduled_for = sched.iso;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };

  // THE SILENT-WRITE LAW: a zero-row UPDATE is a 204, so ask for the id back.
  const { data: wrote, error } = await supabase.from("work_orders").update(clean).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "Nothing was saved. That work order may have been removed, so reload the page." };

  revalidatePath("/work-orders");
  revalidatePath(`/work-orders/${id}`);
  return { ok: true };
}

export async function deleteWorkOrder(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.from("work_orders").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/work-orders");
  return { ok: true };
}

export async function setWorkOrderStatus(
  id: string,
  status: string,
): Promise<Result> {
  if (!(WORK_ORDER_STATUSES as readonly string[]).includes(status))
    return { ok: false, error: `Status must be one of: ${WORK_ORDER_STATUSES.join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase
    .from("work_orders")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/work-orders");
  revalidatePath(`/work-orders/${id}`);
  return { ok: true };
}

