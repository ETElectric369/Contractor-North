"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { drawAmount } from "@/lib/invoice-math";
import { standardBillingBlockerOnJob, standardBillingConflictError } from "@/lib/billing-guards";
import { runTemplate, runInvoiceTemplate, generateDueTemplates } from "@/lib/recurring-engine";

export type Result = { ok: boolean; error?: string; id?: string; count?: number };

export async function saveRecurring(formData: FormData, id?: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const kind = String(formData.get("kind") ?? "job");
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const nextDate = String(formData.get("next_date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return { ok: false, error: "Pick a next date." };

  const amountRaw = String(formData.get("amount") ?? "").trim();
  const taxRaw = String(formData.get("tax_pct") ?? "").trim();
  const customerId = kind === "job" || kind === "invoice" ? emptyToNull(formData.get("customer_id")) : null;
  if (kind === "invoice") {
    if (!customerId) return { ok: false, error: "Pick a customer for the recurring invoice." };
    if (!amountRaw || !(Number(amountRaw) > 0)) return { ok: false, error: "Enter the invoice amount." };
  }
  // The customer must belong to the caller's org — the user client's RLS enforces it,
  // so a forged foreign customer_id resolves to nothing and is rejected.
  if (customerId) {
    const { data: cust } = await supabase.from("customers").select("id").eq("id", customerId).maybeSingle();
    if (!cust) return { ok: false, error: "That customer isn't in your account." };
  }
  const row = {
    kind,
    title,
    frequency: String(formData.get("frequency") ?? "monthly"),
    next_date: nextDate,
    active: true,
    customer_id: customerId,
    description: kind === "job" ? emptyToNull(formData.get("description")) : null,
    amount: (kind === "expense" || kind === "invoice") && amountRaw ? Number(amountRaw) : null,
    category: kind === "expense" ? emptyToNull(formData.get("category")) : null,
    vendor: kind === "expense" ? emptyToNull(formData.get("vendor")) : null,
    tax_rate: kind === "invoice" && taxRaw ? Math.max(0, Number(taxRaw)) / 100 : 0,
    auto_send: kind === "invoice" ? formData.get("auto_send") === "on" : false,
  };

  if (id) {
    const { error } = await supabase.from("recurring_templates").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from("recurring_templates").insert({ ...row, created_by: ctx.userId });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/recurring");
  return { ok: true };
}

export async function setRecurringActive(id: string, active: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("recurring_templates").update({ active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/recurring");
  return { ok: true };
}

export async function deleteRecurring(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("recurring_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/recurring");
  return { ok: true };
}

export async function generateOne(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: t } = await supabase.from("recurring_templates").select("*").eq("id", id).maybeSingle();
  if (!t) return { ok: false, error: "Template not found." };
  const today = new Date().toISOString().slice(0, 10);
  const ok =
    t.kind === "invoice"
      ? await runInvoiceTemplate(supabase, t, ctx.userId, today)
      : await runTemplate(supabase, t, ctx.userId);
  if (!ok) return { ok: false, error: t.kind === "invoice" ? "Already generated for this period." : "Could not generate." };
  revalidatePath("/recurring");
  revalidatePath(t.kind === "job" ? "/jobs" : t.kind === "invoice" ? "/billing" : "/bills");
  return { ok: true };
}

/** Generate every active template that is due (next_date on or before today). */
export async function generateDue(): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const count = await generateDueTemplates(supabase, ctx.userId);
  revalidatePath("/recurring");
  revalidatePath("/jobs");
  revalidatePath("/bills");
  return { ok: true, count };
}

/** Create a billing DRAW on a job — a deposit, progress payment or final invoice.
 *  Bills either a % of the REMAINING estimate (estimate minus what's already been
 *  invoiced) or a fixed $ amount, and tags the invoice with its draw kind so
 *  deposits / progress / final all flow through one path and never re-bill what's
 *  already invoiced. */
export async function createProgressInvoice(
  jobId: string,
  input: { kind?: "deposit" | "progress" | "final"; mode: "percent" | "fixed"; value: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const kind = input.kind ?? "progress";

  const { data: job } = await supabase.from("jobs").select("customer_id, name").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  // Mutual exclusion: a job billing on a payment schedule must draw via "Request next
  // payment" (the milestone path), not this %/fixed draw — else it double-bills.
  const { data: sched } = await supabase
    .from("payment_milestones").select("id").eq("job_id", jobId).limit(1).maybeSingle();
  if (sched)
    return { ok: false, error: "This job bills on a payment schedule — use “Request next payment” from the schedule instead." };

  // H3/M6: at most one draft draw per job at a time — a second would over-bill.
  const { data: existingDraft } = await supabase.from("invoices").select("invoice_number")
    .eq("job_id", jobId).eq("status", "draft").in("invoice_kind", ["deposit", "progress", "final"]).limit(1).maybeSingle();
  if (existingDraft) {
    return { ok: false, error: `Draft ${(existingDraft as any).invoice_number} is still open on this job — send or delete it before creating another draw.` };
  }

  // H4 (reverse): don't open a draw on a job that's already being billed on a standard
  // invoice carrying content — the draw would re-bill the same work (here, a % of the
  // estimate on top of the standard invoice's lines). Mirrors the forward import guard.
  const stdBlocker = await standardBillingBlockerOnJob(supabase, jobId);
  if (stdBlocker) return standardBillingConflictError(stdBlocker);

  // Estimate = quoted total; billed-to-date = the job's SENT invoices (non-void,
  // non-draft — a draft draw isn't a real bill; matches the job page + modal so
  // the "% of remaining" base can't diverge by an outstanding draft).
  const [{ data: quotes }, { data: invoices }] = await Promise.all([
    supabase.from("quotes").select("total").eq("job_id", jobId),
    supabase.from("invoices").select("total, status").eq("job_id", jobId),
  ]);
  const estimate = (quotes ?? []).reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  const billed = (invoices ?? []).reduce((s: number, i: any) => (i.status !== "void" && i.status !== "draft" ? s + Number(i.total ?? 0) : s), 0);
  const remaining = Math.max(0, estimate - billed);

  const titleFor: Record<string, string> = { deposit: "Deposit", progress: "Progress payment", final: "Final invoice" };
  const title = titleFor[kind] ?? "Progress payment";

  let amount: number;
  let label: string;
  if (input.mode === "percent") {
    if (estimate <= 0) return { ok: false, error: "Add a quote/estimate to bill a percentage — or bill a fixed amount." };
    const pct = Math.max(0, Math.min(100, Number(input.value) || 0));
    amount = drawAmount("percent", pct, remaining);
    label = `${title} — ${pct}% of remaining estimate`;
  } else {
    amount = drawAmount("fixed", Number(input.value) || 0, remaining);
    label = title;
  }
  if (!(amount > 0)) return { ok: false, error: "Enter an amount above $0." };
  if (amount > 9_999_999) return { ok: false, error: "That amount is too large." };

  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: job.customer_id,
      job_id: jobId,
      status: "draft",
      title,
      invoice_kind: kind,
      tax_rate: 0,
      subtotal: amount,
      tax: 0,
      total: amount,
    })
    .select("id")
    .single();
  if (error) {
    // Partial unique index (one open draft draw per job) backstops a double-submit race.
    if ((error as any).code === "23505")
      return { ok: false, error: "A draft draw is already open on this job — send or delete it before creating another." };
    return { ok: false, error: error.message };
  }

  const { error: liErr } = await supabase.from("invoice_items").insert({
    invoice_id: inv.id,
    description: label,
    quantity: 1,
    unit_price: amount,
    sort_order: 0,
  });
  if (liErr) return { ok: false, error: liErr.message };

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/billing");
  return { ok: true, id: inv.id };
}
