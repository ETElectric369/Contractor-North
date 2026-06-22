"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendEmail, renderDocEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { pushInvoiceToQbo } from "@/lib/quickbooks";
import { getOrgSettings } from "@/lib/org-settings";
import { requireStaff } from "@/lib/staff-guard";
import { computeJobLaborBilling, fetchJobLaborRows } from "@/lib/labor-billing";
import { recalcTotals, resolveDrawCredit, shouldBlockStandardImport } from "@/lib/invoice-math";
import { standardBillingBlockerOnJob, standardBillingConflictError } from "@/lib/billing-guards";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { formatCurrency } from "@/lib/utils";
import { reportError } from "@/lib/observe";

/** Post a credit/refund to the customer's account from an invoice. disposition
 *  "credit" keeps it on their account; "refund" flags accounting to pay it back. */
export async function createCustomerCredit(
  invoiceId: string,
  amount: number,
  disposition: "credit" | "refund",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!(amount > 0)) return { ok: false, error: "Enter an amount." };

  // M2: bail if the invoice isn't visible to this org (cross-org id → null under
  // RLS) instead of inserting an orphan credit with customer_id:null.
  const { data: inv } = await supabase
    .from("invoices")
    .select("customer_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  const { error } = await supabase.from("customer_credits").insert({
    customer_id: inv.customer_id ?? null,
    invoice_id: invoiceId,
    amount,
    disposition,
    note: note?.trim() || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/billing/${invoiceId}`);
  if (inv?.customer_id) revalidatePath(`/crm/${inv.customer_id}`);
  return { ok: true };
}

export async function sendInvoiceToQuickbooks(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // was duplicated inline auth — use the one guard
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const res = await pushInvoiceToQbo(id);
  if (res.ok) revalidatePath(`/billing/${id}`);
  return { ok: res.ok, error: res.error };
}

function publicInvoiceLink(token: string) {
  return `${process.env.NEXT_PUBLIC_SITE_URL || ""}/i/${token}`;
}

export async function textInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_number, total, amount_paid, status, public_token, customers(name, phone)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const { data: org } = await supabase.from("organizations").select("name").maybeSingle();
  const balance = Number(invoice.total) - Number(invoice.amount_paid);
  const link = publicInvoiceLink((invoice as any).public_token);
  const body = `${org?.name ?? "Your contractor"}: Invoice ${invoice.invoice_number}, balance $${balance.toFixed(2)}. View/pay: ${link}`;

  const sent = await sendSms(customer.phone, body);
  if (!sent)
    return { ok: false, error: "Text not sent — add your Twilio account to enable SMS." };
  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
  }
  return { ok: true };
}

export async function emailInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, customers(name, email)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const customer = (invoice as any).customers;
  if (!customer?.email)
    return { ok: false, error: "This customer has no email address." };
  const link = publicInvoiceLink((invoice as any).public_token);

  const [{ data: items }, { data: org }] = await Promise.all([
    supabase.from("invoice_items").select("*").eq("invoice_id", id).order("sort_order"),
    supabase.from("organizations").select("name, brand_color, phone, email").maybeSingle(),
  ]);

  // Never email an empty invoice — e.g. a job finished with nothing billable would
  // otherwise send the customer a blank $0 invoice. Caught here so it protects every
  // caller (manual "Send" and the auto-invoice-on-completion path alike).
  if (!items || items.length === 0)
    return { ok: false, error: "This invoice has no line items to send." };

  const balance = Number(invoice.total) - Number(invoice.amount_paid);
  const html = renderDocEmail({
    docType: "Invoice",
    number: invoice.invoice_number,
    company: {
      name: org?.name ?? "Contractor North",
      brand: org?.brand_color ?? "#0b57c4",
      phone: org?.phone,
      email: org?.email,
    },
    customerName: customer.name,
    title: invoice.title,
    items: (items ?? []).map((i: any) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      price: i.unit_price,
      total: i.line_total,
    })),
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    balance,
    notes: invoice.notes,
    link,
  });

  const res = await sendEmail({
    to: customer.email,
    subject: `Invoice ${invoice.invoice_number} from ${org?.name ?? "us"}`,
    html,
    replyTo: org?.email ?? undefined,
  });
  if (!res.ok) return res;

  if (invoice.status === "draft") {
    await supabase.from("invoices").update({ status: "sent" }).eq("id", id);
  }
  revalidatePath(`/billing/${id}`);
  return { ok: true };
}

export type Result = { ok: boolean; error?: string; id?: string };

/** Convert an accepted (or any) quote into a draft invoice, copying line items. */
export async function createInvoiceFromQuote(quoteId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr || !quote) return { ok: false, error: "Quote not found." };

  // Idempotent: a quote maps to one invoice. Re-tapping "Create invoice" returns
  // the existing one instead of billing the customer twice.
  const { data: existingInv } = await supabase
    .from("invoices")
    .select("id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existingInv) return { ok: true, id: existingInv.id };

  // H4: a job already on the draw path can't also be billed by a standard invoice
  // carrying the full quoted amount (no import step would ever credit the draws).
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, quote.job_id);
  if (drawBlock) return drawBlock;

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: quote.customer_id,
      job_id: quote.job_id,
      quote_id: quote.id,
      title: quote.title,
      notes: quote.notes,
      tax_rate: quote.tax_rate,
      subtotal: quote.subtotal,
      tax: quote.tax,
      total: quote.total,
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, unit_price, sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order");

  if (items?.length) {
    await supabase.from("invoice_items").insert(
      items.map((it: any) => ({
        invoice_id: invoice.id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        sort_order: it.sort_order,
      })),
    );
  }

  revalidatePath("/billing");
  return { ok: true, id: invoice.id };
}

export async function createBlankInvoice(input: {
  customer_id: string | null;
  job_id?: string | null;
  title: string;
  tax_rate: number;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // H4: a job already on the draw path is billed by draws, not a standard invoice.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, input.job_id);
  if (drawBlock) return drawBlock;

  // If a job is chosen, inherit its customer (and a title) so the invoice is
  // never orphaned from the job it belongs to — this is what makes the payment
  // show up on the job's revenue/costs.
  let customerId = input.customer_id;
  let title = input.title;
  if (input.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, job_number")
      .eq("id", input.job_id)
      .single();
    if (job) {
      if (!customerId) customerId = job.customer_id ?? null;
      if (!title) title = job.name || job.job_number || "";
    }
  }

  const { data, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: input.job_id || null,
      title: title || null,
      tax_rate: input.tax_rate || 0,
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/billing");
  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true, id: data.id };
}

export async function addInvoiceItem(
  invoiceId: string,
  item: { description: string; quantity: number; unit: string; unit_price: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (Math.abs((item.quantity || 1) * (item.unit_price || 0)) > 9_999_999_999)
    return { ok: false, error: "That amount is too large." };
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.job_id) {
    const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
    if (conflict) return conflict; // H4: can't add billable lines to a standard invoice on a draw job
  }
  const { error } = await supabase.from("invoice_items").insert({
    invoice_id: invoiceId,
    description: item.description,
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_price: item.unit_price || 0,
  });
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** Next sort_order after the invoice's current items. */
async function nextSortOrder(supabase: any, invoiceId: string): Promise<number> {
  const { data } = await supabase
    .from("invoice_items")
    .select("sort_order")
    .eq("invoice_id", invoiceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sort_order ?? -1) + 1;
}

/** Replace this invoice's previously-imported rows for a given source with a
 *  fresh set, so re-importing REFRESHES the lines (current total) instead of
 *  duplicating them. Inserts the new rows before deleting the old ones, so a
 *  failed insert can't wipe them. Hand-entered rows (import_source null) are
 *  never touched. */
async function replaceImportedItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  source: string,
  rows: Array<{ description: string; quantity: number; unit: string; unit_price: number }>,
): Promise<{ error?: string }> {
  const { data: old } = await supabase
    .from("invoice_items")
    .select("id")
    .eq("invoice_id", invoiceId)
    .eq("import_source", source);
  const oldIds = ((old ?? []) as { id: string }[]).map((r) => r.id);
  let sort = await nextSortOrder(supabase, invoiceId);
  const { error } = await supabase.from("invoice_items").insert(
    rows.map((r) => ({ invoice_id: invoiceId, import_source: source, sort_order: sort++, ...r })),
  );
  if (error) return { error: error.message };
  if (oldIds.length) {
    // Insert-then-delete (so a failed insert can't wipe the old lines). But if THIS
    // delete fails, the old + new lines both remain — a double-billed import. Report
    // it so the duplicate is caught instead of silently inflating the invoice.
    const { error: delErr } = await supabase.from("invoice_items").delete().in("id", oldIds);
    if (delErr) reportError("replaceImportedItems-delete", delErr, { invoiceId, source });
  }
  return {};
}

/** Import the linked job's quote line items into this invoice (idempotent). */
export async function importQuoteItemsIntoInvoice(invoiceId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, quote_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.job_id) {
    const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
    if (conflict) return conflict; // H4: don't re-bill quoted scope onto a standard invoice on a draw job
  }

  let quoteId = inv.quote_id;
  if (!quoteId && inv.job_id) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id")
      .eq("job_id", inv.job_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    quoteId = q?.id ?? null;
  }
  if (!quoteId) return { ok: false, error: "No quote found on this invoice's job." };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("description, quantity, unit, unit_price")
    .eq("quote_id", quoteId)
    .order("sort_order");
  if (!items?.length) return { ok: false, error: "The quote has no line items." };

  const rep = await replaceImportedItems(
    supabase,
    invoiceId,
    "quote",
    items.map((it: any) => ({
      description: it.description,
      quantity: Number(it.quantity),
      unit: it.unit,
      unit_price: Number(it.unit_price),
    })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

// ── H4: one billing path per job ────────────────────────────────────────────
// A job billed via progress draws (deposit/progress/final) must NOT also be billed
// on a standard invoice — that double-bills the work the draws already cover. The
// guard lives at every chokepoint that puts billable content on a standard invoice
// (import labor/materials/quote-items, manual line add, create-from-quote/blank), so
// no single door is left open. A draw invoice itself is never blocked: it IS the path.

/** The job's active draw (deposit/progress/final, non-void) if any — the signal that
 *  the job is on the draw path. Excludes `excludeInvoiceId` (the invoice being acted
 *  on, so a draw never blocks itself). Returns the row (id/status/invoice_number). */
async function activeDrawOnJob(supabase: any, jobId: string, excludeInvoiceId?: string): Promise<any | null> {
  let q = supabase
    .from("invoices")
    .select("id, status, invoice_number")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", ["deposit", "progress", "final"])
    .limit(1);
  if (excludeInvoiceId) q = q.neq("id", excludeInvoiceId);
  const { data } = await q;
  return data && data.length ? data[0] : null;
}

/** The H4 block message, pointing at the correct next action: a DRAFT draw must be
 *  sent/deleted (a 2nd draft is itself blocked, so "add a draw" would be a dead-end);
 *  a sent draw means the user should add a draw rather than bill standard. */
function drawConflictError(draw: any): Result {
  if (draw && draw.status === "draft") {
    const label = draw.invoice_number ? `Draft ${draw.invoice_number}` : "A draft draw";
    return {
      ok: false,
      error: `${label} is still open on this job — send or delete that draw instead of billing on a standard invoice.`,
    };
  }
  return {
    ok: false,
    error: "This job is billed with progress draws — add a progress/final draw instead of billing on a standard invoice.",
  };
}

/** Guard the IMPORT / ADD-content paths: block when the target is a STANDARD invoice
 *  on a job that already has an active draw. Returns an error Result, else null. */
async function standardInvoiceOnDrawJob(supabase: any, inv: any, invoiceId: string): Promise<Result | null> {
  if ((inv?.invoice_kind ?? "standard") !== "standard") return null;
  const draw = await activeDrawOnJob(supabase, inv.job_id, invoiceId);
  return shouldBlockStandardImport(inv?.invoice_kind, !!draw) ? drawConflictError(draw) : null;
}

/** Guard standard-invoice CREATION for a job: block making a new standard invoice for
 *  a job already on the draw path (createInvoiceFromQuote embeds the full quoted amount
 *  at creation, so the content guards never see it). Returns an error Result, else null. */
async function blockStandardCreateOnDrawJob(supabase: any, jobId: string | null | undefined): Promise<Result | null> {
  if (!jobId) return null;
  const draw = await activeDrawOnJob(supabase, jobId);
  return draw ? drawConflictError(draw) : null;
}

/** Import labor from the job's closed time entries: one line per person,
 *  hours × their hourly rate (falls back to the org default labor rate). */

export async function importLaborIntoInvoice(invoiceId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;

  // Bill the EXACT time on this job via the shared labor-billing helper (so the
  // billed lines reconcile to the penny with the progress-report "work to date").
  const [labor, { data: org }] = await Promise.all([
    fetchJobLaborRows(supabase, inv.job_id),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const defaultRate = Number(((org as any)?.settings ?? {}).default_labor_rate ?? 0);
  const { lines } = computeJobLaborBilling(labor.jobEntries, labor.jobAllocs, defaultRate);
  if (lines.length === 0) return { ok: false, error: "No billable hours on this job yet." };

  const rep = await replaceImportedItems(
    supabase,
    invoiceId,
    "labor",
    lines.map((l) => ({
      description: `Labor — ${l.name}`,
      quantity: l.quantity,
      unit: "hr",
      unit_price: l.rate,
    })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** Import materials from the job's costs: purchase orders + supplier bills,
 *  marked up by `markupPercent` (so they bill at sell price, not cost — the
 *  contractor doesn't do the math by hand). Each line stays editable after. */
export async function importCostsIntoInvoice(invoiceId: string, markupPercent = 0): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;

  const [{ data: pos }, { data: bills }] = await Promise.all([
    supabase.from("purchase_orders").select("po_number, vendor, total").eq("job_id", inv.job_id),
    supabase.from("bills").select("supplier, bill_number, amount").eq("job_id", inv.job_id),
  ]);

  // Mark up cost → sell price. Markup is NOT shown on the line (customers don't
  // see your margin); only the price reflects it.
  const mark = (cost: number) => Math.round(cost * (1 + (Number(markupPercent) || 0) / 100) * 100) / 100;
  const rows: { description: string; unit_price: number }[] = [];
  for (const p of pos ?? []) {
    if (Number(p.total) > 0) rows.push({ description: `Materials — ${p.vendor} (PO ${p.po_number})`, unit_price: mark(Number(p.total)) });
  }
  for (const b of bills ?? []) {
    if (Number(b.amount) > 0)
      rows.push({ description: `Materials — ${b.supplier}${b.bill_number ? ` (bill #${b.bill_number})` : ""}`, unit_price: mark(Number(b.amount)) });
  }
  if (!rows.length) return { ok: false, error: "No purchase orders or bills on this job yet." };

  const rep = await replaceImportedItems(
    supabase,
    invoiceId,
    "costs",
    rows.map((r) => ({ description: r.description, quantity: 1, unit: "lot", unit_price: r.unit_price })),
  );
  if (rep.error) return { ok: false, error: rep.error };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** Create a progress/final DRAW that doubles as a progress report: itemizes all
 *  actual labor (at bill rate) + materials (with markup) to date, then credits
 *  prior billings (deposit + earlier draws) so the balance due is just the new
 *  work since the last bill — the standard cumulative (AIA-style) progress format.
 *  The single invoice shows the customer the running tally AND the amount owed. */
export async function createProgressReportInvoice(
  jobId: string,
  kind: "progress" | "final",
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const [{ data: job }, { data: org }, { data: existingDraft }] = await Promise.all([
    supabase.from("jobs").select("customer_id, name").eq("id", jobId).maybeSingle(),
    supabase.from("organizations").select("settings").maybeSingle(),
    supabase.from("invoices").select("invoice_number").eq("job_id", jobId).eq("status", "draft")
      .in("invoice_kind", ["deposit", "progress", "final"]).limit(1).maybeSingle(),
  ]);
  if (!job) return { ok: false, error: "Job not found." };
  // H3/M6: at most one draft draw per job — a second would re-import and re-bill
  // the whole job, double-charging once both are sent.
  if (existingDraft) {
    return { ok: false, error: `Draft ${(existingDraft as any).invoice_number} is still open on this job — send or delete it before creating another draw.` };
  }
  // H4 (reverse): if a standard invoice already bills this job's labor/materials, a
  // draw here would re-import and double-bill the same work. Block before creating it.
  const stdBlocker = await standardBillingBlockerOnJob(supabase, jobId);
  if (stdBlocker) return standardBillingConflictError(stdBlocker);
  const markup = getOrgSettings((org as any)?.settings).material_markup_percent;

  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: job.customer_id,
      job_id: jobId,
      status: "draft",
      title: kind === "final" ? "Final invoice" : "Progress payment",
      invoice_kind: kind,
      tax_rate: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  // Itemize the actual work to date (labor at bill rate + materials with markup).
  await importLaborIntoInvoice(inv.id);
  await importCostsIntoInvoice(inv.id, markup);

  const { data: afterImport } = await supabase.from("invoices").select("total").eq("id", inv.id).maybeSingle();
  const importedTotal = Number(afterImport?.total ?? 0);

  // Prior billings actually SENT to the customer (deposit + earlier sent draws;
  // drafts and void excluded) so they only pay for work since the last bill.
  const { data: priorInvs } = await supabase
    .from("invoices")
    .select("total, status")
    .eq("job_id", jobId)
    .neq("id", inv.id);
  const priorBilled = (priorInvs ?? []).reduce(
    (s: number, i: any) => (i.status !== "void" && i.status !== "draft" ? s + Number(i.total ?? 0) : s),
    0,
  );

  // H1: a draw must never go negative. The pure, unit-tested resolveDrawCredit
  // decides whether to bail (nothing logged / prior billings already cover it) or
  // how much to credit (floored so the balance never drops below $0).
  const decision = resolveDrawCredit(importedTotal, priorBilled);
  if (!decision.ok) {
    await supabase.from("invoices").delete().eq("id", inv.id);
    return {
      ok: false,
      error:
        decision.reason === "no-work"
          ? "No labor or materials are logged on this job yet to bill."
          : "Prior billings already cover the work logged so far — nothing new to bill yet.",
    };
  }
  if (decision.credit > 0.005) {
    // Stamp it import_source:"draw_credit" so it's tamper-evident — deleting/editing
    // this negative line would wipe the prior-billings offset and re-bill the deposit,
    // so updateInvoiceItem/deleteInvoiceItem refuse to touch it. (org_id via trigger.)
    await supabase.from("invoice_items").insert({
      invoice_id: inv.id,
      description: "Less previous billings (deposit & prior draws)",
      quantity: 1,
      unit: "lot",
      unit_price: -decision.credit,
      import_source: "draw_credit",
    });
    await recalcInvoice(supabase, inv.id);
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/billing");
  return { ok: true, id: inv.id };
}

export async function updateInvoiceItem(
  itemId: string,
  invoiceId: string,
  item: { description: string; quantity: number; unit_price: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!item.description.trim()) return { ok: false, error: "Description is required." };
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED;
  const { error } = await supabase
    .from("invoice_items")
    .update({
      description: item.description.trim(),
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
    })
    .eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

export async function deleteInvoiceItem(
  itemId: string,
  invoiceId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED;
  const { error } = await supabase.from("invoice_items").delete().eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** The auto-calculated "less previous billings" draw credit is tamper-evident: it
 *  carries import_source:"draw_credit". Editing or deleting it would wipe the
 *  prior-billings offset and re-bill the customer for the deposit + earlier draws,
 *  so the item mutations refuse it. */
const CREDIT_LINE_LOCKED: Result = {
  ok: false,
  error:
    "That's the automatic “less previous billings” credit — it can't be edited or deleted, since it's what keeps this draw from re-billing the deposit and prior draws.",
};
async function isProtectedCreditLine(supabase: any, itemId: string): Promise<boolean> {
  const { data } = await supabase.from("invoice_items").select("import_source").eq("id", itemId).maybeSingle();
  return data?.import_source === "draw_credit";
}

export async function setInvoiceStatus(
  id: string,
  status: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("invoices").update({ status }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/billing");
  revalidatePath(`/billing/${id}`);
  return { ok: true };
}

/** A "YYYY-MM-DD" date → an ISO timestamp at local noon (stable across tz). */
function dateToIso(d?: string | null): string | undefined {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = new Date(`${d}T12:00:00`);
  return isNaN(t.getTime()) ? undefined : t.toISOString();
}

export async function recordPayment(input: {
  invoice_id: string;
  amount: number;
  method: string;
  note: string;
  paid_at?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a payment amount." };
  if (input.amount > 9_999_999) return { ok: false, error: "That amount is too large." };

  // M2: confirm the invoice is visible to this org (a cross-org id returns null
  // under the org-scoped read policy) before recording a payment against it.
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, org_id, invoice_number, customers(name)")
    .eq("id", input.invoice_id)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  const paidAt = dateToIso(input.paid_at);
  const { error } = await supabase.from("payments").insert({
    invoice_id: input.invoice_id,
    amount: input.amount,
    method: input.method || "check",
    note: input.note || null,
    recorded_by: ctx.userId,
    ...(paidAt ? { paid_at: paidAt } : {}),
  });
  if (error) return { ok: false, error: error.message };

  await recalcInvoice(supabase, input.invoice_id);
  // Cash-in ping to the OTHER office staff (the recorder already knows).
  const cust = (inv as any).customers?.name as string | undefined;
  void sendPushToProfiles(
    (await orgStaffIds(inv.org_id)).filter((id) => id !== ctx.userId),
    "invoice_paid",
    {
      title: "Payment recorded",
      body: `${formatCurrency(input.amount)} on ${inv.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}`,
      url: `/billing/${input.invoice_id}`,
    },
  );
  revalidatePath(`/billing/${input.invoice_id}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Edit a recorded payment (amount / method / note) and recompute the invoice. */
export async function updatePayment(
  paymentId: string,
  invoiceId: string,
  patch: { amount: number; method: string; note: string; paid_at?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!patch.amount || patch.amount <= 0) return { ok: false, error: "Enter a payment amount." };
  if (patch.amount > 9_999_999) return { ok: false, error: "That amount is too large." };
  const paidAt = dateToIso(patch.paid_at);
  const { error } = await supabase
    .from("payments")
    .update({
      amount: patch.amount,
      method: patch.method || "check",
      note: patch.note || null,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Remove a recorded payment (typo'd entry etc.) and recompute the invoice. */
export async function deletePayment(paymentId: string, invoiceId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("payments").delete().eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/billing");
  return { ok: true };
}

/** Delete an invoice — only while no payments are recorded against it
 *  (paid history must stay; void those instead). */
export async function deleteInvoice(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { count } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", id);
  if (count && count > 0) {
    return { ok: false, error: "This invoice has recorded payments — delete those first or mark the invoice void." };
  }
  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/billing");
  return { ok: true };
}

/** Set the invoice tax rate (percent in → stored as decimal) and recompute. */
export async function setInvoiceTaxRate(
  invoiceId: string,
  ratePercent: number,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
  const { error } = await supabase.from("invoices").update({ tax_rate: rate }).eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  await recalcInvoice(supabase, invoiceId);
  revalidatePath(`/billing/${invoiceId}`);
  return { ok: true };
}

/** Recompute totals from items + payments, and auto-advance paid status. */
async function recalcInvoice(supabase: any, invoiceId: string) {
  const [{ data: items }, { data: pays }, { data: inv }] = await Promise.all([
    supabase.from("invoice_items").select("line_total").eq("invoice_id", invoiceId),
    supabase.from("payments").select("amount").eq("invoice_id", invoiceId),
    supabase.from("invoices").select("tax_rate, status").eq("id", invoiceId).single(),
  ]);

  const { subtotal, tax, total, amountPaid, status } = recalcTotals(
    (items ?? []).map((i: any) => Number(i.line_total ?? 0)),
    (pays ?? []).map((p: any) => Number(p.amount ?? 0)),
    Number(inv?.tax_rate ?? 0),
    inv?.status ?? "draft",
  );

  const { error } = await supabase
    .from("invoices")
    .update({ subtotal, tax, total, amount_paid: amountPaid, status })
    .eq("id", invoiceId);
  // If this silently fails the invoice shows stale totals/status (wrong balance,
  // wrong paid state) — surface it rather than letting the money figures drift.
  if (error) reportError("recalcInvoice", error, { invoiceId });
}
