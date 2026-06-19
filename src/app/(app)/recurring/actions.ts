"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string; id?: string; count?: number };


/** Advance a yyyy-mm-dd date by one period of the given frequency. */
function advance(date: string, frequency: string): string {
  const d = new Date(`${date}T12:00:00`);
  switch (frequency) {
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function saveRecurring(formData: FormData, id?: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const kind = String(formData.get("kind") ?? "job");
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const nextDate = String(formData.get("next_date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return { ok: false, error: "Pick a next date." };

  const amountRaw = String(formData.get("amount") ?? "").trim();
  const row = {
    kind,
    title,
    frequency: String(formData.get("frequency") ?? "monthly"),
    next_date: nextDate,
    active: true,
    customer_id: kind === "job" ? emptyToNull(formData.get("customer_id")) : null,
    description: kind === "job" ? emptyToNull(formData.get("description")) : null,
    amount: kind === "expense" && amountRaw ? Number(amountRaw) : null,
    category: kind === "expense" ? emptyToNull(formData.get("category")) : null,
    vendor: kind === "expense" ? emptyToNull(formData.get("vendor")) : null,
  };

  if (id) {
    const { error } = await supabase.from("recurring_templates").update(row).eq("id", id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from("recurring_templates").insert({ ...row, created_by: user.id });
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/recurring");
  return { ok: true };
}

export async function setRecurringActive(id: string, active: boolean): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("recurring_templates").update({ active }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/recurring");
  return { ok: true };
}

export async function deleteRecurring(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("recurring_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/recurring");
  return { ok: true };
}

/** Create one occurrence from a template (a job or an expense bill) and advance
 *  its next_date. Used by the "Generate" buttons and generateDue(). */
async function runTemplate(supabase: any, t: any, userId: string): Promise<boolean> {
  if (t.kind === "job") {
    const start = new Date(`${t.next_date}T08:00:00`).toISOString();
    const { error } = await supabase.from("jobs").insert({
      name: t.title,
      customer_id: t.customer_id,
      description: t.description,
      status: "scheduled",
      scheduled_start: start,
      scheduled_end: new Date(`${t.next_date}T16:00:00`).toISOString(),
      created_by: userId,
    });
    if (error) return false;
  } else {
    const { error } = await supabase.from("bills").insert({
      job_id: null,
      supplier: t.vendor || t.title,
      amount: t.amount ?? 0,
      status: "unpaid",
      bill_date: t.next_date,
      category: t.category,
      notes: `Recurring expense: ${t.title}`,
      created_by: userId,
    });
    if (error) return false;
  }
  await supabase
    .from("recurring_templates")
    .update({ next_date: advance(t.next_date, t.frequency), last_generated_at: new Date().toISOString() })
    .eq("id", t.id);
  return true;
}

export async function generateOne(id: string): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: t } = await supabase.from("recurring_templates").select("*").eq("id", id).maybeSingle();
  if (!t) return { ok: false, error: "Template not found." };
  const ok = await runTemplate(supabase, t, user.id);
  if (!ok) return { ok: false, error: "Could not generate." };
  revalidatePath("/recurring");
  revalidatePath(t.kind === "job" ? "/jobs" : "/bills");
  return { ok: true };
}

/** Generate every active template that is due (next_date on or before today). */
export async function generateDue(): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const today = new Date().toISOString().slice(0, 10);
  const { data: due } = await supabase
    .from("recurring_templates")
    .select("*")
    .eq("active", true)
    .lte("next_date", today);
  let count = 0;
  for (const t of due ?? []) {
    // Catch up if a template is several periods overdue (cap to avoid runaways).
    let guard = 0;
    let cur = { ...t };
    while (cur.next_date <= today && guard++ < 24) {
      const ok = await runTemplate(supabase, cur, user.id);
      if (!ok) break;
      cur = { ...cur, next_date: advance(cur.next_date, cur.frequency) };
      count++;
    }
  }
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

  // H3/M6: at most one draft draw per job at a time — a second would over-bill.
  const { data: existingDraft } = await supabase.from("invoices").select("invoice_number")
    .eq("job_id", jobId).eq("status", "draft").in("invoice_kind", ["deposit", "progress", "final"]).limit(1).maybeSingle();
  if (existingDraft) {
    return { ok: false, error: `Draft ${(existingDraft as any).invoice_number} is still open on this job — send or delete it before creating another draw.` };
  }

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
    const pct = Math.max(0, Math.min(100, Number(input.value) || 0));
    if (estimate <= 0) return { ok: false, error: "Add a quote/estimate to bill a percentage — or bill a fixed amount." };
    amount = Math.round((remaining * pct) / 100 * 100) / 100;
    label = `${title} — ${pct}% of remaining estimate`;
  } else {
    amount = Math.round((Number(input.value) || 0) * 100) / 100;
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
  if (error) return { ok: false, error: error.message };

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
